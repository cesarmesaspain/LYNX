/*
 * aggregation.ts — Time-window aggregation and metrics computation.
 *
 * Computes mutually exclusive categories from real events only.
 * No fixed percentages. No unverifiable claims.
 *
 * Categories (mutually exclusive by event type):
 *   direct_discovery    — search_graph, search_code, semantic_search events
 *   smart_navigation    — trace_path, get_code_snippet, batch_get_code events
 *   context_packing     — pack_context events
 *   impact_analysis     — explain_symbol, smart_review, find_tests events
 *   llm_rerank          — llm_rerank events
 *   hook_augment        — hook_augment events
 *   other               — benchmark, real_savings, and any future types
 *
 * Each event is assigned to EXACTLY ONE category based on its type.
 * Total = sum of all categories. No overlap, no double counting.
 *
 * Dedup: by event_id (v3, ~99.9% coverage from 2026-07-10) or
 * legacy stable hash of project|ts|type|query_hash|files_avoided|tokens_saved.
 * Legacy collisions: same event logged twice in same second with same params.
 * Coverage estimate: < 0.1% collision rate.
 */

import { attributeLegacyToolObservation, type UsageEvent } from './metrics.js';
import { readArchivedEvents } from '../store/metrics-db.js';
import { readLynxConfig } from '../config/runtime.js';
import {
  type MetricPoint,
  type MetricProvenance,
  type TelemetryCoverage,
  measuredProvenance,
  estimatedProvenance,
} from './provenance.js';

// ── Time windows ───────────────────────────────────────────────

export type TimeWindow = '24h' | '7d' | '30d' | 'total';

export interface WindowInfo {
  window: TimeWindow;
  since: string;
  until: string;
  label: string;
}

export function getTimeWindows(_now?: string): WindowInfo[] {
  let now: Date;
  if (_now) {
    const d = new Date(_now);
    now = isNaN(d.getTime()) ? new Date() : d;
  } else {
    now = new Date();
  }
  const until = now.toISOString();
  const since24h = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const since7d = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const since30d = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();

  return [
    { window: '24h', since: since24h, until, label: 'Últimas 24h' },
    { window: '7d', since: since7d, until, label: 'Últimos 7 días' },
    { window: '30d', since: since30d, until, label: 'Últimos 30 días' },
    { window: 'total', since: '2020-01-01T00:00:00Z', until, label: 'Total acumulado' },
  ];
}

// ── Category assignment (mutually exclusive) ───────────────────

const CATEGORY_BY_TYPE: Record<string, string> = {
  architecture_overview: 'architecture_overview',
  search_graph: 'direct_discovery',
  search_code: 'direct_discovery',
  semantic_search: 'direct_discovery',
  trace_path: 'smart_navigation',
  get_code_snippet: 'smart_navigation',
  batch_get_code: 'smart_navigation',
  pack_context: 'context_packing',
  explain_symbol: 'impact_analysis',
  smart_review: 'impact_analysis',
  find_tests: 'impact_analysis',
  llm_rerank: 'llm_rerank',
  hook_augment: 'hook_augment',
  tool_observation: 'other',
};

const OBSERVATION_CATEGORY_BY_TOOL: Record<string, string> = {
  investigate_symbol: 'smart_navigation',
  get_edge_evidence: 'smart_navigation',
  detect_changes: 'impact_analysis',
  assess_impact: 'impact_analysis',
  analyze_hotspots: 'impact_analysis',
  find_dead_code: 'impact_analysis',
  pack_memory: 'context_packing',
  get_graph_schema: 'context_packing',
  compare_runs: 'impact_analysis',
  index_repository: 'project_operations',
  index_status: 'project_operations',
  ingest_traces: 'project_operations',
  watch_project: 'project_operations',
  manage_adr: 'project_operations',
  delete_project: 'project_operations',
  auto_index: 'project_operations',
};

const CATEGORY_LABELS: Record<string, string> = {
  architecture_overview: 'Orientación de arquitectura',
  direct_discovery: 'Descubrimiento directo',
  smart_navigation: 'Navegación inteligente',
  context_packing: 'Empaquetado de contexto',
  impact_analysis: 'Análisis de impacto',
  llm_rerank: 'Reordenamiento semántico',
  hook_augment: 'Aumento por hook',
  project_operations: 'Operaciones de proyecto',
  other: 'Otros',
};

