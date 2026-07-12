/*
 * Controlled before/after microbenchmark support.
 *
 * This module deliberately does not execute API calls. It freezes and compares
 * the experimental protocol so a paid run can only vary the LYNX change.
 */

import { sha256Hash } from './api-client.js';
import type {
  AgentABConfig,
  AgentABExperimentComparison,
  AgentABExperimentProtocol,
  AgentABResult,
} from './types.js';

export const PAID_MICROBENCHMARK_MODEL = 'deepseek-v4-flash' as const;
export const PAID_MICROBENCHMARK_TEMPERATURE = 0 as const;

/** Reject configuration drift before a paid benchmark can make an API call. */
export function assertPaidMicrobenchmarkProtocol(config: Pick<AgentABConfig,
  'model' | 'temperature' | 'baseUrl' | 'seed' | 'maxTokens' | 'maxToolCalls' | 'timeoutMs' | 'maxRetries' | 'projectDir'
>): void {
  const failures: string[] = [];
  if (config.model !== PAID_MICROBENCHMARK_MODEL) {
    failures.push(`model must be exactly ${PAID_MICROBENCHMARK_MODEL}, got ${config.model}`);
  }
  if (config.temperature !== PAID_MICROBENCHMARK_TEMPERATURE) {
    failures.push(`temperature must be exactly 0, got ${config.temperature}`);
  }
  if (config.baseUrl !== 'https://api.deepseek.com/v1') {
    failures.push('baseUrl must be the DeepSeek API endpoint; provider fallback is forbidden');
  }
  if (!Number.isInteger(config.seed)) failures.push('seed must be a fixed integer');
  if (config.maxTokens !== undefined || (config.maxToolCalls !== undefined && !config.projectDir)) {
    failures.push('internal microbenchmarks must not set artificial token or tool-call ceilings');
  }
  if (failures.length) throw new Error(`Paid microbenchmark protocol rejected: ${failures.join('; ')}`);
}

/** Capture every setting that must remain identical across one before/after pair. */
export function buildExperimentProtocol(result: AgentABResult): AgentABExperimentProtocol {
  assertPaidMicrobenchmarkProtocol(result.config);
  const withLynx = result.tasks.filter(run => run.condition === 'with_lynx');
  const taskOrder = withLynx.map(run => run.task_id);
  const promptHash = sha256Hash(withLynx.map(run => run.messages?.find(m => m.role === 'user')?.content || '').join('\n---\n'));
  return {
    model: PAID_MICROBENCHMARK_MODEL,
    temperature: PAID_MICROBENCHMARK_TEMPERATURE,
    seeds: [...new Set(withLynx.map(run => run.seed))],
    prompt_hash: promptHash,
    task_order: taskOrder,
    max_tokens: result.config.maxTokens ?? null,
    max_tool_calls: result.config.maxToolCalls ?? null,
    timeout_ms: result.config.timeoutMs ?? null,
    max_retries: result.config.maxRetries ?? null,
    base_url: result.config.baseUrl,
  };
}

function sameProtocol(before: AgentABExperimentProtocol, after: AgentABExperimentProtocol): string[] {
  const fields: Array<keyof AgentABExperimentProtocol> = [
    'model', 'temperature', 'seeds', 'prompt_hash', 'task_order',
    'max_tokens', 'max_tool_calls', 'timeout_ms', 'max_retries', 'base_url',
  ];
  return fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(field => `protocol mismatch: ${field}`);
}

/**
 * Compares one LYNX change against its immediately previous version.
 * Acceptance is conservative: lower success always blocks; higher cost must
 * buy a success improvement; no protocol drift is allowed.
 */
export function compareOneChange(before: AgentABResult, after: AgentABResult): AgentABExperimentComparison {
  const blocked_reasons = sameProtocol(buildExperimentProtocol(before), buildExperimentProtocol(after));
  const b = before.summary.with_lynx;
  const a = after.summary.with_lynx;
  const beforeExhausted = before.tasks.filter(r => r.condition === 'with_lynx' && r.tool_loop_exhausted).length;
  const afterExhausted = after.tasks.filter(r => r.condition === 'with_lynx' && r.tool_loop_exhausted).length;
  const deltas = {
    success_rate: a.functional_success_rate - b.functional_success_rate,
    cost_usd: a.cost_usd.total - b.cost_usd.total,
    input_tokens: a.input_tokens.total - b.input_tokens.total,
    wall_time_ms: a.wall_time_ms.median - b.wall_time_ms.median,
    tool_calls: a.tool_calls.total - b.tool_calls.total,
    tool_loop_exhausted: afterExhausted - beforeExhausted,
  };
  if (deltas.success_rate < 0) blocked_reasons.push('functional success regressed');
  if (deltas.cost_usd > 0 && deltas.success_rate <= 0) {
    blocked_reasons.push('cost increased without a functional-success gain');
  }
  if (deltas.tool_loop_exhausted > 0 && deltas.success_rate <= 0) {
    blocked_reasons.push('tool-loop exhaustion increased without a functional-success gain');
  }
  if (before.summary.roi_blocked || after.summary.roi_blocked) {
    blocked_reasons.push('insufficient deterministic evaluated runs for acceptance');
  }
  return { accepted: blocked_reasons.length === 0, blocked_reasons, deltas };
}
