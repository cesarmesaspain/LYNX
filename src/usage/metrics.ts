/*
 * metrics.ts — Local, private product-value metrics.
 *
 * LYNX records only local JSONL events under ~/.lynx. No network, no
 * identifiers outside project/tool names, and best-effort writes.
 *
 * v2 improvements:
 * - Session-level dedup to prevent double-counting the same file
 * - Real file-size-based token estimation
 * - Semantic ROI: tokens_saved / semantic_cost_usd
 * - High/medium/low confidence refined with real file sizes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lynxHome } from '../config/runtime.js';
import { archiveEvent } from '../store/metrics-db.js';
import { LynxDatabase } from '../store/database.js';

export type UsageEventType =
  | 'pack_context'
  | 'architecture_overview'
  | 'search_graph'
  | 'trace_path'
  | 'llm_rerank'
  | 'hook_augment'
  | 'benchmark'
  | 'real_savings'
  /** A completed LYNX tool call with no tool-specific savings estimator. */
  | 'tool_observation';

export interface UsageEvent {
  ts: string;
  type: UsageEventType;
  project: string;
  query?: string;
  query_hash?: string;
  result_count?: number;
  unique_files?: number;
  files_avoided?: number;
  tokens_saved?: number;
  confidence?: 'low' | 'medium' | 'high';
  latency_ms?: number;
  llm_provider?: string;
  /** Concrete model used for the LLM call, when the provider reports it. */
  llm_model?: string;
  llm_latency_ms?: number;
  estimated_llm_cost_usd?: number;
  rank_changed?: boolean;
  top_changed?: boolean;
  tool_hint?: string;
  /** Files actually referenced (dedup key for session-level counting) */
  files?: string[];
  /** v3 fields — provenance and dedup */
  session_id?: string;
  task_id?: string;
  event_id?: string;
  deterministic_mode?: boolean;
  /** Keeps related estimators from deduplicating against unrelated tool flows. */
  dedup_scope?: string;
  /** Count a complete, independently useful operation even when it covers known files. */
  skip_session_dedup?: boolean;
}

export interface UsageSummary {
  events: number;
  tokens_saved: number;
  files_avoided: number;
  /** Unique files avoided this session (deduplicated across events) */
  unique_files_avoided: number;
  high_confidence_tokens_saved: number;
  medium_confidence_tokens_saved: number;
  low_confidence_tokens_saved: number;
  llm_events: number;
  llm_rank_changed: number;
  llm_top_changed: number;
  estimated_llm_cost_usd: number;
  llm_latency_ms: number;
  /** Tokens saved per $1 of semantic cost */
  semantic_roi: number | null;
  by_type: Record<string, number>;
  since: string | null;
  until: string | null;
}

const AVG_FILE_TOKENS = 900;
const MAX_QUERY_CHARS = 180;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RERANK_INPUT_TOKENS_PER_CANDIDATE = 90;
const RERANK_OUTPUT_TOKENS = 80;
const FLASH_COST_PER_1K_TOKENS_USD = 0.00014;
const RUNTIME_SESSION_ID = `runtime-${process.pid}-${Date.now().toString(36)}`;

/**
 * MCP does not expose a portable task identifier on every client. Keep a
 * stable local fallback per process and project so related tool calls can be
 * measured together without sending any identifier outside the machine.
 */
export function defaultUsageContext(project: string): { session_id: string; task_id: string } {
  const task = process.env.LYNX_TASK_ID || process.env.CODEX_THREAD_ID || `${RUNTIME_SESSION_ID}:${project || 'global'}`;
  return { session_id: RUNTIME_SESSION_ID, task_id: task };
}

// ── Session-level dedup ─────────────────────────────────────

const sessionFileSet = new Map<string, Set<string>>(); // project + scope -> files