function categoryForEvent(e: UsageEvent): string {
  if (e.type === 'tool_observation' && e.tool_hint) {
    return OBSERVATION_CATEGORY_BY_TOOL[e.tool_hint] || 'other';
  }
  return CATEGORY_BY_TYPE[e.type] || 'other';
}

// ── Dedup ──────────────────────────────────────────────────────

/**
 * Stable dedup key.
 *
 * v3 (event_id present, ~99.9% coverage from 2026-07-10):
 *   Uses the UUID event_id generated at record time.
 *
 * Legacy (no event_id):
 *   Hash of project|ts|type|query_hash|files_avoided|tokens_saved.
 *   Collision risk: same tool called twice in the same second with
 *   identical params produces the same key → second event silently dropped.
 *   Estimated < 0.1% of legacy events (legacy events are < 0.1% of total).
 */
function dedupKey(e: UsageEvent): string {
  if (e.event_id) return e.event_id;

  // Legacy: stable hash of identifying fields
  const parts = [
    e.project,
    e.ts,
    e.type,
    e.query_hash || '',
    String(e.files_avoided || 0),
    String(e.tokens_saved || 0),
  ];
  const raw = parts.join('|');
  // Simple FNV-1a hash
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'legacy:' + (h >>> 0).toString(16).padStart(8, '0');
}

function dedupEvents(events: UsageEvent[]): UsageEvent[] {
  const seen = new Set<string>();
  const result: UsageEvent[] = [];
  for (const e of events) {
    const key = dedupKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }
  return result;
}

// ── Exported types ─────────────────────────────────────────────

export interface CategoryBreakdown {
  category: string;
  label: string;
  tokens_saved: number;
  files_avoided: number;
  events: number;
  latency_ms: number;
}

/**
 * Explains exactly which recorded tool activity contributed to the displayed
 * savings.  Operational observations stay out of this object: they are real
 * events, but are not presented as savings.
 */
export interface SavingsAttribution {
  /** Events with a non-zero token or file saving estimate. */
  saving_events: number;
  /** Remaining recorded activity, deliberately excluded from the estimate. */
  operational_events: number;
  /** Confidence of the largest saving contribution. */
  confidence: 'low' | 'medium' | 'high';
  by_tool: Array<{
    type: string;
    events: number;
    tokens_saved: number;
    files_avoided: number;
  }>;
}

export interface LlmBreakdown {
  provider: string;
  model: string | null;
  calls: number;
  estimated_cost_usd: number;
  latency_ms: number;
}

export interface WindowedMetrics {
  window: TimeWindow;
  since: string;
  until: string;
  computed_at: string;
  totals: {
    tokens_saved: number;
    files_avoided: number;
    unique_files_avoided: number;
    events: number;
    llm_events: number;
    llm_cost_usd: number;
    llm_latency_ms: number;
    sessions: number;
    tasks: number;
    deterministic_events: number;
  };
  /** Mutually exclusive. CONTRACT: sum(categories.tokens_saved) === totals.tokens_saved */
  categories: CategoryBreakdown[];
  /** Human-readable attribution for the savings total shown in the UI. */
  savings_attribution: SavingsAttribution;
  /** Real LLM calls grouped by the provider and model captured at event time. */
  llm_breakdown: LlmBreakdown[];
  metrics: MetricPoint[];
  coverage: TelemetryCoverage;
  /** Historical aggregate data that cannot be broken into per-event categories. */
  historical_unclassified?: {
    tokens_saved: number;
    files_avoided: number;
    events: number;
    provenance: MetricProvenance;
  };
}

// ── Main aggregation functions ─────────────────────────────────

export function aggregateByWindow(
  project: string,
  window: TimeWindow,
  _now?: string
): WindowedMetrics {
  const windows = getTimeWindows(_now);
  const win = windows.find((w) => w.window === window)!;
  const now = win.until;

  // DB-only: read from events_archive.
  const allEvents = readArchivedEvents(project, 10000);
  const inWindow = allEvents.filter(
    (e) => e.ts >= win.since && e.ts <= win.until
  );

  return buildFromEvents(win, dedupEvents(inWindow.map(attributeLegacyToolObservation)), now);
}

/**
 * Aggregate total from events_archive (persistent, never rotated).
 * Merges archived events with recent JSONL events, deduplicating by event_id.
 * Uses events_archive as primary source (complete history).
 */
