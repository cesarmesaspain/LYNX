/*
 * agent-ab/types.ts — Types for LLM agent A/B benchmark.
 *
 * Measures real LLM agent productivity with vs without LYNX tools.
 */

export interface AgentABConfig {
  /** Official runs are DeepSeek-only; screening runs are explicitly non-comparable. */
  tier: 'official' | 'screening';
  seed: number;
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  /** Omitted in real-world mode so DeepSeek applies its own output limit. */
  maxTokens?: number;
  /** Omitted in real-world mode; the agent stops only when the model stops. */
  maxToolCalls?: number;
  timeoutMs?: number;
  maxRetries?: number;
  warmupRounds: number;
  measuredRounds: number;
  taskIds?: string[];
  fixtureDir?: string;
  /** Read-only source project for a one-task external-project benchmark. */
  projectDir?: string;
  dryRun: boolean;
}

/** Scoring confidence for a benchmark task. Only deterministic/partial tasks can be evaluated. */
export type EvaluationKind = 'deterministic' | 'partial' | 'designed-only';

export interface AgentABRun {
  run_id: string;
  task_id: string;
  condition: 'with_lynx' | 'without_lynx';
  order_position: number;
  seed: number;
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  response: string;
  responseHash: string;
  metrics: AgentABMetrics;
  result: Record<string, unknown>;
  expected: Record<string, unknown>;
  correct: boolean;
  /** Whether this run counts toward functional success and defect metrics. */
  evaluation_eligible: boolean;
  /** Whether the task has full, partial, or no deterministic assertions. */
  evaluation_kind: EvaluationKind;
  errors: string[];
  not_executed: boolean;
  not_executed_reason?: string;
  /** True when the normal tool-call budget was exhausted. */
  tool_loop_exhausted: boolean;
  /** Set when maxToolCalls was exhausted AND the forced-final call failed. Preserves real metrics. */
  finalization_error?: string;
  /** Present only when --include-trace is set. Sanitized: no keys, headers, or full file contents. */
  trace?: ToolTraceStep[];
  /** For external/pilot tasks: the resolved project directory path. */
  projectDir?: string;
  /** For B3: git diff captured after the agent run. */
  diff?: string;
  /** For B3: captured test output (truncated). */
  testOutput?: string;
}

