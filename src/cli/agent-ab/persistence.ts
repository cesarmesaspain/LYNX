/*
 * persistence.ts — auto-save benchmark results to disk.
 *
 * Extracted from benchmark.ts to reduce file size and isolate I/O.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentABResult, AgentABRun } from "./types.js";
import { toolCallSummary } from "./benchmark.js";
import { externalProjectLabel } from "./benchmark.js";
import { classifyAgentABResultValidity } from "./benchmark.js";

/** Locate the LYNX project root by walking up from the process entry point. */
export function lynxRoot(): string {
  let dir = path.dirname(process.argv[1] || process.cwd());
  for (let i = 0; i < 4; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function autoSaveResult(
  result: AgentABResult,
  outPath: string | null,
  stderrPath: string | null,
): void {
  const root = lynxRoot();
  const resultsDir = result.config.tier === "screening"
    ? path.join(root, "benchmarks", "results", "screening")
    : path.join(root, "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const projectLabel = result.config.projectDir
    ? externalProjectLabel(result.config.projectDir)
    : (result.config as any).suite || "default";
  const seed = result.config.seed;
  const baseName = `${ts}_${projectLabel}_seed${seed}`;

  // 1. Full JSON
  const jsonPath = path.join(resultsDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // 2. Responses artifact
  const responses: Record<string, unknown> = {
    generated: now.toISOString(),
    project: projectLabel,
    seed,
    model: result.config.model,
    tier: result.config.tier,
    tasks: [] as Record<string, unknown>[],
  };
  const byTask = new Map<string, AgentABRun[]>();
  for (const run of result.tasks) {
    const list = byTask.get(run.task_id) || [];
    list.push(run);
    byTask.set(run.task_id, list);
  }
  for (const [taskId, runs] of byTask) {
    const lynxRun = runs.find((r) => r.condition === "with_lynx");
    const baselineRun = runs.find((r) => r.condition === "without_lynx");
    (responses.tasks as Array<Record<string, unknown>>).push({
      task_id: taskId,
      lynx: lynxRun ? {
        response: lynxRun.response,
        wall_ms: lynxRun.metrics.wall_time_ms,
        tool_calls: lynxRun.metrics.tool_call_count,
        tool_call_summary: toolCallSummary(lynxRun.toolCalls),
        input_tokens: lynxRun.metrics.input_tokens,
        cost_usd: lynxRun.metrics.cost_usd,
        errors: lynxRun.errors,
        tool_loop_exhausted: lynxRun.tool_loop_exhausted,
        finalization_error: lynxRun.finalization_error,
      } : null,
      baseline: baselineRun ? {
        response: baselineRun.response,
        wall_ms: baselineRun.metrics.wall_time_ms,
        tool_calls: baselineRun.metrics.tool_call_count,
        tool_call_summary: toolCallSummary(baselineRun.toolCalls),
        input_tokens: baselineRun.metrics.input_tokens,
        cost_usd: baselineRun.metrics.cost_usd,
        errors: baselineRun.errors,
      } : null,
    });
  }
  fs.writeFileSync(
    path.join(resultsDir, `${baseName}.responses.json`),
    JSON.stringify(responses, null, 2),
  );

  // 3. Append to index
  const idxPath = path.join(resultsDir, "_index.jsonl");
  const lynxCost = result.summary.with_lynx.cost_usd?.total ?? 0;
  const baselineCost = result.summary.without_lynx.cost_usd?.total ?? 0;
  const validity = classifyAgentABResultValidity(result);
  const indexEntry = {
    timestamp: now.toISOString(),
    base_name: baseName,
    project: projectLabel,
    seed,
    model: result.config.model,
    tier: result.config.tier,
    tasks: result.tasks.length,
    valid: validity.valid,
    invalid_reasons: validity.reasons,
    executed_runs: validity.executed_runs,
    evaluated_runs: validity.evaluated_runs,
    complete_pairs: validity.complete_pairs,
    lynx: {
      success_rate: result.summary.with_lynx.functional_success_rate,
      median_wall_ms: result.summary.with_lynx.wall_time_ms?.median ?? 0,
      total_cost_usd: lynxCost,
    },
    baseline: {
      success_rate: result.summary.without_lynx.functional_success_rate,
      median_wall_ms: result.summary.without_lynx.wall_time_ms?.median ?? 0,
      total_cost_usd: baselineCost,
    },
    context_limit_hit: result.tasks.some(
      (r) => r.condition === "without_lynx" && r.errors?.some((e) => e.includes("maximum context length")),
    ),
  };
  fs.appendFileSync(idxPath, JSON.stringify(indexEntry) + "\n");

  const stderr = outPath ? ` (also at ${outPath})` : "";
  console.error(`Saved ${baseName}.json${stderr}`);
  console.error(`Index: ${idxPath}`);

  if (stderrPath && fs.existsSync(stderrPath)) {
    try {
      fs.copyFileSync(stderrPath, path.join(resultsDir, `${baseName}.log`));
    } catch { /* best effort */ }
  }
}