/** Simple v4-like UUID generator (no crypto dependency). */
function generateEventId(): string {
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return hex() + hex() + '-' + hex() + '-4' + hex().slice(1) + '-' +
    ((8 + Math.random() * 4) | 0).toString(16) + hex() + '-' + hex() + hex() + hex();
}

export function clearSessionDedup(project?: string): void {
  if (project) {
    sessionFileSet.delete(project);
  } else {
    sessionFileSet.clear();
  }
}

function adjustEventForSessionDedup(event: Omit<UsageEvent, 'ts'>): Omit<UsageEvent, 'ts'> {
  const adjustedEvent = { ...event, files: event.files ? [...event.files] : event.files };
  if (!adjustedEvent.files || adjustedEvent.files.length === 0 || !adjustedEvent.project) return adjustedEvent;
  if (adjustedEvent.skip_session_dedup) return adjustedEvent;

  const dedupKey = `${adjustedEvent.project}:${adjustedEvent.dedup_scope || 'default'}`;
  if (!sessionFileSet.has(dedupKey)) sessionFileSet.set(dedupKey, new Set());
  const seen = sessionFileSet.get(dedupKey)!;
  const newFiles = adjustedEvent.files.filter((file) => !seen.has(file));
  for (const file of newFiles) seen.add(file);

  if (!adjustedEvent.files_avoided) return adjustedEvent;
  if (newFiles.length === 0 && adjustedEvent.dedup_scope) {
    adjustedEvent.files_avoided = 0;
    adjustedEvent.tokens_saved = 0;
    return adjustedEvent;
  }
  const dedupRatio = newFiles.length / adjustedEvent.files.length;
  adjustedEvent.files_avoided = Math.max(1, Math.round(adjustedEvent.files_avoided * dedupRatio));
  if (adjustedEvent.tokens_saved) {
    adjustedEvent.tokens_saved = Math.max(1, Math.round(adjustedEvent.tokens_saved * dedupRatio));
  }
  return adjustedEvent;
}

export function usageLogPath(): string {
  return path.join(lynxHome(), 'usage.jsonl');
}

// ── Token estimation (real file sizes) ──────────────────────

export interface FileSavingsInput {
  files: string[];
  /** Optional rootPath to read real file sizes */
  rootPath?: string;
}

export function estimateTokensFromFiles(
  files: string[],
  rootPath?: string,
  project?: string
): { tokensSaved: number; filesAvoided: number; confidence: 'low' | 'medium' | 'high' } {
  const resolvedRoot = rootPath || '';
  let totalBytes = 0;
  let readable = 0;

  // DB-backed: query file_hashes from last indexing. Fresher than disk
  // stat — the file watcher updates hashes on every file change.
  let dbSizeCache: Map<string, number> | null = null;
  if (project) {
    try {
      dbSizeCache = new Map();
      const db = LynxDatabase.openProject(project);
      const stmt = db.db.prepare('SELECT size FROM file_hashes WHERE project = ? AND rel_path = ?');
      for (const f of files) {
        const row = stmt.get(project, f) as { size: number } | undefined;
        if (row && row.size > 0) dbSizeCache.set(f, row.size);
      }
    } catch { /* DB not available, fall back to disk */ }
  }

  for (const f of files) {
    // DB cache from last indexing (kept fresh by file watcher).
    if (dbSizeCache?.has(f)) {
      totalBytes += dbSizeCache.get(f)!;
      readable++;
      continue;
    }
    // Fall back to disk for files not yet indexed (or no project).
    const fullPath = resolvedRoot ? path.join(resolvedRoot, f) : f;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        totalBytes += stat.size;
        readable++;
      }
    } catch {
      totalBytes += AVG_FILE_TOKENS * 4; // last resort: ~3600 bytes
    }
  }

  const tokensFromBytes = Math.round(totalBytes / 4);

  const confidence =
    files.length >= 12 ? 'high' : files.length >= 4 ? 'medium' : 'low';

  return { tokensSaved: tokensFromBytes, filesAvoided: files.length, confidence };
}