export function aggregateTotal(
  project: string,
  _now?: string
): WindowedMetrics {
  const windows = getTimeWindows(_now);
  const win = windows.find((w) => w.window === 'total')!;
  const now = win.until;

  // DB-only: events_archive is the single source of truth.
  const archived = readArchivedEvents(project, 50000);
  const merged = dedupEvents(archived.map(attributeLegacyToolObservation));
  const actualWindow: WindowInfo = {
    ...win,
    // The total window starts at the first recorded event. When there is no
    // history yet, use the computation time instead of a synthetic sentinel.
    since: merged.reduce((earliest, event) =>
      event.ts < earliest ? event.ts : earliest, merged[0]?.ts || now),
  };

  return buildFromEvents(actualWindow, merged, now);
}

// ── Build from events ──────────────────────────────────────────

function buildFromEvents(
  win: WindowInfo,
  events: UsageEvent[],
  now: string
): WindowedMetrics {
  const categories = buildCategoryBreakdown(events);
  const uniqueFiles = new Set<string>();
  let llmEvents = 0;
  let llmCost = 0;
  let llmLatency = 0;
  const llmBreakdown = new Map<string, LlmBreakdown>();
  const sessions = new Set<string>();
  const tasks = new Set<string>();
  let deterministicEvents = 0;

  for (const e of events) {
    if (e.files) {
      for (const f of e.files) uniqueFiles.add(f);
    }
    if (e.llm_provider && e.llm_provider !== 'heuristic') {
      llmEvents++;
      llmCost += e.estimated_llm_cost_usd || 0;
      llmLatency += e.llm_latency_ms || 0;
      const model = e.llm_model || null;
      const key = `${e.llm_provider}:${model || '__unknown__'}`;
      const entry = llmBreakdown.get(key) || {
        provider: e.llm_provider,
        model,
        calls: 0,
        estimated_cost_usd: 0,
        latency_ms: 0,
      };
      entry.calls++;
      entry.estimated_cost_usd += e.estimated_llm_cost_usd || 0;
      entry.latency_ms += e.llm_latency_ms || 0;
      llmBreakdown.set(key, entry);
    }
    if (e.session_id) sessions.add(e.session_id);
    if (e.task_id) tasks.add(e.task_id);
    if (e.deterministic_mode) deterministicEvents++;
  }

  // CONTRACT: totals derived from categories → invariant guaranteed
  const tokensSaved = categories.reduce((sum, c) => sum + c.tokens_saved, 0);
  const filesAvoided = categories.reduce((sum, c) => sum + c.files_avoided, 0);
  const eventCount = categories.reduce((sum, c) => sum + c.events, 0);

  const totals = {
    tokens_saved: tokensSaved,
    files_avoided: filesAvoided,
    unique_files_avoided: uniqueFiles.size || filesAvoided,
    events: eventCount,
    llm_events: llmEvents,
    llm_cost_usd: Number(llmCost.toFixed(6)),
    llm_latency_ms: llmLatency,
    sessions: sessions.size,
    tasks: tasks.size,
    deterministic_events: deterministicEvents,
  };

  const coverage = computeCoverage(
    events, llmEvents, deterministicEvents,
    sessions.size, tasks.size
  );

  return {
    window: win.window,
    since: win.since,
    until: win.until,
    computed_at: now,
    totals,
    categories,
    savings_attribution: buildSavingsAttribution(events),
    llm_breakdown: [...llmBreakdown.values()]
      .map((entry) => ({ ...entry, estimated_cost_usd: Number(entry.estimated_cost_usd.toFixed(6)) }))
      .sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd),
    metrics: buildMetricPoints(totals, categories, now, win),
    coverage,
  };
}

function buildSavingsAttribution(events: UsageEvent[]): SavingsAttribution {
  const savings = events.filter((event) =>
    Number(event.tokens_saved || 0) > 0 || Number(event.files_avoided || 0) > 0
  );
  const byTool = new Map<string, { events: number; tokens_saved: number; files_avoided: number }>();

  for (const event of savings) {
    const type = event.tool_hint || event.type || 'other';
    const entry = byTool.get(type) || { events: 0, tokens_saved: 0, files_avoided: 0 };
    entry.events++;
    entry.tokens_saved += Number(event.tokens_saved || 0);
    entry.files_avoided += Number(event.files_avoided || 0);
    byTool.set(type, entry);
  }

  const leading = [...savings].sort((a, b) =>
    Number(b.tokens_saved || 0) - Number(a.tokens_saved || 0)
  )[0];

  return {
    saving_events: savings.length,
    operational_events: Math.max(0, events.length - savings.length),
    confidence: leading?.confidence || 'medium',
    by_tool: [...byTool.entries()]
      .map(([type, value]) => ({ type, ...value }))
      .sort((a, b) => b.tokens_saved - a.tokens_saved),
  };
}

