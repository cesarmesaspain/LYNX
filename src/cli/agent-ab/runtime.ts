/* Shared benchmark runtime configuration and identity helpers. */

import { createHash } from 'node:crypto';
import type { AgentABConfig, AgentABRun, EvaluationKind } from './types.js';
import type { BenchmarkTask } from './execution-support.js';

export const AGENT_AB_DEFAULT_MODEL = 'deepseek-v4-flash';

// ── Progress callback ──────────────────────────────────────────

export interface ProgressEvent {
  /** 1-based counter across all runs. */
  current: number;
  /** Total planned runs. */
  total: number;
  /** The run that just completed. */
  run: AgentABRun;
  /** All completed runs so far (accumulated). */
  allRuns: AgentABRun[];
}

export type ProgressCallback = (evt: ProgressEvent) => void;

// Reuse fixture generation from ab-benchmark
import { generateFixture } from "../ab-benchmark.js";

// ── System prompt (identical for both conditions) ─────────────

export const SYSTEM_PROMPT = `You are a code intelligence agent. You help developers understand code by answering questions precisely and concisely.

Rules:
- Answer based on the tools and information available.
- When MCP tools are available, their names, descriptions, and argument schemas are authoritative. Choose the smallest relevant tool set needed for the requested evidence; do not assume undocumented behavior.
- When using tools, call them one at a time. Wait for each result before proceeding.
- Verify only material uncertainty, and reuse evidence already collected instead of repeating equivalent investigation.
- When the available evidence is sufficient, stop investigating and provide a concise final answer.
- Do NOT invent information. If you cannot find something, say so.
- Output your final answer as a single JSON object with the exact fields requested. Nothing else.`;

// ── Shared params (identical across conditions) ───────────────

export function getSharedParams(config: AgentABConfig) {
  return {
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    seed: config.seed,
  };
}

export function evaluationKind(task: BenchmarkTask): EvaluationKind {
  if (task.evaluation_kind) return task.evaluation_kind;
  return Object.keys(task.expected).length > 0
    ? "deterministic"
    : "designed-only";
}

export function isEvaluationEligible(task: BenchmarkTask): boolean {
  const kind = evaluationKind(task);
  return kind === "partial" || (kind === "deterministic" && Object.keys(task.expected).length > 0);
}

// ── Run ID generation ─────────────────────────────────────────

let runCounter = 0;

export function generateRunId(): string {
  runCounter++;
  const rand = createHash("sha256")
    .update(`${runCounter}-${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
  return `run_${runCounter.toString(36)}_${rand}`;
}
