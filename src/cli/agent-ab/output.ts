/* Agent A/B output and result-validity helpers. */

import * as path from 'node:path';
import { redactSecrets } from './api-client.js';
import { buildExperimentProtocol } from './experiment.js';
import type { AgentABResult, AgentABRun, AgentToolCall } from './types.js';

// ── Output generators ─────────────────────────────────────────

/** Sanitized aggregate for historical diagnosis; never includes tool arguments. */
export function toolCallSummary(
  toolCalls: AgentToolCall[] | undefined,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const call of toolCalls || []) {
    const name = call.function?.name || "unknown";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function agentResultToJSON(
  result: AgentABResult,
  includeTrace = false,
): string {
  return JSON.stringify(
    {
      config: result.config,
      methodology: result.methodology,
      summary: result.summary,
      experiment_protocol:
        result.config.tier === "screening" ? null : buildExperimentProtocol(result),
      tasks: result.tasks.map((r) => ({
        run_id: r.run_id,
        task_id: r.task_id,
        condition: r.condition,
        not_executed: r.not_executed,
        order_position: r.order_position,
        seed: r.seed,
        messages: r.messages,
        metrics: r.metrics,
        correct: r.correct,
        evaluation_eligible: r.evaluation_eligible,
        evaluation_kind: r.evaluation_kind,
        tool_loop_exhausted: r.tool_loop_exhausted,
        finalization_error: r.finalization_error,
        errors: r.errors,
        // Keep the final answer for qualitative A/B review; never serialize secrets.
        response: redactSecrets(r.response),
        response_hash: r.responseHash,
        tool_calls: r.toolCalls?.length ?? r.metrics.tool_call_count,
        tool_call_summary: toolCallSummary(r.toolCalls),
        ...(includeTrace && r.trace ? { trace: r.trace } : {}),
      })),
      warnings: result.warnings,
    },
    null,
    2,
  );
}

export function agentResultToCSV(result: AgentABResult): string {
  const header = [
    "run_id",
    "task_id",
    "condition",
    "not_executed",
    "order_position",
    "seed",
    "model",
    "model_version",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "tool_call_count",
    "files_read",
    "bytes_read",
    "wall_time_ms",
    "api_latency_ms",
    "cost_usd",
    "cost_classification",
    "functional_success",
    "defects_introduced",
    "evaluation_kind",
    "evaluation_eligible",
    "tool_loop_exhausted",
    "finalization_error",
    "correct",
    "errors",
  ].join(",");

  const csv = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const rows = result.tasks.map((r) =>
    [
      r.run_id,
      r.task_id,
      r.condition,
      r.not_executed,
      r.order_position,
      r.seed,
      r.metrics.model,
      r.metrics.model_version ?? "",
      r.metrics.input_tokens,
      r.metrics.output_tokens,
      r.metrics.cached_tokens,
      r.metrics.reasoning_tokens,
      r.metrics.tool_call_count,
      r.metrics.files_read,
      r.metrics.bytes_read,
      r.metrics.wall_time_ms,
      r.metrics.api_latency_ms,
      r.metrics.cost_usd,
      r.metrics.cost_classification,
      r.metrics.functional_success,
      r.metrics.defects_introduced,
      r.evaluation_kind,
      r.evaluation_eligible,
      r.tool_loop_exhausted,
      csv(r.finalization_error),
      r.correct,
      csv((r.errors || []).join("; ")),
    ].join(","),
  );

  return [header, ...rows].join("\n") + "\n";
}

// ── External project label ──────────────────────────────────

export function externalProjectLabel(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  const leaf = path.basename(resolved);
  return leaf.toLowerCase() === "source"
    ? path.basename(path.dirname(resolved))
    : leaf;
}

export function classifyAgentABResultValidity(result: AgentABResult): {
  valid: boolean;
  reasons: string[];
  executed_runs: number;
  evaluated_runs: number;
  complete_pairs: number;
} {
  const reasons: string[] = [];
  const executed = result.tasks.filter((run) => !run.not_executed);
  const evaluated = executed.filter((run) => run.evaluation_eligible);
  const providerFailures = executed.filter((run) =>
    run.errors?.some((error) => error.startsWith("provider_request_failed:")),
  );
  const byPair = new Map<string, Set<AgentABRun["condition"]>>();

  for (const run of executed) {
    const key = run.task_id + ":" + run.seed + ":" + run.order_position;
    const conditions = byPair.get(key) || new Set<AgentABRun["condition"]>();
    conditions.add(run.condition);
    byPair.set(key, conditions);
  }

  const completePairs = [...byPair.values()].filter(
    (conditions) =>
      conditions.has("with_lynx") && conditions.has("without_lynx"),
  ).length;

  if (result.tasks.length === 0) reasons.push("no_runs");
  if (executed.length === 0) reasons.push("no_executed_runs");
  if (completePairs === 0) reasons.push("no_complete_pairs");
  if (providerFailures.length > 0) reasons.push("provider_request_failed");

  return {
    valid: reasons.length === 0,
    reasons,
    executed_runs: executed.length,
    evaluated_runs: evaluated.length,
    complete_pairs: completePairs,
  };
}