/**
 * A project overview replaces an initial orientation pass — the developer
 * would have scanned the project tree and opened key files to understand
 * the architecture.  Attribute 60 % of the real indexed source volume:
 * the overview replaces the scan but the developer still reads selected files.
 */
/** Total number of aspects available in get_architecture. */
const TOTAL_ARCHITECTURE_ASPECTS = 9;
/** Min coverage floor so one-aspect calls still get some attribution. */
const MIN_ASPECT_COVERAGE = 0.15;
/** Max coverage when all aspects are requested. */
const FULL_ASPECT_COVERAGE = 0.6;

export function estimateArchitectureOverviewSavings(
  files: string[],
  rootPath?: string,
  project?: string,
  requestedAspects?: number,
): { tokensSaved: number; filesAvoided: number; confidence: 'low' | 'medium' | 'high' } {
  const baseline = estimateTokensFromFiles(files, rootPath, project);
  const coverage = requestedAspects
    ? Math.max(MIN_ASPECT_COVERAGE, FULL_ASPECT_COVERAGE * (requestedAspects / TOTAL_ARCHITECTURE_ASPECTS))
    : FULL_ASPECT_COVERAGE;
  return {
    filesAvoided: baseline.filesAvoided,
    tokensSaved: Math.round(baseline.tokensSaved * coverage),
    confidence: baseline.confidence,
  };
}

export interface ToolOperationSavings {
  tokensSaved: number;
  filesAvoided: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Attribution for tools whose benefit is not a direct source read.
 *
 * When the tool result contains file paths AND we know the project, those
 * files' real indexed sizes determine the saved-tokens estimate — the
 * developer would have read those files line-by-line without LYNX.
 * A coverage multiplier accounts for how much of that manual reading
 * the tool's analysis replaces.
 *
 * Tools without file paths (index_status, etc.) use a base formula
 * calibrated to the real manual work each operation replaces.
 */
export function estimateToolOperationSavings(
  toolName: string,
  result: unknown,
  project?: string
): ToolOperationSavings {
  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  if (typeof data.error === 'string' || data.project_status === 'failed') {
    return { tokensSaved: 0, filesAvoided: 0, confidence: 'low' };
  }

  // ── File-based estimation (real indexed sizes) ──────────────
  if (project) {
    const paths = extractResultFilePaths(toolName, data);
    if (paths.length > 0) {
      const coverage = FILE_TOOL_COVERAGE[toolName] ?? 0.5;
      const deduped = [...new Set(paths)];
      const real = estimateTokensFromFiles(deduped, undefined, project);
      return {
        tokensSaved: Math.round(real.tokensSaved * coverage),
        filesAvoided: Math.max(1, Math.round(real.filesAvoided * coverage)),
        confidence: real.confidence,
      };
    }
  }

  // ── Count-based fallback (no project, no file paths, or simple tools) ──
  const count = (...keys: string[]) => keys.reduce((total, key) => {
    const value = data[key];
    if (Array.isArray(value)) return total + value.length;
    if (value && typeof value === 'object') {
      const objectTotal = Object.values(value as Record<string, unknown>)
        .reduce<number>((sum, entry) => sum + (typeof entry === 'number' && Number.isFinite(entry) ? Math.max(0, entry) : 0), 0);
      return total + objectTotal;
    }
    return total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0);
  }, 0);