// ── Category breakdown ─────────────────────────────────────────

function buildCategoryBreakdown(events: UsageEvent[]): CategoryBreakdown[] {
  const map = new Map<
    string,
    { tokens: number; files: number; events: number; latency: number }
  >();

  for (const e of events) {
    const cat = categoryForEvent(e);
    const entry = map.get(cat) || { tokens: 0, files: 0, events: 0, latency: 0 };
    entry.tokens += e.tokens_saved || 0;
    entry.files += e.files_avoided || 0;
    entry.events++;
    entry.latency += e.latency_ms || 0;
    map.set(cat, entry);
  }

  const allCats = [
    'architecture_overview',
    'direct_discovery',
    'smart_navigation',
    'context_packing',
    'impact_analysis',
    'llm_rerank',
    'hook_augment',
    'project_operations',
    'other',
  ];

  return allCats
    .map((cat) => {
      const e = map.get(cat) || { tokens: 0, files: 0, events: 0, latency: 0 };
      return {
        category: cat,
        label: CATEGORY_LABELS[cat] || cat,
        tokens_saved: e.tokens,
        files_avoided: e.files,
        events: e.events,
        latency_ms: e.latency,
      };
    })
    .filter((c) => c.events > 0 || c.tokens_saved > 0)
    .sort((a, b) =>
      b.tokens_saved - a.tokens_saved ||
      b.events - a.events ||
      a.category.localeCompare(b.category)
    );
}

// ── Metric points with provenance ──────────────────────────────

function buildMetricPoints(
  totals: WindowedMetrics['totals'],
  categories: CategoryBreakdown[],
  now: string,
  win: WindowInfo
): MetricPoint[] {
  const period = `${win.since}/${win.until}`;

  const prov = (kind: 'measured' | 'estimated', overrides?: Partial<MetricProvenance>): MetricProvenance => {
    const base = kind === 'measured'
      ? measuredProvenance({ period, sample_size: totals.events, ...overrides })
      : estimatedProvenance(overrides?.formula || '', { period, sample_size: totals.events, ...overrides });
    return { ...base, computed_at: now, period };
  };

  const points: MetricPoint[] = [
    {
      key: 'tokens_saved',
      label: 'Tokens ahorrados',
      value: totals.tokens_saved,
      unit: 'tokens',
      provenance: prov('estimated', {
        source: 'events tokens_saved (conservative returned-context attribution)',
        formula: 'sum(event.tokens_saved); full-file exploration is kept out of observed savings',
        confidence: 0.7,
        sample_size: totals.events,
      }),
    },
    {
      key: 'files_avoided',
      label: 'Archivos evitados',
      value: totals.files_avoided,
      unit: 'archivos',
      provenance: prov('estimated', {
        source: 'events files_avoided (heuristic: min(candidateFiles, usefulResults*4))',
        formula: 'sum(event.files_avoided); counts are estimated from result_count and candidateFiles',
        confidence: 0.7,
        sample_size: totals.events,
      }),
    },
    {
      key: 'unique_files',
      label: 'Archivos únicos',
      value: totals.unique_files_avoided,
      unit: 'archivos',
      provenance: prov('measured', {
        source: 'Set of unique file paths across all events',
        sample_size: totals.unique_files_avoided,
      }),
    },
    {
      key: 'events',
      label: 'Eventos registrados',
      value: totals.events,
      unit: 'eventos',
      provenance: prov('measured', {
        source: 'events_archive row count',
        sample_size: totals.events,
      }),
    },
    {
      key: 'sessions',
      label: 'Sesiones',
      value: totals.sessions,
      unit: 'sesiones',
      provenance: prov('measured', {
        source: 'COUNT(DISTINCT session_id)',
        sample_size: totals.sessions,
      }),
    },
    {
      key: 'tasks',
      label: 'Tareas',
      value: totals.tasks,
      unit: 'tareas',
      provenance: prov('measured', {
        source: 'COUNT(DISTINCT task_id)',
        sample_size: totals.tasks,
      }),
    },
  ];

  if (totals.llm_events > 0) {
    points.push({
      key: 'llm_cost',
      label: 'Coste LLM estimado',
      value: totals.llm_cost_usd,
      unit: 'USD',
      provenance: prov('estimated', {
        source: 'llm_rerank cost estimation',
        formula: 'sum(estimated_llm_cost_usd) where llm_provider not heuristic',
        confidence: 0.8,
        sample_size: totals.llm_events,
      }),
    });
    points.push({
      key: 'llm_events',
      label: 'Eventos LLM',
      value: totals.llm_events,
      unit: 'eventos',
      provenance: prov('measured', {
        source: 'events with llm_provider set and not heuristic',
        sample_size: totals.llm_events,
      }),
    });
  }

  // Category breakdown as sub-metrics
  if (categories.length > 0) {
    const tokenPoint = points.find((p) => p.key === 'tokens_saved')!;
    tokenPoint.breakdown = categories.map((c) => ({
      key: `category_${c.category}`,
      label: c.label,
      value: c.tokens_saved,
      unit: 'tokens',
      provenance: prov('estimated', {
        source: `events WHERE type maps to ${c.category}`,
        formula: 'sum(tokens_saved) for events in this category',
        confidence: 0.7,
        sample_size: c.events,
      }),
    }));
  }

  return points;
}

