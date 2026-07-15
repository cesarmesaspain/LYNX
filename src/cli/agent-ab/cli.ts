/* Command-line adapter for the agent A/B benchmark. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getApiKey } from './api-client.js';
import { readAgentABIndex, aggregateAgentABHistory } from './history.js';
import { autoSaveResult, lynxRoot } from './persistence.js';
import { agentResultToCSV, agentResultToJSON } from './output.js';
import { runAgentABBenchmark } from './benchmark.js';
import type { AgentABConfig, AgentABRun } from './types.js';

const AGENT_AB_DEFAULT_MODEL = 'deepseek-v4-flash';

interface ParsedCliArgs {
  config: Partial<AgentABConfig>;
  jsonFlag: boolean;
  csvFlag: boolean;
  includeTrace: boolean;
  chainedFlag: boolean;
  outPath: string | null;
  suite: "default" | "realistic" | "pilot";
  screeningLocal: boolean;
  screeningGroq: boolean;
}

function handleHistoryCommand(args: string[]): boolean {
  if (!args.includes("--history")) return false; // not a history command, continue
  const historyIndexIdx = args.indexOf("--history-index");
  if (historyIndexIdx !== -1 && !args[historyIndexIdx + 1]) {
    console.error("Error: --history-index requires a path.");
    process.exit(1);
  }
  const indexPath = historyIndexIdx !== -1
    ? path.resolve(args[historyIndexIdx + 1])
    : path.join(lynxRoot(), "benchmarks", "results", "_index.jsonl");
  const history = readAgentABIndex(indexPath);
  const aggregate = aggregateAgentABHistory(history.included);
  console.log(JSON.stringify({
    index_path: indexPath,
    index_exists: fs.existsSync(indexPath),
    hygiene: {
      total_lines: history.total_lines,
      included_count: history.included_count,
      excluded_count: history.excluded_count,
      excluded_by_reason: history.excluded_by_reason,
    },
    aggregate,
  }, null, 2));
  return true; // handled: caller should return
}

function parseAgentABCliArgs(args: string[]): ParsedCliArgs {
  const flag = (name: string) => args.includes(name);
  const val = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const screeningGroq = flag("--screening-groq");
  const screeningLocal = flag("--screening-local");
  const isPilot = flag("--pilot");
  if (screeningGroq && screeningLocal) {
    throw new Error("Use only one screening provider: --screening-groq or --screening-local.");
  }
  const isScreening = screeningGroq || screeningLocal;
  const localBaseUrl = val("--local-base-url") || "http://127.0.0.1:8011/v1";

  if (isPilot && (!val("--project-dir"))) {
    throw new Error("--pilot requires --project-dir pointing to the project to benchmark.");
  }

  if (flag("--html")) {
    console.error("Error: --html is not yet implemented.");
    process.exit(1);
  }

  return {
    screeningLocal,
    screeningGroq,
    config: {
      tier: isScreening ? "screening" : "official",
      seed: parseInt(val("--seed") || "42", 10) || 42,
      measuredRounds: Math.max(1, parseInt(val("--rounds") || "1", 10) || 1),
      warmupRounds: Math.max(0, parseInt(val("--warmup") || "0", 10) || 0),
      model: val("--model")
        || (screeningLocal ? "mlx-community/Qwen3.6-35B-A3B-4bit"
          : screeningGroq ? "meta-llama/llama-4-scout-17b-16e-instruct"
          : AGENT_AB_DEFAULT_MODEL),
      ...(screeningLocal
        ? { baseUrl: localBaseUrl, apiKey: "local-no-auth" }
        : screeningGroq
        ? { baseUrl: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY || "" }
        : {}),
      taskIds: val("--tasks")?.split(",").map(t => t.trim()).filter(Boolean),
      projectDir: val("--project-dir"),
      dryRun: flag("--dry-run"),
    },
    jsonFlag: flag("--json"),
    csvFlag: flag("--csv"),
    includeTrace: flag("--include-trace"),
    chainedFlag: flag("--chained"),
    outPath: val("--out") || null,
    suite: isPilot ? "pilot" : val("--suite") === "realistic" ? "realistic" : "default",
  };
}

// ── CLI entry ─────────────────────────────────────────────────

export async function cmdAgentABBenchmark(args: string[]): Promise<void> {
  if (handleHistoryCommand(args)) return;

  const { config, jsonFlag, csvFlag, includeTrace, chainedFlag, outPath, suite,
    screeningLocal, screeningGroq } = parseAgentABCliArgs(args);

  const isScreening = screeningLocal || screeningGroq;
  const isPilotMode = suite === "pilot";
  const hasKey = !!(config.apiKey || getApiKey());
  if (!hasKey && !config.dryRun) {
    console.error(
      screeningLocal
        ? "Local screening server is unavailable. Start it or set --local-base-url."
        : screeningGroq
        ? "No GROQ_API_KEY set. Running in dry-run mode (--dry-run implied)."
        : "No LYNX_DEEPSEEK_KEY or DEEPSEEK_API_KEY set. Running in dry-run mode (--dry-run implied).",
    );
    if (screeningLocal)
      console.error("Start the local OpenAI-compatible server before running screening.");
    else if (screeningGroq)
      console.error("Set GROQ_API_KEY to run experimental screening calls.");
    else
      console.error("Set LYNX_DEEPSEEK_KEY to run official DeepSeek calls.");
    config.dryRun = true;
  }

  const modeLabel = isPilotMode ? "PILOT" : screeningLocal ? "SCREENING-LOCAL" : screeningGroq ? "SCREENING" : "OFFICIAL";
  console.error(
    `LYNX agent-ab ${modeLabel} benchmark — seed=${config.seed} rounds=${config.measuredRounds} model=${config.model} ${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  // ── Live progress state ───────────────────────────────────
  let pairCount = 0;
  let totalPairs = 0;
  let roundNum = 0;
  const lastPair: Map<string, AgentABRun> = new Map(); // task_id -> first condition run

  const checkpointPath =
    outPath && !csvFlag
      ? outPath.endsWith(".json")
        ? outPath + ".checkpoint"
        : outPath + ".json.checkpoint"
      : undefined;

  const flush = (msg: string) => {
    process.stderr.write(msg + "\n");
  };

  const result = await runAgentABBenchmark(config, {
    includeTrace,
    chained: chainedFlag,
    checkpointPath,
    suite,
    onProgress: (evt) => {
      const r = evt.run;
      const statusTag = r.not_executed
        ? "DRY"
        : !r.evaluation_eligible
          ? "DESIGNED"
          : r.correct
            ? "PASS"
            : "FAIL";
      const toolsTag = r.metrics.tool_call_count;

      // Per-run line
      const roundForRun =
        Math.floor((evt.current - 1) / (evt.total / config.measuredRounds!)) +
        1;
      flush(
        `[${String(evt.current).padStart(3)}/${evt.total}] round=${roundForRun}/${config.measuredRounds} task=${r.task_id} condition=${r.condition} status=${statusTag} wall=${r.metrics.wall_time_ms}ms tools=${toolsTag} tokens=${r.metrics.input_tokens + r.metrics.output_tokens} cost=$${r.metrics.cost_usd.toFixed(6)}`,
      );

      // Pair summary
      const pairKey = `${r.task_id}_r${roundForRun}`;
      const mate = lastPair.get(pairKey);
      if (!mate) {
        lastPair.set(pairKey, r);
        totalPairs = Math.max(totalPairs, lastPair.size);
      } else {
        // Both conditions done for this task×round
        lastPair.delete(pairKey);
        pairCount++;
        const lynxRun = r.condition === "with_lynx" ? r : mate;
        const baselineRun = r.condition === "without_lynx" ? r : mate;
        const statusFor = (run: AgentABRun) =>
          run.not_executed
            ? "DRY"
            : !run.evaluation_eligible
              ? "DESIGNED"
              : run.correct
                ? "PASS"
                : "FAIL";
        const lynxOk = statusFor(lynxRun);
        const baselineOk = statusFor(baselineRun);
        const wallDelta =
          baselineRun.metrics.wall_time_ms > 0
            ? (
                ((lynxRun.metrics.wall_time_ms -
                  baselineRun.metrics.wall_time_ms) /
                  baselineRun.metrics.wall_time_ms) *
                100
              ).toFixed(0)
            : "0";
        const deltaSign = Number(wallDelta) <= 0 ? "" : "+";
        flush(
          `  [pair ${pairCount}] ${r.task_id}: LYNX ${lynxRun.metrics.wall_time_ms}ms ${lynxOk} vs baseline ${baselineRun.metrics.wall_time_ms}ms ${baselineOk} | delta=${deltaSign}${wallDelta}%`,
        );
      }

      // Round completion summary
      if (pairCount === totalPairs && lastPair.size === 0 && totalPairs > 0) {
        roundNum++;
        const wRuns = evt.allRuns.filter((x) => x.condition === "with_lynx");
        const woRuns = evt.allRuns.filter(
          (x) => x.condition === "without_lynx",
        );
        if (wRuns.length > 0 && woRuns.length > 0) {
          const wOk = wRuns.filter((x) => x.correct || x.not_executed).length;
          const woOk = woRuns.filter((x) => x.correct || x.not_executed).length;
          const wCost = wRuns.reduce((s, x) => s + x.metrics.cost_usd, 0);
          const woCost = woRuns.reduce((s, x) => s + x.metrics.cost_usd, 0);
          const wWall = wRuns
            .map((x) => x.metrics.wall_time_ms)
            .sort((a, b) => a - b);
          const woWall = woRuns
            .map((x) => x.metrics.wall_time_ms)
            .sort((a, b) => a - b);
          const medW = wWall[Math.floor(wWall.length / 2)];
          const medWo = woWall[Math.floor(woWall.length / 2)];
          flush(
            `[round ${roundNum}/${config.measuredRounds} complete] LYNX: ${wOk}/${wRuns.length} ok median=${medW}ms cost=$${wCost.toFixed(6)} | baseline: ${woOk}/${woRuns.length} ok median=${medWo}ms cost=$${woCost.toFixed(6)}`,
          );
        }
        totalPairs = 0;
      }
    },
  });

  const noFormatFlag = !jsonFlag && !csvFlag;

  if (csvFlag) {
    const content = agentResultToCSV(result);
    if (outPath) {
      const filePath = outPath.endsWith(".csv") ? outPath : `${outPath}.csv`;
      fs.writeFileSync(filePath, content);
      console.error(`Wrote ${filePath}`);
    } else {
      console.log(content);
    }
  }

  if (jsonFlag || noFormatFlag) {
    const content = agentResultToJSON(result, includeTrace);
    if (outPath && !csvFlag) {
      const filePath = outPath.endsWith(".json") ? outPath : `${outPath}.json`;
      fs.writeFileSync(filePath, content);
      // Remove checkpoint on clean finish
      if (checkpointPath) {
        try {
          fs.rmSync(checkpointPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      console.error(`Wrote ${filePath}`);
    } else if (!csvFlag) {
      console.log(content);
    }
  }

  const s = result.summary;
  if (result.tasks.every((r) => r.not_executed)) {
    console.error("\nAll runs: not_executed (dry-run)");
  } else {
    console.error(
      `\nWith LYNX:    ${s.with_lynx.wall_time_ms.median}ms median, ${(s.with_lynx.functional_success_rate * 100).toFixed(0)}% success`,
    );
    console.error(
      `Without LYNX: ${s.without_lynx.wall_time_ms.median}ms median, ${(s.without_lynx.functional_success_rate * 100).toFixed(0)}% success`,
    );
  }
  if (s.roi_blocked) {
    console.error(`ROI: BLOCKED — ${s.roi_blocked_reason}`);
  }

  for (const w of result.warnings) {
    console.error(`WARNING: ${w}`);
  }

  // Auto-save to benchmarks/results/ regardless of --out
  if (!config.dryRun) {
    try {
      autoSaveResult(result, outPath, null);
    } catch (err) {
      console.error(`Auto-save failed: ${String(err)}`);
    }
  }
}
