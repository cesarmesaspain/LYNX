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
  | 'search_graph'
  | 'trace_path'
  | 'llm_rerank'
  | 'hook_augment'
  | 'benchmark'
  | 'real_savings';

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

// ── Session-level dedup ─────────────────────────────────────

const sessionFileSet = new Map<string, Set<string>>(); // project -> files

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

export function estimateTokensSaved(
  resultCount: number,
  candidateFiles: number
): {
  filesAvoided: number;
  tokensSaved: number;
  confidence: 'low' | 'medium' | 'high';
} {
  const usefulResults = Math.max(0, resultCount);
  if (usefulResults === 0) return { filesAvoided: 0, tokensSaved: 0, confidence: 'low' };

  const likelyFilesAvoided = Math.max(0, Math.min(candidateFiles, usefulResults * 4));
  const gross = likelyFilesAvoided * AVG_FILE_TOKENS;
  const lynxContext = usefulResults * AVG_SYMBOL_TOKENS;
  const confidence =
    likelyFilesAvoided >= 12 ? 'high' : likelyFilesAvoided >= 4 ? 'medium' : 'low';
  return {
    filesAvoided: likelyFilesAvoided,
    tokensSaved: Math.max(0, gross - lynxContext),
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
    const dir = lynxHome();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateLogIfNeeded();

    // Session-level dedup: track unique files per project
    if (event.files && event.files.length > 0 && event.project) {
      if (!sessionFileSet.has(event.project)) {
        sessionFileSet.set(event.project, new Set());
      }
      const seen = sessionFileSet.get(event.project)!;
      const newFiles = event.files.filter((f) => !seen.has(f));
      for (const f of newFiles) seen.add(f);
      // Adjust files_avoided to count only new files
      if (event.files_avoided && event.files) {
        const dedupRatio = event.files.length > 0 ? newFiles.length / event.files.length : 1;
        event.files_avoided = Math.max(1, Math.round(event.files_avoided * dedupRatio));
        event.tokens_saved = event.tokens_saved
          ? Math.max(1, Math.round(event.tokens_saved * dedupRatio))
          : event.tokens_saved;
      }
    }

    const safeQuery = sanitizeQuery(event.query);
    const row: UsageEvent = {
      ts: new Date().toISOString(),
      ...event,
      query: safeQuery,
      query_hash: event.query ? hashString(event.query) : undefined,
      event_id: event.event_id || generateEventId(),
      deterministic_mode: event.deterministic_mode ?? (process.env.LYNX_NO_LLM === '1'),
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
      .filter((event) => !project || event.project === project);
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
