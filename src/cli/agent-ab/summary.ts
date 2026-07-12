/* Statistical summary for agent A/B benchmark runs. */

import type { AgentABConfig, AgentABRun, AgentABSummary } from './types.js';

// ── Summary builder ───────────────────────────────────────────

export function buildAgentSummary(
  withRuns: AgentABRun[],
  withoutRuns: AgentABRun[],
  taskCount: number,
  config: AgentABConfig,
): AgentABSummary {
  const withWall = withRuns.map((r) => r.metrics.wall_time_ms);
  const withoutWall = withoutRuns.map((r) => r.metrics.wall_time_ms);
  const withInput = withRuns.map((r) => r.metrics.input_tokens);
  const withoutInput = withoutRuns.map((r) => r.metrics.input_tokens);
  const withOutput = withRuns.map((r) => r.metrics.output_tokens);
  const withoutOutput = withoutRuns.map((r) => r.metrics.output_tokens);
  const withTools = withRuns.map((r) => r.metrics.tool_call_count);
  const withoutTools = withoutRuns.map((r) => r.metrics.tool_call_count);
  const withCost = withRuns.map((r) => r.metrics.cost_usd);
  const withoutCost = withoutRuns.map((r) => r.metrics.cost_usd);

  const sort = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const med = (arr: number[]) => {
    const s = sort(arr);
    return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
  };
  const p95 = (arr: number[]) => {
    const s = sort(arr);
    return s.length === 0
      ? 0
      : s[Math.ceil(s.length * 0.95) - 1] || s[s.length - 1];
  };
  const total = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const withEvaluated = withRuns.filter((r) => r.evaluation_eligible);
  const withoutEvaluated = withoutRuns.filter((r) => r.evaluation_eligible);
  const withDeterministic = withRuns.filter(
    (r) => r.evaluation_kind === "deterministic" && r.evaluation_eligible,
  );
  const withoutDeterministic = withoutRuns.filter(
    (r) => r.evaluation_kind === "deterministic" && r.evaluation_eligible,
  );
  const withCorrect = withEvaluated.filter((r) => r.correct).length;
  const withoutCorrect = withoutEvaluated.filter((r) => r.correct).length;

  // buildCond uses its OWN runs for defects_per_task — FIXED from previous version
  const buildCond = (
    runs: AgentABRun[],
    wall: number[],
    inputT: number[],
    outputT: number[],
    tools: number[],
    cost: number[],
    correct: number,
    totalRuns: number,
  ) => ({
    wall_time_ms: { median: med(wall), p95: p95(wall) },
    input_tokens: { median: med(inputT), total: total(inputT) },
    output_tokens: { median: med(outputT), total: total(outputT) },
    cached_tokens: {
      median: med(runs.map((r) => r.metrics.cached_tokens)),
      total: total(runs.map((r) => r.metrics.cached_tokens)),
    },
    reasoning_tokens: {
      median: med(runs.map((r) => r.metrics.reasoning_tokens)),
      total: total(runs.map((r) => r.metrics.reasoning_tokens)),
    },
    tool_calls: { median: med(tools), total: total(tools) },
    cost_usd: { median: med(cost), total: total(cost) },
    functional_success_rate: totalRuns > 0 ? correct / totalRuns : 0,
    evaluated_runs: totalRuns,
    excluded_from_evaluation: runs.length - totalRuns,
    defects_per_task:
      totalRuns > 0
        ? total(
            runs
              .filter((r) => r.evaluation_eligible)
              .map((r) => r.metrics.defects_introduced),
          ) / totalRuns
        : 0,
  });

  const withCond = buildCond(
    withRuns,
    withWall,
    withInput,
    withOutput,
    withTools,
    withCost,
    withCorrect,
    withEvaluated.length,
  );
  const withoutCond = buildCond(
    withoutRuns,
    withoutWall,
    withoutInput,
    withoutOutput,
    withoutTools,
    withoutCost,
    withoutCorrect,
    withoutEvaluated.length,
  );

  const pctDelta = (a: number, b: number) => {
    if (b === 0) return a === 0 ? "0%" : "N/A";
    return `${(((a - b) / b) * 100).toFixed(1)}%`;
  };

  const notExecuted =
    withRuns.every((r) => r.not_executed) ||
    withoutRuns.every((r) => r.not_executed);

  const comparison = [
    {
      metric: "Median wall time",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.wall_time_ms.median}ms`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.wall_time_ms.median}ms`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.wall_time_ms.median,
            withoutCond.wall_time_ms.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no measurements taken"
        : "Wall time including API latency",
    },
    {
      metric: "Input tokens (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.input_tokens.median}`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.input_tokens.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.input_tokens.median,
            withoutCond.input_tokens.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no tokens consumed"
        : "Input tokens from API usage",
    },
    {
      metric: "Output tokens (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.output_tokens.median}`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.output_tokens.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.output_tokens.median,
            withoutCond.output_tokens.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no tokens consumed"
        : "Output tokens from API usage",
    },
    {
      metric: "Tool calls (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.tool_calls.median}`,
      without_lynx: notExecuted ? "N/A" : `${withoutCond.tool_calls.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(withCond.tool_calls.median, withoutCond.tool_calls.median),
      interpretation: notExecuted
        ? "Dry run — no tool calls"
        : "Number of tool call turns",
    },
    {
      metric: "Cost USD (median)",
      class: "estimated" as const,
      with_lynx: notExecuted
        ? "N/A"
        : `$${withCond.cost_usd.median.toFixed(6)}`,
      without_lynx: notExecuted
        ? "N/A"
        : `$${withoutCond.cost_usd.median.toFixed(6)}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(withCond.cost_usd.median, withoutCond.cost_usd.median),
      interpretation: notExecuted
        ? "Dry run — no cost"
        : "Estimated from token usage and published pricing",
    },
    {
      metric: "Functional success rate",
      class: "measured" as const,
      with_lynx: notExecuted
        ? "N/A"
        : `${(withCond.functional_success_rate * 100).toFixed(0)}%`,
      without_lynx: notExecuted
        ? "N/A"
        : `${(withoutCond.functional_success_rate * 100).toFixed(0)}%`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.functional_success_rate,
            withoutCond.functional_success_rate,
          ),
      interpretation: notExecuted
        ? "Dry run — not evaluated"
        : "Correctness of task results vs expected",
    },
  ];

  // Partial assertions remain useful operational evidence, but cannot unlock ROI.
  const sampleSize = Math.min(
    withDeterministic.length,
    withoutDeterministic.length,
  );
  const roiBlocked = sampleSize < 6 || config.dryRun;

  return {
    with_lynx: withCond,
    without_lynx: withoutCond,
    comparison,
    sample_size_note: config.dryRun
      ? "DRY RUN — no API calls were executed. All metrics are N/A."
      : `Based on ${sampleSize} deterministic measured runs with real API calls (${Math.min(withEvaluated.length, withoutEvaluated.length)} evaluated including partial assertions).`,
    roi_blocked: roiBlocked,
    roi_blocked_reason: roiBlocked
      ? config.dryRun
        ? "Dry run — no real API cost data."
        : `Deterministic sample size too small (${sampleSize} runs). Need at least 6.`
      : null,
  };
}

