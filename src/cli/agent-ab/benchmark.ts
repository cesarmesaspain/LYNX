/*
 * agent-ab/benchmark.ts — LLM agent A/B benchmark.
 *
 * 5 deterministic tasks through DeepSeek LLM agent.
 * ONLY difference between conditions: LYNX tools exposed or not.
 *
 * Fresh conversation per task × condition × run. No shared history or cache.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { LynxDatabase } from "../../store/database.js";
import { runPipeline } from "../../pipeline/orchestrator.js";
import { setDb } from "../../mcp/server.js";
import { clearFederatedConfig } from "../../federation/handler-bridge.js";
import { clearSessionDedup } from "../../usage/metrics.js";
import {
  chatCompletion,
  computeCost,
  getApiKey,
  redactSecrets,
  sha256Hash,
  DEFAULT_BASE_URL,
} from "./api-client.js";
import { AGENT_AB_DEFAULT_MODEL, generateRunId, getSharedParams, SYSTEM_PROMPT, type ProgressCallback, type ProgressEvent, evaluationKind } from './runtime.js';
export type { ProgressEvent, ProgressCallback } from './runtime.js';
export { isEvaluationEligible } from './runtime.js';
import { isEvaluationEligible } from './runtime.js';
export { makeBaselineTools, makeLynxTools } from './tool-definitions.js';
import { makeBaselineTools, makeLynxTools } from './tool-definitions.js';
export { cmdAgentABBenchmark } from './cli.js';
import {
  evaluateExternalDeadCodeResponse, evaluateResponse, executeBaselineTool, executeLynxTool,
  makeExternalProjectTasks, seededRandom, shuffle, EXTERNAL_TASK_TOOL_PROFILES, TASKS, type BenchmarkTask,
} from './execution-support.js';
export { evaluateExternalDeadCodeResponse, evaluateExternalScalabilityResponse } from './execution-support.js';
export type { BenchmarkTask } from './execution-support.js';
import { buildAgentSummary } from './summary.js';
import { agentResultToJSON } from './output.js';
export { agentResultToCSV, agentResultToJSON, classifyAgentABResultValidity, externalProjectLabel, toolCallSummary } from './output.js';
import type {
  AgentABConfig,
  AgentABRun,
  AgentABResult,
  AgentMessage,
  AgentToolCall,
  AgentToolDefinition,
  ApiUsage,
  ToolTraceStep,
  EvaluationKind,
} from "./types.js";
import { assertPaidMicrobenchmarkProtocol } from "./experiment.js";
import { generateFixture } from '../ab-benchmark.js';

// ── Main runner ───────────────────────────────────────────────

export async function runAgentABBenchmark(
  configOverrides: Partial<AgentABConfig> = {},
  runOpts: {
    includeTrace?: boolean;
    onProgress?: ProgressCallback;
    checkpointPath?: string;
    suite?: "default" | "realistic";
    chained?: boolean;
  } = {},
): Promise<AgentABResult> {
  const apiKey = configOverrides.apiKey || getApiKey();
  const isDryRun = configOverrides.dryRun === true || !apiKey;
  const isRealistic = runOpts.suite === "realistic";
  const isChained = !!runOpts.chained;

  const config: AgentABConfig = {
    tier: configOverrides.tier ?? "official",
    seed: configOverrides.seed ?? 42,
    model: configOverrides.model ?? AGENT_AB_DEFAULT_MODEL,
    baseUrl: configOverrides.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: apiKey || "",
    systemPrompt: configOverrides.systemPrompt ?? SYSTEM_PROMPT,
    temperature: configOverrides.temperature ?? 0.0,
    maxTokens:
      configOverrides.maxTokens ??
      (configOverrides.tier === "screening" ? 1024 : undefined),
    maxToolCalls:
      configOverrides.maxToolCalls ??
      (configOverrides.projectDir ? 8 : configOverrides.tier === "screening" ? 12 : undefined),
    timeoutMs: configOverrides.timeoutMs,
    maxRetries: configOverrides.maxRetries,
    warmupRounds: configOverrides.warmupRounds ?? 0,
    measuredRounds: configOverrides.measuredRounds ?? 1,
    taskIds: configOverrides.taskIds,
    fixtureDir: configOverrides.fixtureDir,
    projectDir: configOverrides.projectDir,
    dryRun: isDryRun,
  };
  const isExternalProject = !!config.projectDir;

  // A live benchmark is a paid microbenchmark: do not permit model/provider
  // substitutions or stochastic configuration drift.
  if (!isDryRun && config.tier === "official") {
    assertPaidMicrobenchmarkProtocol(config);
  }

  const warnings: string[] = [];
  if (isDryRun && !configOverrides.dryRun) {
    warnings.push(
      "No API key configured — running in dry-run mode (not_executed).",
    );
  }
  if (config.measuredRounds < 3 && !isDryRun) {
    warnings.push(
      `Only ${config.measuredRounds} measured round(s). At least 3 recommended.`,
    );
  }

  // ── Setup isolated environment ──────────────────────────────
  // The benchmark always owns baseDir. projectDir is read-only input and must
  // never be placed under a directory cleaned up by this runner.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-agent-ab-"));
  const originalLynxHome = process.env.LYNX_HOME;
  const tempLynxHome = path.join(baseDir, "lynx-home");
  process.env.LYNX_HOME = tempLynxHome;
  fs.mkdirSync(tempLynxHome, { recursive: true });

  let db: LynxDatabase | null = null;
  const project = config.projectDir
    ? `agent-ab-external-${sha256Hash(path.resolve(config.projectDir))}`
    : "agent-ab-fixture";

  // ── Suite selection ─────────────────────────────────────────
  let tasks: BenchmarkTask[];
  let suiteOverrides: {
    lynxTools?: AgentToolDefinition[];
    lynxToolsForTask?: (task: BenchmarkTask) => AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
      task?: BenchmarkTask,
    ) => Promise<string>;
  } = {};
  let validatePreflight:
    ((fixtureDir: string) => { ok: boolean; errors: string[] }) | undefined;

  if (config.projectDir) {
    const projectDir = path.resolve(config.projectDir);
    const projectLabel = path.basename(projectDir);
    if (!fs.statSync(projectDir).isDirectory())
      throw new Error(`External project is not a directory: ${projectDir}`);
    tasks = makeExternalProjectTasks(projectLabel).filter(
      (task) => task.id !== 'external_missing_tests',
    );
    warnings.push(
      'External suite excludes untested-symbol discovery until it has a dedicated, verifiable graph operation.',
    );
    if (config.taskIds)
      tasks = tasks.filter((task) => config.taskIds!.includes(task.id));
    const realistic = await import("./realistic-suite.js");
    const allTools = realistic.makeLynxToolsRealistic();
    // Free/local screening is a directional filter, not a production-equivalent
    // catalogue test. Keep the tools needed by the external workflows so a
    // provider's small TPM allowance is not exhausted by unused schemas.
    const screeningTools = new Set<string>(["read_file"]);
    const toolsByTask = EXTERNAL_TASK_TOOL_PROFILES;
    for (const task of tasks) {
      for (const tool of toolsByTask[task.id] || []) screeningTools.add(tool);
    }
    suiteOverrides = {
      lynxToolsForTask: (task) => allTools.filter((tool) =>
        (toolsByTask[task.id] || ['read_file']).includes(tool.function.name) &&
        (config.tier !== "screening" || screeningTools.has(tool.function.name))
      ),
      lynxExecutor: (toolName, args, toolProject, fixtureDir, task) => {
        if (task?.id === 'external_dead_code' && toolName === 'find_dead_code') {
          args = { ...args, limit: Math.min(5, Number(args.limit) || 5) };
        }
        return realistic.executeLynxToolRealistic(toolName, args, toolProject, fixtureDir);
      },
    };
    if (config.tier === "screening") {
      warnings.push(
        `Screening uses a task-specific compact tool profile (${[...screeningTools].join(", ")}); official runs expose the full catalogue.`,
      );
    }
    warnings.push(
      `External project mode: read-only source at ${projectDir}; LYNX state remains temporary.`,
    );
  } else if (isRealistic) {
    const realistic = await import("./realistic-suite.js");
    tasks = realistic.TASKS_REALISTIC as BenchmarkTask[];
    suiteOverrides = {
      lynxTools: realistic.makeLynxToolsRealistic(),
      lynxExecutor: realistic.executeLynxToolRealistic,
    };
    validatePreflight = (fixtureDir) =>
      realistic.validateRealisticSuitePreflight(
        fixtureDir,
        realistic.makeLynxToolsRealistic().map((tool) => tool.function.name),
      );
    warnings.push(
      `Realistic suite: ${realistic.TASKS_REALISTIC.length} tasks, ${realistic.makeLynxToolsRealistic().length} LYNX tools.`,
    );
    const designedOnly = realistic.designedOnlyTools();
    if (designedOnly.length > 0) {
      warnings.push(
        `Designed-only tools (no deterministic assertion): ${designedOnly.join(", ")}`,
      );
    }
    const cov = realistic.coverageSummary();
    const taskKinds = realistic.taskEvaluationSummary(
      tasks as typeof realistic.TASKS_REALISTIC,
    );
    warnings.push(
      `Coverage: ${cov.executable} executable, ${cov.designed_only} designed-only, ${cov.excluded} excluded (${cov.total} total).`,
    );
    warnings.push(
      `Evaluation: ${taskKinds.deterministic} deterministic, ${taskKinds.partial} partial, ${taskKinds["designed-only"]} designed-only tasks.`,
    );
  } else {
    tasks = config.taskIds
      ? TASKS.filter((t) => config.taskIds!.includes(t.id))
      : TASKS;
  }

  // Allow taskIds to further filter the selected suite
  if (config.taskIds && isRealistic) {
    tasks = tasks.filter((t) => config.taskIds!.includes(t.id));
  }

  try {
    const fixtureDir = config.projectDir
      ? path.resolve(config.projectDir)
      : generateFixture(config.fixtureDir || baseDir);

    db = LynxDatabase.openProject(project);
    await runPipeline(db, fixtureDir, project, {
      mode: "fast",
      incremental: false,
      testSkipProjectBrief: true,
    });
    setDb(project, db);
    clearSessionDedup(project);
    const preflight = validatePreflight?.(fixtureDir);
    if (preflight && !preflight.ok) {
      throw new Error(
        `Realistic benchmark preflight failed: ${preflight.errors.join("; ")}`,
      );
    }
    if (preflight)
      warnings.push(
        "Realistic preflight passed: fixture, expectations, tool exposure, and coverage manifest are synchronized.",
      );

    // ── Counterbalanced order ──────────────────────────────
    const rng = seededRandom(config.seed);
    const shuffledTasks = shuffle(tasks, rng);
    const midPoint = Math.ceil(shuffledTasks.length / 2);
    const orderings: Array<{
      task: (typeof TASKS)[0];
      order: Array<"with_lynx" | "without_lynx">;
    }> = [];
    for (let i = 0; i < shuffledTasks.length; i++) {
      if (i < midPoint) {
        orderings.push({
          task: shuffledTasks[i],
          order: ["with_lynx", "without_lynx"],
        });
      } else {
        orderings.push({
          task: shuffledTasks[i],
          order: ["without_lynx", "with_lynx"],
        });
      }
    }

    // ── Warmup rounds (only if not dry run) ────────────────
    if (!isDryRun && config.warmupRounds > 0) {
      for (let w = 0; w < config.warmupRounds; w++) {
        if (isChained) {
          const taskPairs: [BenchmarkTask, BenchmarkTask][] = [];
          for (let i = 0; i < tasks.length; i += 2) {
            if (i + 1 < tasks.length) taskPairs.push([tasks[i], tasks[i + 1]]);
          }
          for (const pair of taskPairs) {
            for (const condition of [
              "with_lynx",
              "without_lynx",
            ] as const) {
              await runChainedAgentTasks(
                pair,
                condition,
                config,
                project,
                fixtureDir,
                false,
                suiteOverrides,
              );
            }
          }
        } else {
          for (const { task, order } of orderings) {
            for (const condition of order) {
              await runSingleAgentTask(
                task,
                condition,
                config,
                project,
                fixtureDir,
                false,
                suiteOverrides,
              );
            }
          }
        }
      }
    }

    // ── Measured rounds ───────────────────────────────────
    const totalMeasured = isDryRun ? 1 : config.measuredRounds;
    const totalRuns = totalMeasured * orderings.length * 2; // 2 conditions per task
    const { onProgress, checkpointPath } = runOpts;
    const allRuns: AgentABRun[] = [];

    // Resume only checkpoints created for the exact same experiment. A completed
    // task/condition/seed tuple is never paid for twice.
    if (checkpointPath && fs.existsSync(checkpointPath)) {
      try {
        const checkpoint = JSON.parse(
          fs.readFileSync(checkpointPath, "utf-8"),
        ) as AgentABResult;
        const checkpointConfig = checkpoint.config as AgentABConfig;
        const sameTaskIds =
          JSON.stringify(checkpointConfig.taskIds ?? []) ===
          JSON.stringify(config.taskIds ?? []);
        const compatible =
          checkpointConfig.seed === config.seed &&
          checkpointConfig.model === config.model &&
          checkpointConfig.projectDir === config.projectDir &&
          checkpointConfig.measuredRounds === config.measuredRounds &&
          sameTaskIds;
        if (compatible && Array.isArray(checkpoint.tasks)) {
          const selectedTaskIds = new Set(tasks.map((task) => task.id));
          for (const run of checkpoint.tasks) {
            if (selectedTaskIds.has(run.task_id) && !run.not_executed)
              allRuns.push(run);
          }
          if (allRuns.length > 0)
            warnings.push(
              `Resumed ${allRuns.length} completed run(s) from checkpoint; completed API calls were not repeated.`,
            );
        }
      } catch {
        warnings.push(
          "Existing checkpoint could not be resumed safely and was ignored.",
        );
      }
    }

    const completedRunKeys = new Set(
      allRuns.map((run) => `${run.task_id}|${run.condition}|${run.seed}`),
    );

    const writeCheckpoint = () => {
      if (!checkpointPath) return;
      const partial: AgentABResult = {
        config: (() => {
          const { apiKey: _, ...safe } = config;
          return safe;
        })(),
        methodology: ["checkpoint — benchmark in progress"],
        tasks: [...allRuns],
        summary: buildAgentSummary(
          allRuns.filter((r) => r.condition === "with_lynx"),
          allRuns.filter((r) => r.condition === "without_lynx"),
          tasks.length,
          config,
        ),
        warnings,
      };
      const tmp = checkpointPath + ".tmp";
      fs.writeFileSync(tmp, agentResultToJSON(partial, !!runOpts.includeTrace));
      fs.renameSync(tmp, checkpointPath);
    };

    for (let r = 0; r < totalMeasured; r++) {
      if (isChained) {
        // Chained mode: pair tasks [t0,t1], [t2,t3], ... each pair shares one conversation
        const taskPairs: [BenchmarkTask, BenchmarkTask][] = [];
        for (let i = 0; i < tasks.length; i += 2) {
          if (i + 1 < tasks.length) taskPairs.push([tasks[i], tasks[i + 1]]);
        }
        if (taskPairs.length === 0) {
          throw new Error(
            "Chained mode requires at least 2 tasks to form a pair",
          );
        }
        const chainedTotal = totalMeasured * taskPairs.length * 2; // 2 conditions per pair
        for (let pi = 0; pi < taskPairs.length; pi++) {
          for (const condition of ["with_lynx", "without_lynx"] as const) {
            const roundSeed = config.seed + r * 1000;
            const runKey = `${taskPairs[pi][0].id}+${taskPairs[pi][1].id}|${condition}|${roundSeed}`;
            if (completedRunKeys.has(runKey)) continue;
            const roundConfig = { ...config, seed: roundSeed };
            const pairRuns = await runChainedAgentTasks(
              taskPairs[pi],
              condition,
              roundConfig,
              project,
              fixtureDir,
              !!runOpts.includeTrace,
              suiteOverrides,
            );
            for (let j = 0; j < pairRuns.length; j++) {
              pairRuns[j].order_position = pi * 2 + j;
              pairRuns[j].seed = config.seed + r * 1000;
              allRuns.push(pairRuns[j]);
            }

            if (checkpointPath) writeCheckpoint();
            if (onProgress) {
              onProgress({
                current: allRuns.length,
                total: chainedTotal,
                run: pairRuns[0],
                allRuns: [...allRuns],
              });
            }
          }
        }
      } else {
        for (let pos = 0; pos < orderings.length; pos++) {
          const { task, order } = orderings[pos];
          for (const condition of order) {
            const roundSeed = config.seed + r * 1000;
            const runKey = `${task.id}|${condition}|${roundSeed}`;
            if (completedRunKeys.has(runKey)) continue;
            const roundConfig = { ...config, seed: roundSeed };
            const run = await runSingleAgentTask(
              task,
              condition,
              roundConfig,
              project,
              fixtureDir,
              !!runOpts.includeTrace,
              suiteOverrides,
            );
            run.order_position = pos;
            run.seed = config.seed + r * 1000;
            allRuns.push(run);

            if (checkpointPath) writeCheckpoint();
            if (onProgress) {
              onProgress({
                current: allRuns.length,
                total: totalRuns,
                run,
                allRuns: [...allRuns],
              });
            }
          }
        }
      }
    }

    const withRuns = allRuns.filter((r) => r.condition === "with_lynx");
    const withoutRuns = allRuns.filter((r) => r.condition === "without_lynx");
    const summary = buildAgentSummary(
      withRuns,
      withoutRuns,
      tasks.length,
      config,
    );
    const screeningToolNames = (suiteOverrides.lynxTools || [])
      .map((tool) => tool.function.name)
      .join(", ");

    return {
      config: (() => {
        const { apiKey: _, ...safe } = config;
        return safe;
      })(),
      methodology: [
        isExternalProject
          ? `One read-only external-project analysis task executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent; it is operationally measured but not success-scored.`
          : isRealistic
            ? `${tasks.filter((t) => evaluationKind(t) === "deterministic").length} deterministic, ${tasks.filter((t) => evaluationKind(t) === "partial").length} partial, and ${tasks.filter((t) => evaluationKind(t) === "designed-only").length} designed-only tasks (5 core + 10 workflow) executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent.`
            : `5 deterministic tasks executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent.`,
        isRealistic || isExternalProject
          ? config.tier === "screening"
            ? `with_lynx: LLM has access to a task-specific compact LYNX profile (${screeningToolNames}).`
            : "with_lynx: LLM has access only to the task-specific LYNX tool profile plus read_file."
          : "with_lynx: LLM has access to LYNX graph tools (search_graph, trace_path, explain_symbol, find_tests) + read_file.",
        "without_lynx: LLM has access to read_file + grep only.",
        "Fresh conversation per task x condition x run. No shared history or cache between conditions.",
        config.tier === "screening"
          ? "Screening tier: provider/model results are exploratory only and are excluded from the official DeepSeek history and acceptance decisions."
          : "Paid microbenchmark protocol: exact deepseek-v4-flash, temperature 0, fixed per-round seeds, identical prompts/order/limits/runtime; no model or provider fallback.",
        `Mode: ${isDryRun ? "dry-run (not_executed)" : "live API calls"}. Suite: ${isExternalProject ? "external-project" : isRealistic ? "realistic" : "default"}.`,
        config.tier === "screening"
          ? "Screening cost is not comparable to the official pricing series. Wall time includes API latency."
          : "Cost is estimated from token usage and configured pricing. Wall time includes API latency.",
        ...(isExternalProject && config.maxToolCalls !== undefined
          ? [`External-project budget: each condition is capped at ${config.maxToolCalls} tool calls per task to prevent an unsupported workflow from consuming unbounded paid context.`]
          : []),
        "ROI claims blocked when baseline invalid or sample size too small.",
      ],
      tasks: allRuns,
      summary,
      warnings,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    clearFederatedConfig();
    clearSessionDedup(project);
    if (originalLynxHome !== undefined) {
      process.env.LYNX_HOME = originalLynxHome;
    } else {
      delete process.env.LYNX_HOME;
    }
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Single task runner ────────────────────────────────────────

async function runSingleAgentTask(
  task: BenchmarkTask,
  condition: "with_lynx" | "without_lynx",
  config: AgentABConfig,
  project: string,
  fixtureDir: string,
  includeTrace: boolean,
  overrides?: {
    lynxTools?: AgentToolDefinition[];
    lynxToolsForTask?: (task: BenchmarkTask) => AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
      task?: BenchmarkTask,
    ) => Promise<string>;
  },
): Promise<AgentABRun> {
  const runId = generateRunId();
  const isWithLynx = condition === "with_lynx";

  // Fresh messages array per run — deep copy to guarantee isolation
  const messages: AgentMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: task.userPrompt },
  ];

  const tools = isWithLynx
    ? (overrides?.lynxToolsForTask?.(task) ?? overrides?.lynxTools ?? makeLynxTools())
    : makeBaselineTools();
  const shared = getSharedParams(config);

  let usage: ApiUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let modelVersion: string | null = null;
  let apiLatency = 0;
  let responseContent = "";
  let allToolCalls: AgentToolCall[] = [];
  const filesRead = new Set<string>();
  let bytesRead = 0;
  let notExecuted = false;
  let notExecutedReason: string | undefined;
  let toolLoopExhausted = false;
  let finalizationError: string | undefined;
  const executionErrors: string[] = [];
  const traceSteps: ToolTraceStep[] = [];

  const startTime = Date.now();

  if (config.dryRun) {
    notExecuted = true;
    notExecutedReason = "dry-run mode — no API key configured";
  } else {
    try {
      const result = await chatCompletion(
        {
          model: shared.model,
          messages,
          tools,
          temperature: shared.temperature,
          seed: shared.seed,
          ...(config.maxTokens !== undefined
            ? { max_tokens: config.maxTokens }
            : {}),
        },
        {
          onToolCall: async (tc) => {
            const args = JSON.parse(tc.function.arguments || "{}");
            if (isWithLynx) {
              if (overrides?.lynxExecutor) {
                return overrides.lynxExecutor(
                  tc.function.name,
                  args,
                  project,
                  fixtureDir,
                  task,
                );
              }
              return executeLynxTool(
                tc.function.name,
                args,
                project,
                fixtureDir,
              );
            }
            return executeBaselineTool(tc.function.name, args, fixtureDir);
          },
          onTrace: includeTrace
            ? (step: ToolTraceStep) => {
                traceSteps.push(step);
              }
            : undefined,
        },
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          ...(shared.timeoutMs !== undefined
            ? { timeoutMs: shared.timeoutMs }
            : {}),
          ...(shared.maxRetries !== undefined
            ? { maxRetries: shared.maxRetries }
            : {}),
          ...(config.maxToolCalls !== undefined
            ? { maxToolCalls: config.maxToolCalls }
            : {}),
        },
      );

      allToolCalls = result.toolCalls;
      usage = result.usage;
      modelVersion = result.model || null;
      apiLatency = result.latencyMs;
      toolLoopExhausted = result.toolLoopExhausted;
      finalizationError = result.finalizationError;

      // Extract final assistant response
      const lastAssistant = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      responseContent = lastAssistant?.content || "";

      // Track files read by tools
      for (const tc of result.toolCalls) {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (tc.function.name === "read_file" && args.path) {
          const resolved = path.resolve(fixtureDir, String(args.path));
          const normalized = path.resolve(fixtureDir) + path.sep;
          if (resolved.startsWith(normalized)) {
            filesRead.add(resolved);
            try {
              bytesRead += fs.statSync(resolved).size;
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (err) {
      const errMsg = redactSecrets(String(err));
      // chatCompletion no longer throws on exhaustion — only real failures reach here
      responseContent = `Error: ${errMsg}`;
      executionErrors.push(`provider_request_failed: ${errMsg}`);
    }
  }

  const totalTime = Date.now() - startTime;
  if (modelVersion && modelVersion !== config.model) {
    executionErrors.push(
      `provider_model_mismatch: expected ${config.model}, received ${modelVersion}`,
    );
  }
  const kind = evaluationKind(task);
  const evaluation = notExecuted
    ? {
        result: {} as Record<string, unknown>,
        correct: false,
        defects: Object.keys(task.expected).length,
        errors: ["not_executed"],
      }
    : task.id === "external_dead_code"
      ? await evaluateExternalDeadCodeResponse(responseContent, project)
      : evaluateResponse(responseContent, task.expected);

  const cost = config.tier === "screening" ? 0 : computeCost(usage);

  return {
    run_id: runId,
    task_id: task.id,
    condition,
    order_position: 0,
    seed: 0,
    messages,
    toolCalls: allToolCalls,
    response: responseContent,
    responseHash: sha256Hash(responseContent),
    metrics: {
      model: config.model,
      model_version: modelVersion,
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      cached_tokens: usage.prompt_cache_hit_tokens || 0,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      tool_call_count: allToolCalls.length,
      files_read: filesRead.size,
      bytes_read: bytesRead,
      wall_time_ms: totalTime,
      api_latency_ms: apiLatency,
      cost_usd: cost,
      cost_classification: "estimated" as const,
      functional_success:
        kind !== "designed-only" &&
        evaluation.correct &&
        executionErrors.length === 0,
      defects_introduced: kind === "designed-only" ? 0 : evaluation.defects,
      fixes_needed: kind === "designed-only" ? 0 : evaluation.defects,
      not_executed: notExecuted,
    },
    result: evaluation.result,
    expected: task.expected,
    correct: evaluation.correct && executionErrors.length === 0,
    evaluation_eligible: isEvaluationEligible(task),
    evaluation_kind: kind,
    errors: [...evaluation.errors, ...executionErrors],
    not_executed: notExecuted,
    not_executed_reason: notExecutedReason,
    tool_loop_exhausted: toolLoopExhausted,
    finalization_error: finalizationError,
    ...(includeTrace && traceSteps.length > 0 ? { trace: traceSteps } : {}),
  };
}

// ── Chained multi-turn runner ──────────────────────────────────

async function runChainedAgentTasks(
  tasks: [BenchmarkTask, BenchmarkTask],
  condition: "with_lynx" | "without_lynx",
  config: AgentABConfig,
  project: string,
  fixtureDir: string,
  includeTrace: boolean,
  overrides?: {
    lynxTools?: AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
    ) => Promise<string>;
  },
): Promise<[AgentABRun, AgentABRun]> {
  const isWithLynx = condition === "with_lynx";
  const shared = getSharedParams(config);
  const tools = isWithLynx
    ? (overrides?.lynxTools ?? makeLynxTools())
    : makeBaselineTools();

  // Shared conversation — starts with task1's prompt
  const messages: AgentMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: tasks[0].userPrompt },
  ];

  async function runOneTask(
    task: BenchmarkTask,
    taskIndex: number,
  ): Promise<{
    run: AgentABRun;
    toolResult: {
      allToolCalls: AgentToolCall[];
      usage: ApiUsage;
      modelVersion: string | null;
      apiLatency: number;
      toolLoopExhausted: boolean;
      finalizationError: string | undefined;
      traceSteps: ToolTraceStep[];
      responseContent: string;
      filesRead: Set<string>;
      bytesRead: number;
    };
  }> {
    const runId = generateRunId();
    let usage: ApiUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let modelVersion: string | null = null;
    let apiLatency = 0;
    let responseContent = "";
    let allToolCalls: AgentToolCall[] = [];
    const filesRead = new Set<string>();
    let bytesRead = 0;
    let toolLoopExhausted = false;
    let finalizationError: string | undefined;
    const executionErrors: string[] = [];
    const traceSteps: ToolTraceStep[] = [];
    const startTime = Date.now();

    if (!config.dryRun) {
      try {
        const result = await chatCompletion(
          {
            model: shared.model,
            messages,
          tools,
          temperature: shared.temperature,
          seed: shared.seed + taskIndex * 1000,
          ...(config.maxTokens !== undefined
            ? { max_tokens: config.maxTokens }
            : {}),
          },
          {
            onToolCall: async (tc) => {
              const args = JSON.parse(tc.function.arguments || "{}");
              if (isWithLynx) {
                if (overrides?.lynxExecutor) {
                  return overrides.lynxExecutor(
                    tc.function.name,
                    args,
                    project,
                    fixtureDir,
                  );
                }
                return executeLynxTool(
                  tc.function.name,
                  args,
                  project,
                  fixtureDir,
                );
              }
              return executeBaselineTool(tc.function.name, args, fixtureDir);
            },
            onTrace: includeTrace
              ? (step: ToolTraceStep) => {
                  traceSteps.push(step);
                }
              : undefined,
          },
          {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            ...(shared.timeoutMs !== undefined
              ? { timeoutMs: shared.timeoutMs }
              : {}),
            ...(shared.maxRetries !== undefined
              ? { maxRetries: shared.maxRetries }
              : {}),
            ...(config.maxToolCalls !== undefined
              ? { maxToolCalls: config.maxToolCalls }
              : {}),
          },
        );

        // chatCompletion mutates messages in place — all tool results and assistant
        // responses are already appended. We just add task2's prompt as user message.
        allToolCalls = result.toolCalls;
        usage = result.usage;
        modelVersion = result.model || null;
        apiLatency = result.latencyMs;
        toolLoopExhausted = result.toolLoopExhausted;
        finalizationError = result.finalizationError;

        const lastAssistant = [...result.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.content);
        responseContent = lastAssistant?.content || "";

        for (const tc of result.toolCalls) {
          const args = JSON.parse(tc.function.arguments || "{}");
          if (tc.function.name === "read_file" && args.path) {
            const resolved = path.resolve(fixtureDir, String(args.path));
            if (resolved.startsWith(path.resolve(fixtureDir) + path.sep)) {
              filesRead.add(resolved);
              try {
                bytesRead += fs.statSync(resolved).size;
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err) {
        const errMsg = redactSecrets(String(err));
        responseContent = `Error: ${errMsg}`;
        executionErrors.push(`provider_request_failed: ${errMsg}`);
      }
    }

    const totalTime = Date.now() - startTime;
    const kind = evaluationKind(task);
    const isDry = !!config.dryRun;
    const evaluation = isDry
      ? {
          result: {} as Record<string, unknown>,
          correct: false,
          defects: Object.keys(task.expected).length,
          errors: ["not_executed"],
        }
      : task.id === "external_dead_code"
        ? await evaluateExternalDeadCodeResponse(responseContent, project)
        : evaluateResponse(responseContent, task.expected);

    const cost = config.tier === "screening" ? 0 : computeCost(usage);

    const run: AgentABRun = {
      run_id: runId,
      task_id: task.id,
      condition,
      order_position: taskIndex,
      seed: shared.seed + taskIndex * 1000,
      messages: messages.map((m) => ({ ...m })), // snapshot
      toolCalls: allToolCalls,
      response: responseContent,
      responseHash: sha256Hash(responseContent),
      metrics: {
        model: config.model,
        model_version: modelVersion,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cached_tokens: usage.prompt_cache_hit_tokens || 0,
        reasoning_tokens:
          usage.completion_tokens_details?.reasoning_tokens || 0,
        tool_call_count: allToolCalls.length,
        files_read: filesRead.size,
        bytes_read: bytesRead,
        wall_time_ms: totalTime,
        api_latency_ms: apiLatency,
        cost_usd: cost,
        cost_classification: "estimated" as const,
        functional_success:
          kind !== "designed-only" &&
          evaluation.correct &&
          executionErrors.length === 0,
        defects_introduced: kind === "designed-only" ? 0 : evaluation.defects,
        fixes_needed: kind === "designed-only" ? 0 : evaluation.defects,
        not_executed: isDry,
      },
      result: evaluation.result,
      expected: task.expected,
      correct: evaluation.correct && executionErrors.length === 0,
      evaluation_eligible: isEvaluationEligible(task),
      evaluation_kind: kind,
      errors: [...evaluation.errors, ...executionErrors],
      not_executed: isDry,
      not_executed_reason: isDry ? "dry-run mode" : undefined,
      tool_loop_exhausted: toolLoopExhausted,
      finalization_error: finalizationError,
      ...(includeTrace && traceSteps.length > 0 ? { trace: traceSteps } : {}),
    };

    return {
      run,
      toolResult: {
        allToolCalls,
        usage,
        modelVersion,
        apiLatency,
        toolLoopExhausted,
        finalizationError,
        traceSteps,
        responseContent,
        filesRead,
        bytesRead,
      },
    };
  }

  // Task 1
  const { run: run1 } = await runOneTask(tasks[0], 0);

  // Append task 2's prompt and continue the SAME conversation
  messages.push({ role: "user", content: tasks[1].userPrompt });

  // Task 2
  const { run: run2 } = await runOneTask(tasks[1], 1);

  return [run1, run2];
}