  const policy: Record<string, { base: number; perItem: number; items: number }> = {
    // Tools that also have file-based paths above — fallback when no project.
    detect_changes:  { base: 900, perItem: Math.round(AVG_FILE_TOKENS * 0.8), items: count('category_counts', 'total_changed_files') },
    analyze_hotspots:{ base: 900, perItem: Math.round(AVG_FILE_TOKENS * 0.8), items: count('hotspots', 'god_components') },
    find_dead_code:  { base: 850, perItem: Math.round(AVG_FILE_TOKENS * 0.65), items: count('candidates') },
    assess_impact:   { base: 900, perItem: Math.round(AVG_FILE_TOKENS * 0.8), items: count('total_findings', 'returned_findings') },
    pack_memory:     { base: 650, perItem: Math.round(AVG_FILE_TOKENS * 0.5), items: count('memories', 'facts', 'decisions', 'items') },
    // Tools without file paths — counts are the only available signal.
    index_repository: { base: 350, perItem: Math.round(AVG_FILE_TOKENS * 0.12), items: count('files_inspected', 'files_reindexed', 'files_added', 'files_modified') },
    index_status:    { base: 900, perItem: Math.round(AVG_FILE_TOKENS * 0.15), items: count('findings') },
    get_graph_schema:{ base: 800, perItem: Math.round(AVG_FILE_TOKENS * 0.15), items: count('node_labels', 'edge_types', 'relationship_patterns') },
    compare_runs:    { base: 1200, perItem: Math.round(AVG_FILE_TOKENS * 0.25), items: data.comparison ? 1 : 0 },
    ingest_traces:   { base: 600, perItem: Math.round(AVG_FILE_TOKENS * 0.1),  items: count('ingested', 'traces_ingested', 'accepted') },
    watch_project:   { base: 500, perItem: Math.round(AVG_FILE_TOKENS * 0.05), items: data.active !== undefined ? 1 : 0 },
    manage_adr:      { base: 600, perItem: Math.round(AVG_FILE_TOKENS * 0.2),  items: count('sections', 'adrs') },
    delete_project:  { base: 400, perItem: Math.round(AVG_FILE_TOKENS * 0.05), items: data.deleted ? 1 : 0 },
    list_projects:   { base: 400, perItem: Math.round(AVG_FILE_TOKENS * 0.12), items: count('projects', 'count') },
  };
  const selected = policy[toolName];
  if (!selected) return { tokensSaved: 0, filesAvoided: 0, confidence: 'low' };

  const tokensSaved = selected.base + selected.items * selected.perItem;
  return {
    tokensSaved,
    filesAvoided: Math.max(1, Math.ceil(tokensSaved / AVG_FILE_TOKENS)),
    confidence: selected.items >= 4 ? 'medium' : 'low',
  };
}

/**
 * File-based tools and their coverage multipliers.
 *
 * The multiplier answers: "What fraction of reading these files
 * line-by-line does the tool's analysis actually replace?"
 *
 * - 0.8: thorough per-file analysis (detect_changes, assess_impact)
 * - 0.75: aggregated file analysis (analyze_hotspots)
 * - 0.6: identification + verification (find_dead_code)
 * - 0.5: metadata/pack (pack_memory)
 */
const FILE_TOOL_COVERAGE: Record<string, number> = {
  detect_changes: 0.8,
  analyze_hotspots: 0.75,
  find_dead_code: 0.6,
  assess_impact: 0.8,
  pack_memory: 0.5,
};

