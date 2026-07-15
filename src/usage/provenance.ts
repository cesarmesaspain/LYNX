/*
 * provenance.ts — Metric provenance model and configurable pricing.
 *
 * Every metric carries its origin so the dashboard can show
 * Medido/Estimado/Simulado badges with formula tooltips.
 *
 * v1 — 2026-07-10: Initial model with measured|estimated|scenario provenance.
 */

// ── Provenance ─────────────────────────────────────────────────

export type ProvenanceKind = 'measured' | 'estimated' | 'scenario';

export interface MetricProvenance {
  kind: ProvenanceKind;
  /** Human-readable source (e.g. "usage.jsonl events_archive", "token estimation formula"). */
  source: string;
  /** Time period the metric covers, e.g. "2026-07-09/2026-07-10". */
  period: string | null;
  /** ISO timestamp of when this metric was computed. */
  computed_at: string;
  /** Formula description for estimated metrics, null for measured. */
  formula: string | null;
  /** Number of data points (events, sessions, tasks) backing this metric. */
  sample_size: number;
  /** Confidence 0-1 for estimated metrics, 1 for measured. */
  confidence: number;
  /** Session ID if scoped to a session. */
  session_id: string | null;
  /** Task/conversation ID if scoped to a task. */
  task_id: string | null;
  /** Unique event ID for single-event metrics. */
  event_id: string | null;
  /** Reconciliation status for historical_unclassified data. */
  status?: 'legacy' | 'unreconciled' | 'no_snapshots';
}

export interface MetricPoint {
  /** Machine-readable key, e.g. "tokens_saved", "files_avoided", "llm_cost". */
  key: string;
  /** Display label (Spanish by default). */
  label: string;
  /** Numeric value. */
  value: number;
  /** Unit label, e.g. "tokens", "USD", "files", "ms". */
  unit: string;
  provenance: MetricProvenance;
  /** Optional breakdown by sub-category for mutually exclusive components. */
  breakdown?: MetricPoint[];
}

export function measuredProvenance(overrides?: Partial<MetricProvenance>): MetricProvenance {
  return {
    kind: 'measured',
    source: overrides?.source || 'usage.jsonl + metrics.db events_archive',
    period: overrides?.period || null,
    computed_at: new Date().toISOString(),
    formula: null,
    sample_size: overrides?.sample_size || 0,
    confidence: 1,
    session_id: overrides?.session_id || null,
    task_id: overrides?.task_id || null,
    event_id: overrides?.event_id || null,
  };
}

export function estimatedProvenance(
  formula: string,
  overrides?: Partial<MetricProvenance>
): MetricProvenance {
  return {
    kind: 'estimated',
    source: overrides?.source || 'token estimation heuristic',
    period: overrides?.period || null,
    computed_at: new Date().toISOString(),
    formula,
    sample_size: overrides?.sample_size || 0,
    confidence: overrides?.confidence || 0.5,
    session_id: overrides?.session_id || null,
    task_id: overrides?.task_id || null,
    event_id: overrides?.event_id || null,
  };
}

export function scenarioProvenance(overrides?: Partial<MetricProvenance>): MetricProvenance {
  return {
    kind: 'scenario',
    source: overrides?.source || 'editable simulation',
    period: overrides?.period || null,
    computed_at: new Date().toISOString(),
    formula: overrides?.formula || null,
    sample_size: 0,
    confidence: 0,
    session_id: null,
    task_id: null,
    event_id: null,
  };
}

// ── Pricing config (versioned) ─────────────────────────────────

export interface ModelPricing {
  /** USD per million input tokens. */
  input_per_1m: number;
  /** USD per million output tokens. */
  output_per_1m: number;
}

export interface PricingConfig {
  /** Config version for cache invalidation. */
  version: 1;
  /** When this pricing was last updated (ISO timestamp). */
  updated_at: string;
  /** True if user manually set the pricing, false if defaults. */
  user_configured: boolean;
  /** Token estimation constants. */
  estimation: {
    avg_file_tokens: number;
    avg_symbol_tokens: number;
    rerank_input_tokens_per_candidate: number;
    rerank_output_tokens: number;
  };
  /** Known model prices. "not_available" means use measured costs only. */
  models: Record<string, ModelPricing | 'not_available'>;
}

export const DEFAULT_PRICING: PricingConfig = {
  version: 1,
  updated_at: '2026-07-10T00:00:00Z',
  user_configured: false,
  estimation: {
    avg_file_tokens: 900,
    avg_symbol_tokens: 180,
    rerank_input_tokens_per_candidate: 90,
    rerank_output_tokens: 80,
  },
  models: {
    // No external prices — use measured costs from LLM events only.
    // Users can add their own model prices in ~/.lynx/config.json.
  },
};

export function defaultPricingConfig(): PricingConfig {
  return { ...DEFAULT_PRICING, models: { ...DEFAULT_PRICING.models } };
}

// ── Telemetry coverage ─────────────────────────────────────────

export interface TelemetryCoverage {
  /** Fraction of tool calls that have usage events (0-1). */
  event_coverage: number;
  /** Number of sessions tracked. */
  sessions_tracked: number;
  /** Whether sessions are tracked (false for legacy data). */
  sessions_available: boolean;
  /** Number of tasks tracked. */
  tasks_tracked: number;
  /** Whether tasks are tracked (false for legacy data). */
  tasks_available: boolean;
  /** Whether LLM cost tracking is active. */
  llm_tracking_active: boolean;
  /** Whether an LLM API key (DeepSeek or VPS) is configured. */
  has_llm_key: boolean;
  /** Whether deterministic mode is on (no LLM events expected). */
  deterministic_mode: boolean;
  /** Human-readable summary. */
  summary: string;
}