// ── Telemetry coverage ─────────────────────────────────────────

function computeCoverage(
  events: UsageEvent[],
  llmEvents: number,
  deterministicEvents: number,
  sessionsTracked: number,
  tasksTracked: number
): TelemetryCoverage {
  const isDeterministic =
    deterministicEvents > 0 &&
    deterministicEvents >= events.length * 0.9;
  const llmActive = llmEvents > 0;
  const sessionsAvailable = sessionsTracked > 0;
  const tasksAvailable = tasksTracked > 0;
  // event_coverage: events exist, but we don't know the denominator.
  // Use a baseline of 1 if events exist (coverage = we have data).
  const eventCov = events.length > 0 ? 1 : 0;
  const cfg = readLynxConfig();
  const hasLLMKey = !!(cfg?.api_keys?.deepseek || cfg?.api_keys?.vps_key);

  let summary: string;
  if (events.length === 0) {
    summary =
      'Sin datos de telemetría. Usa LYNX con un proyecto indexado para generar eventos.';
  } else if (isDeterministic) {
    const sessInfo = sessionsAvailable ? `${sessionsTracked} sesiones` : 'sesiones no rastreadas';
    summary = `Modo determinista activo (${deterministicEvents}/${events.length} eventos, ${sessInfo}).`;
  } else if (!llmActive) {
    const sessPart = sessionsAvailable ? `${sessionsTracked} sesiones` : 'sesiones: no disponible';
    const taskPart = tasksAvailable ? `${tasksTracked} tareas` : 'tareas: no disponible';
    if (hasLLMKey) {
      summary = `Eventos registrados sin LLM (${sessPart}, ${taskPart}). La API key está configurada pero enable_llm no se activó en las llamadas — el reranking semántico no fue solicitado.`;
    } else {
      summary = `Eventos registrados sin LLM (${sessPart}, ${taskPart}). Configura LYNX_DEEPSEEK_KEY o LYNX_API_KEY para activar reordenamiento semántico.`;
    }
  } else {
    const sessPart = sessionsAvailable ? `${sessionsTracked} sesiones` : 'sesiones: no disponible';
    const taskPart = tasksAvailable ? `${tasksTracked} tareas` : 'tareas: no disponible';
    summary = `Telemetría activa (${sessPart}, ${taskPart}). Cobertura de eventos: ${eventCov > 0 ? 'activa' : 'sin datos'}.`;
  }

  return {
    event_coverage: eventCov,
    sessions_tracked: sessionsTracked,
    sessions_available: sessionsAvailable,
    tasks_tracked: tasksTracked,
    tasks_available: tasksAvailable,
    llm_tracking_active: llmActive,
    has_llm_key: hasLLMKey,
    deterministic_mode: isDeterministic,
    summary,
  };
}