/** Pull every file path out of a tool result so we can estimate from real sizes. */
function extractResultFilePaths(toolName: string, data: Record<string, unknown>): string[] {
  const paths: string[] = [];

  const collectFromArray = (arr: unknown[], key: string) => {
    for (const item of arr) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj[key] === 'string') paths.push(obj[key] as string);
      }
    }
  };

  const collectFromObj = (obj: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const val = obj[key];
      if (Array.isArray(val)) collectFromArray(val, 'file_path');
    }
  };

  switch (toolName) {
    case 'detect_changes': {
      // categories: { staged: [{file}], unstaged: [{file}], ... }
      const cats = data.categories;
      if (cats && typeof cats === 'object') {
        for (const entries of Object.values(cats as Record<string, unknown>)) {
          if (Array.isArray(entries)) collectFromArray(entries, 'file');
        }
      }
      // impact_assessment: { confirmed: [{file_path}], probable: [{file_path}], nominal: [{file_path}] }
      const ia = data.impact_assessment;
      if (ia && typeof ia === 'object') {
        const iaObj = ia as Record<string, unknown>;
        for (const key of ['confirmed', 'probable', 'nominal']) {
          if (Array.isArray(iaObj[key])) collectFromArray(iaObj[key] as unknown[], 'file_path');
        }
      }
      // related_dependencies: [{scope_file}, {related_file}]
      const rd = data.related_dependencies;
      if (Array.isArray(rd)) {
        for (const item of rd) {
          if (item && typeof item === 'object') {
            const dep = item as Record<string, unknown>;
            if (typeof dep.scope_file === 'string') paths.push(dep.scope_file as string);
            if (typeof dep.related_file === 'string') paths.push(dep.related_file as string);
          }
        }
      }
      // changed_files: CompatFileEntry[] (may have 'file' or 'path')
      const cf = data.changed_files;
      if (Array.isArray(cf)) {
        for (const item of cf) {
          if (item && typeof item === 'object') {
            const entry = item as Record<string, unknown>;
            if (typeof entry.file === 'string') paths.push(entry.file as string);
            else if (typeof entry.path === 'string') paths.push(entry.path as string);
          }
        }
      }
      break;
    }
    case 'analyze_hotspots': {
      collectFromArray(data.hotspots as unknown[] || [], 'file_path');
      collectFromArray(data.god_components as unknown[] || [], 'file_path');
      // largest_files: [{path, lines, ...}]
      const lf = data.largest_files;
      if (Array.isArray(lf)) collectFromArray(lf, 'path');
      // most_complex: [{file, complexity, ...}]
      const mc = data.most_complex;
      if (Array.isArray(mc)) collectFromArray(mc, 'file');
      // tightest_coupling: [{file, ...}]
      const tc = data.tightest_coupling;
      if (Array.isArray(tc)) collectFromArray(tc, 'file');
      break;
    }
    case 'find_dead_code': {
      collectFromArray(data.candidates as unknown[] || [], 'file_path');
      break;
    }
    case 'assess_impact': {
      collectFromArray(data.findings as unknown[] || [], 'file');
      // recommended_inspection: string[] of file paths
      const ri = data.recommended_inspection;
      if (Array.isArray(ri)) {
        for (const f of ri) {
          if (typeof f === 'string') paths.push(f);
        }
      }
      break;
    }
    case 'pack_memory': {
      // findings may contain file references
      const items = data.items || data.memories || data.decisions;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            if (typeof obj.targetFile === 'string') paths.push(obj.targetFile as string);
            if (typeof obj.file === 'string') paths.push(obj.file as string);
          }
        }
      }
      break;
    }
  }

  return paths.filter(p => p.length > 0);
}

/**
 * Older releases stored successful operational calls as zero-value events.
 * Preserve their activity history, but apply only the low-confidence baseline
 * of today's policy when the tool name is known; no synthetic result volume is
 * invented for historical records.
 */
export function attributeLegacyToolObservation(event: UsageEvent): UsageEvent {
  if (event.type !== 'tool_observation' || Number(event.tokens_saved || 0) > 0) return event;
  const toolName = event.tool_hint || event.query;
  if (!toolName) return event;
  const value = estimateToolOperationSavings(toolName, {});
  if (value.tokensSaved === 0) return event;
  return {
    ...event,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: 'low',
  };
}

export interface TokenEstimateOpts {
  resultCount: number;
  candidateFiles: number;
  /** Optional list of file paths for real-size-based estimation. */
  files?: string[];
  /** Optional rootPath when file paths are relative. */
  rootPath?: string;
  /** Optional project name for DB-backed size lookup via file_hashes. */
  project?: string;
}

/**
 * Estimate of context tokens saved by returning indexed evidence instead of
 * reading full source files.
 *
 * When file paths + rootPath are supplied, savings equal the real token cost
 * of reading those files (bytes / 4). Otherwise falls back to the formula:
 * filesAvoided * 120 + results * 160, capped at candidateFiles * 900.
 */