/** Single step in a tool-call trace. Sanitized — no secrets, no full file contents, no headers. */
export interface ToolTraceStep {
  /** Monotonic sequence number within this run. */
  seq: number;
  /** 'llm_call' = API turn; 'tool_exec' = tool execution after LLM requested it. */
  role: 'llm_call' | 'tool_exec';
  /** Model returned by API (only for llm_call steps). */
  model?: string;
  /** finish_reason from API (only for llm_call steps). */
  finish_reason?: string;
  /** Tool function name (only for tool_exec steps). */
  tool_name?: string;
  /** Sanitized arguments — patterns redacted, paths kept relative. */
  args_redacted?: Record<string, unknown>;
  /** Wall-clock duration of this step in ms. */
  duration_ms: number;
  /** Byte size of tool result (only for tool_exec steps). */
  result_bytes?: number;
  /** Sanitized error message if this step failed. */
  error_sanitized?: string;
  /** SHA256 hash of the response content (llm_call) or tool result (tool_exec) — content fingerprint, not the content itself. */
  content_hash?: string;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentABMetrics {
  model: string;
  model_version: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  tool_call_count: number;
  files_read: number;
  bytes_read: number;
  wall_time_ms: number;
  api_latency_ms: number;
  cost_usd: number;
  cost_classification: 'estimated';
  functional_success: boolean;
  defects_introduced: number;
  fixes_needed: number;
  not_executed: boolean;
  /** B3 code-modification: did the project build after the agent fix? */
  build_passed?: boolean;
  /** B3 code-modification: hidden tests that passed. */
  tests_passed?: number;
  /** B3 code-modification: total hidden tests run. */
  tests_total?: number;
  /** B3 code-modification: files modified by the agent. */
  diff_files_changed?: number;
  /** B3 code-modification: lines added by the agent. */
  diff_lines_added?: number;
  /** B3 code-modification: lines removed by the agent. */
  diff_lines_removed?: number;
  /** Time spent indexing the project (first run only, 0 for warm runs). */
  cold_start_index_ms?: number;
  /** Improvement #6: efficiency metrics for benchmark quality scoring. */
  /** Number of tool calls with duplicate (name + args hash) within the same run. */
  tool_calls_unnecessary?: number;
  /** Number of distinct tools that returned evidence (non-empty, non-trivial payload). */
  evidence_used?: number;
  /** Composite efficiency score 0-1: (functional_success × useful_tools / total_tools). */
  efficiency_score?: number;
}

/** Ground truth frozen before the pilot benchmark run. */
export interface PilotGroundTruth {
  a2_callers: Array<{ name: string; file_path: string }>;
  a5_largest_files: Array<{ file: string; lines: number }>;
  a5_most_complex: Array<{ name: string; file: string; complexity: number }>;
  a5_tightest_coupling: Array<{ name: string; file: string; fan_in: number }>;
  a5_god_objects: Array<{ name: string; file: string; lines: number }>;
  b3_commit: string;
  b3_bug_file: string;
  b3_bug_description: string;
}

export interface AgentABTask {
  id: string;
  name: string;
  description: string;
  userPrompt: string;
  expected: Record<string, unknown>;
  evaluation_kind?: EvaluationKind;
  /** Evaluate the final response/content to produce a structured result + correctness. */
  evaluate: (messages: AgentMessage[], condition: 'with_lynx' | 'without_lynx') => AgentABEvaluation;
}

export interface AgentABEvaluation {
  result: Record<string, unknown>;
  correct: boolean;
  defects: number;
  fixes: number;
  errors: string[];
}

export interface AgentABResult {
  config: Omit<AgentABConfig, 'apiKey'>;
  methodology: string[];
  tasks: AgentABRun[];
  summary: AgentABSummary;
  warnings: string[];
}

export interface AgentABSummary {
  with_lynx: AgentABConditionSummary;
  without_lynx: AgentABConditionSummary;
  comparison: AgentABComparisonBlock[];
  sample_size_note: string;
  roi_blocked: boolean;
  roi_blocked_reason: string | null;
}

export interface AgentABConditionSummary {
  wall_time_ms: { median: number; p95: number };
  input_tokens: { median: number; total: number };
  output_tokens: { median: number; total: number };
  tool_calls: { median: number; total: number };
  cost_usd: { median: number; total: number };
  functional_success_rate: number;
  evaluated_runs: number;
  excluded_from_evaluation: number;
  defects_per_task: number;
  /** Improvement #6: efficiency metrics in summary. */
  tool_calls_unnecessary?: { median: number; total: number };
  evidence_used?: { median: number; total: number };
  efficiency_score?: { median: number };
}

/** Immutable protocol used for a paid before/after microbenchmark. */
export interface AgentABExperimentProtocol {
  model: 'deepseek-v4-flash';
  temperature: 0;
  seeds: number[];
  prompt_hash: string;
  task_order: string[];
  max_tokens: number | null;
  max_tool_calls: number | null;
  timeout_ms: number | null;
  max_retries: number | null;
  base_url: string;
}

export interface AgentABExperimentComparison {
  accepted: boolean;
  blocked_reasons: string[];
  deltas: {
    success_rate: number;
    cost_usd: number;
    input_tokens: number;
    wall_time_ms: number;
    tool_calls: number;
    tool_loop_exhausted: number;
  };
}

export interface AgentABComparisonBlock {
  metric: string;
  class: 'measured' | 'estimated';
  with_lynx: string;
  without_lynx: string;
  delta: string;
  interpretation: string;
}

export interface ApiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface ApiResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: AgentToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }>;
  usage?: ApiUsage;
}

export interface PricingConfig {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
}
