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
const AVG_SYMBOL_TOKENS = 180;
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
  rootPath?: string
): { tokensSaved: number; filesAvoided: number; confidence: 'low' | 'medium' | 'high' } {
  const resolvedRoot = rootPath || '';
  let totalBytes = 0;
  let readable = 0;

  for (const f of files) {
    const fullPath = resolvedRoot ? path.join(resolvedRoot, f) : f;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        totalBytes += stat.size;
        readable++;
      }
    } catch {
      totalBytes += AVG_FILE_TOKENS * 4; // fallback: ~3600 bytes
    }
  }

  const tokensFromBytes = Math.round(totalBytes / 4); // ~4 chars per token
  const gross = Math.max(files.length * AVG_FILE_TOKENS, tokensFromBytes);
  const net = Math.max(0, gross - files.length * AVG_SYMBOL_TOKENS);

  const confidence =
    files.length >= 12 ? 'high' : files.length >= 4 ? 'medium' : 'low';

  return { tokensSaved: net, filesAvoided: files.length, confidence };
}

/**
 * A project overview replaces an initial orientation pass, not a full code
 * review. Attribute a conservative 35% of the real indexed source volume and
 * cap it so a single broad request cannot dominate all product metrics.
 */
export function estimateArchitectureOverviewSavings(
  files: string[],
  rootPath?: string,
): { tokensSaved: number; filesAvoided: number; confidence: 'low' | 'medium' | 'high' } {
  const baseline = estimateTokensFromFiles(files, rootPath);
  return {
    filesAvoided: baseline.filesAvoided,
    tokensSaved: Math.min(20_000, Math.round(baseline.tokensSaved * 0.35)),
    confidence: baseline.confidence,
  };
}

export interface ToolOperationSavings {
  tokensSaved: number;
  filesAvoided: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Conservative, result-based attribution for tools whose benefit is not a
 * direct source read.  The numbers represent the manual inspection and
 * coordination the completed result replaces; they are capped per call and
 * deliberately do not use request latency as a proxy for value.
 */
export function estimateToolOperationSavings(toolName: string, result: unknown): ToolOperationSavings {
  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  if (typeof data.error === 'string' || data.project_status === 'failed') {
    return { tokensSaved: 0, filesAvoided: 0, confidence: 'low' };
  }

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
  const policy: Record<string, { base: number; perItem: number; cap: number; items: number }> = {
    // Preparing or checking a project avoids shell/db inspection, but is kept
    // below analytical tools because it does not itself answer a code question.
    index_repository: { base: 350, perItem: 45, cap: 6_000, items: count('files_inspected', 'files_reindexed', 'files_added', 'files_modified') },
    index_status: { base: 280, perItem: 0, cap: 280, items: 0 },
    detect_changes: { base: 650, perItem: 300, cap: 5_000, items: count('changed_files', 'total_changes', 'category_counts') },
    assess_impact: { base: 900, perItem: 480, cap: 8_000, items: count('total_findings', 'returned_findings') },
    analyze_hotspots: { base: 850, perItem: 550, cap: 7_000, items: count('hotspots', 'god_components', 'largest_files', 'most_complex') },
    find_dead_code: { base: 850, perItem: 600, cap: 7_000, items: count('candidates') },
    pack_memory: { base: 550, perItem: 260, cap: 3_500, items: count('memories', 'facts', 'decisions', 'items') },
    get_graph_schema: { base: 500, perItem: 120, cap: 2_500, items: count('node_labels', 'edge_types', 'relationship_patterns') },
    compare_runs: { base: 700, perItem: 300, cap: 2_500, items: data.comparison ? 1 : 0 },
    ingest_traces: { base: 400, perItem: 90, cap: 3_000, items: count('ingested', 'traces_ingested', 'accepted') },
    watch_project: { base: 260, perItem: 0, cap: 260, items: 0 },
    manage_adr: { base: 350, perItem: 180, cap: 2_000, items: count('sections', 'adrs') },
    delete_project: { base: 220, perItem: 0, cap: 220, items: 0 },
    list_projects: { base: 160, perItem: 80, cap: 1_000, items: count('projects', 'count') },
  };
  const selected = policy[toolName];
  if (!selected) return { tokensSaved: 0, filesAvoided: 0, confidence: 'low' };

  const tokensSaved = Math.min(selected.cap, selected.base + selected.items * selected.perItem);
  return {
    tokensSaved,
    filesAvoided: Math.max(1, Math.ceil(tokensSaved / AVG_FILE_TOKENS)),
    confidence: selected.items >= 4 ? 'medium' : 'low',
  };
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
  /** Optional list of file paths for real-size-based estimation. When provided
   *  together with rootPath, the upper bound uses real byte counts instead of
   *  the fixed 900-token-per-file average. */
  files?: string[];
  rootPath?: string;
}

/**
 * Conservative estimate of context tokens saved by returning indexed evidence
 * instead of reading full source files.
 *
 * When file paths and rootPath are supplied the upper bound is derived from
 * real file sizes via estimateTokensFromFiles. Otherwise a fixed 900-token
 * average per candidate file is used as the ceiling.
 */
export function estimateTokensSaved(opts: TokenEstimateOpts): {
  filesAvoided: number;
  tokensSaved: number;
  confidence: 'low' | 'medium' | 'high';
} {
  const { resultCount, candidateFiles, files, rootPath } = opts;
  const usefulResults = Math.max(0, resultCount);
  if (usefulResults === 0) return { filesAvoided: 0, tokensSaved: 0, confidence: 'low' };

  // Observed savings mean only the compact indexed evidence returned by this
  // call: a symbol/file pointer plus enough context to choose the next step.
  // They must not charge four complete manual file reads per result. Full-file
  // exploration belongs in the separate potential range exposed by handlers.
  const likelyFilesAvoided = Math.max(0, Math.min(candidateFiles, usefulResults));
  const gross = likelyFilesAvoided * 120 + usefulResults * 160;

  // Upper bound: use real file sizes when available, fall back to fixed average
  let upperBound: number;
  let confidence: 'low' | 'medium' | 'high';
  if (files && files.length > 0 && rootPath) {
    const real = estimateTokensFromFiles(files, rootPath);
    upperBound = real.tokensSaved;
    confidence = real.confidence;
  } else {
    upperBound = likelyFilesAvoided * AVG_FILE_TOKENS;
    confidence = likelyFilesAvoided >= 12 ? 'medium' : 'low';
  }

  return {
    filesAvoided: likelyFilesAvoided,
    tokensSaved: Math.max(0, Math.min(upperBound, gross)),
    confidence,
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