export function estimateTokensSaved(opts: TokenEstimateOpts): {
  filesAvoided: number;
  tokensSaved: number;
  confidence: 'low' | 'medium' | 'high';
} {
  const { resultCount, candidateFiles, files, rootPath, project } = opts;
  const usefulResults = Math.max(0, resultCount);
  if (usefulResults === 0) return { filesAvoided: 0, tokensSaved: 0, confidence: 'low' };

  const likelyFilesAvoided = Math.max(0, Math.min(candidateFiles, usefulResults));

  // Real file sizes: the true token cost of reading those files (bytes/4).
  // This is the realistic saving — what the developer would have spent
  // without LYNX's indexed evidence, not a conservative floor.
  if (files && files.length > 0 && rootPath) {
    const real = estimateTokensFromFiles(files, rootPath, project);
    return {
      filesAvoided: likelyFilesAvoided,
      tokensSaved: real.tokensSaved,
      confidence: real.confidence,
    };
  }

  // Fallback when file paths are unavailable (CLI tools, benchmarks).
  const gross = likelyFilesAvoided * 120 + usefulResults * 160;
  const ceiling = likelyFilesAvoided * AVG_FILE_TOKENS;
  return {
    filesAvoided: likelyFilesAvoided,
    tokensSaved: Math.max(0, Math.min(ceiling, gross)),
    confidence: likelyFilesAvoided >= 12 ? 'medium' : 'low',
  };
}

export function estimateRerankCostUsd(candidateCount: number): number {
  const tokens = candidateCount * RERANK_INPUT_TOKENS_PER_CANDIDATE + RERANK_OUTPUT_TOKENS;
  return Number(((tokens / 1000) * FLASH_COST_PER_1K_TOKENS_USD).toFixed(6));
}

// ── Record (with session dedup) ─────────────────────────────

export function recordUsageEvent(event: Omit<UsageEvent, 'ts'>): void {
  try {
    const adjustedEvent = adjustEventForSessionDedup(event);
    const dir = lynxHome();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateLogIfNeeded();

    const safeQuery = sanitizeQuery(adjustedEvent.query);
    const context = defaultUsageContext(adjustedEvent.project);
    const row: UsageEvent = {
      ts: new Date().toISOString(),
      ...adjustedEvent,
      query: safeQuery,
      query_hash: adjustedEvent.query ? hashString(adjustedEvent.query) : undefined,
      event_id: adjustedEvent.event_id || generateEventId(),
      session_id: adjustedEvent.session_id || context.session_id,
      task_id: adjustedEvent.task_id || context.task_id,
      deterministic_mode: adjustedEvent.deterministic_mode ?? (process.env.LYNX_NO_LLM === '1'),
    };
    fs.appendFileSync(usageLogPath(), JSON.stringify(row) + '\n');
    // Also archive to metrics.db for long-term history
    archiveEvent(row);
  } catch {
    // Metrics must never affect product behavior.
  }
}

export function clearUsageEvents(project?: string): number {
  const file = usageLogPath();
  if (!fs.existsSync(file)) return 0;
  if (!project) {
    const events = readUsageEvents(undefined, Number.MAX_SAFE_INTEGER).length;
    fs.unlinkSync(file);
    clearSessionDedup();
    return events;
  }
  const events = readUsageEvents(undefined, Number.MAX_SAFE_INTEGER);
  const kept = events.filter((event) => event.project !== project);
  const removed = events.length - kept.length;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''));
  fs.renameSync(tmp, file);
  clearSessionDedup(project);
  return removed;
}

export function exportUsageEvents(outPath: string, project?: string): number {
  const events = readUsageEvents(project, Number.MAX_SAFE_INTEGER);
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(events, null, 2) + '\n');
  return events.length;
}

export function readUsageEvents(project?: string, limit = 1000): UsageEvent[] {
  const file = usageLogPath();
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(Math.max(0, lines.length - limit));
    const events = recent
      .map((line) => JSON.parse(line) as UsageEvent)
      .filter((event) => !project || event.project === project)
      .map(attributeLegacyToolObservation);
    return events;
  } catch {
    return [];
  }
}

export function summarizeUsage(project?: string, limit = 1000): UsageSummary {
  const events = readUsageEvents(project, limit);
  const byType: Record<string, number> = {};
  let tokensSaved = 0;
  let filesAvoided = 0;
  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;
  let llmEvents = 0;
  let llmRankChanged = 0;
  let llmTopChanged = 0;
  let llmCost = 0;
  let llmLatency = 0;
  const allFiles = new Set<string>();

  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    tokensSaved += event.tokens_saved || 0;
    filesAvoided += event.files_avoided || 0;
    if (event.confidence === 'high') highConfidence += event.tokens_saved || 0;
    else if (event.confidence === 'medium') mediumConfidence += event.tokens_saved || 0;
    else lowConfidence += event.tokens_saved || 0;
    if (event.files) {
      for (const f of event.files) allFiles.add(f);
    }
    if (event.llm_provider && event.llm_provider !== 'heuristic') {
      llmEvents++;
      if (event.rank_changed) llmRankChanged++;
      if (event.top_changed) llmTopChanged++;
      llmCost += event.estimated_llm_cost_usd || 0;
      llmLatency += event.llm_latency_ms || 0;
    }
  }

  const semanticRoi = llmCost > 0 ? Math.round(tokensSaved / llmCost) : null;

  return {
    events: events.length,
    tokens_saved: tokensSaved,
    files_avoided: filesAvoided,
    unique_files_avoided:
      allFiles.size > 0
        ? Math.max(allFiles.size, Math.round(filesAvoided / 4))
        : filesAvoided,
    high_confidence_tokens_saved: highConfidence,
    medium_confidence_tokens_saved: mediumConfidence,
    low_confidence_tokens_saved: lowConfidence,
    llm_events: llmEvents,
    llm_rank_changed: llmRankChanged,
    llm_top_changed: llmTopChanged,
    estimated_llm_cost_usd: Number(llmCost.toFixed(6)),
    llm_latency_ms: llmLatency,
    semantic_roi: semanticRoi,
    by_type: byType,
    since: events[0]?.ts || null,
    until: events[events.length - 1]?.ts || null,
  };
}

// ── Semantic ROI ─────────────────────────────────────────────

export function computeSemanticROI(tokensSaved: number, costUsd: number): {
  tokensPerDollar: number;
  summary: string;
} {
  if (costUsd <= 0) return { tokensPerDollar: Infinity, summary: 'No semantic cost recorded.' };
  const tpd = Math.round(tokensSaved / costUsd);
  if (tpd > 10_000_000) return { tokensPerDollar: tpd, summary: `${tpd.toLocaleString()} tokens saved per $1 of semantic ranking — excellent ROI.` };
  if (tpd > 1_000_000) return { tokensPerDollar: tpd, summary: `${tpd.toLocaleString()} tokens saved per $1 of semantic ranking — strong ROI.` };
  return { tokensPerDollar: tpd, summary: `${tpd.toLocaleString()} tokens saved per $1 of semantic ranking.` };
}

// ── Internals ────────────────────────────────────────────────

function rotateLogIfNeeded(): void {
  const file = usageLogPath();
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.size < MAX_LOG_BYTES) return;
  const rotated = file.replace(/\.jsonl$/, '') + `-${Date.now()}.jsonl`;
  fs.renameSync(file, rotated);
}

function sanitizeQuery(query: string | undefined): string | undefined {
  if (!query) return undefined;
  return query
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, '[phone]')
    .slice(0, MAX_QUERY_CHARS);
}

function hashString(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
