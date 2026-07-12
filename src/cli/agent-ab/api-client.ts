/*
 * agent-ab/api-client.ts — Tool-calling loop with retries and safety.
 *
 * Uses the shared OpenAI-compatible client from src/llm/shared.ts.
 * Credential: LYNX_DEEPSEEK_KEY → DEEPSEEK_API_KEY → null.
 * Never persists or prints secrets.
 */

import {
  getApiKey,
  redactSecrets,
  sha256Hash,
  openaiChatCompletion,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} from '../../llm/shared.js';
import type {
  OpenAIMessage,
  OpenAIToolDefinition,
} from '../../llm/shared.js';
import type { AgentToolCall, ApiUsage, ToolTraceStep } from './types.js';

export { getApiKey, redactSecrets, sha256Hash, DEFAULT_BASE_URL, DEFAULT_MODEL };

const RETRY_BACKOFF_MS = 1000;
/** Applied to every tool in both conditions so one broad result cannot invalidate an A/B run. */
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

export function truncateToolResult(result: string, maxBytes = MAX_TOOL_RESULT_BYTES): string {
  const bytes = Buffer.byteLength(result, 'utf-8');
  if (bytes <= maxBytes) return result;
  // Slice by bytes, then retreat to a valid UTF-8 boundary.
  const prefix = Buffer.from(result, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  return `${prefix}\n[TOOL_RESULT_TRUNCATED: ${bytes} bytes total; refine the query or request a narrower result.]`;
}

export interface ChatCallbacks {
  onToolCall?: (toolCall: AgentToolCall) => Promise<string | null>;
  /** Called for each LLM turn and tool execution (sanitized). Only active when tracing is enabled. */
  onTrace?: (step: ToolTraceStep) => void;
}

export interface ChatOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional only for unit tests; real benchmarks omit this ceiling. */
  maxToolCalls?: number;
  /** Optional only for unit tests; real benchmarks preserve complete results. */
  maxToolResultBytes?: number;
  _fetch?: typeof fetch;
}

export interface ChatResult {
  messages: OpenAIMessage[];
  toolCalls: AgentToolCall[];
  usage: ApiUsage;
  model: string;
  latencyMs: number;
  finishReason: string;
  toolLoopExhausted: boolean;
  /** Set when the forced-final call (after exhaustion) itself failed. */
  finalizationError?: string;
}

function isRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('aborted')
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Multi-turn chat completion with tool-calling loop.
 * When a caller explicitly supplies maxToolCalls, exhaustion triggers a
 * forced-final call. Real-world benchmarks omit it and let the model stop.
 */
export async function chatCompletion(
  request: {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAIToolDefinition[];
    temperature?: number;
    max_tokens?: number;
    seed?: number;
  },
  callbacks: ChatCallbacks,
  options: ChatOptions
): Promise<ChatResult> {
  const allToolCalls: AgentToolCall[] = [];
  let totalUsage: ApiUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const conversationMessages = [...request.messages];
  let modelUsed = request.model;
  let finishReason = 'stop';
  let toolLoopExhausted = false;
  let finalizationError: string | undefined;
  const apiStart = Date.now();
  let seq = 0;

  const emitTrace = (step: ToolTraceStep) => {
    if (callbacks.onTrace) callbacks.onTrace(step);
  };

  const accumulateUsage = (usage: ApiUsage | undefined) => {
    if (!usage) return;
    totalUsage = {
      prompt_tokens: (totalUsage.prompt_tokens || 0) + (usage.prompt_tokens || 0),
      completion_tokens: (totalUsage.completion_tokens || 0) + (usage.completion_tokens || 0),
      total_tokens: (totalUsage.total_tokens || 0) + (usage.total_tokens || 0),
      prompt_cache_hit_tokens:
        (totalUsage.prompt_cache_hit_tokens || 0) + (usage.prompt_cache_hit_tokens || 0),
      prompt_cache_miss_tokens:
        (totalUsage.prompt_cache_miss_tokens || 0) + (usage.prompt_cache_miss_tokens || 0),
      completion_tokens_details: usage.completion_tokens_details || totalUsage.completion_tokens_details,
    };
  };

  for (;;) {
    // The budget is a count of executed tool calls, not LLM turns: one model
    // response may request many tools at once.
    if (options.maxToolCalls !== undefined && allToolCalls.length >= options.maxToolCalls) {
      toolLoopExhausted = true;
      conversationMessages.push({
        role: 'user',
        content: '[SYSTEM] You have reached the maximum number of tool calls. Stop investigating now. Using only the evidence already collected, output the exact final JSON requested. Do NOT request more tools.',
      });

      const finalStart = Date.now();
      try {
        const finalResp = await apiCallWithRetry(
          {
            model: request.model,
            messages: conversationMessages,
            // No tools — prevent further tool calls
            tools: undefined,
            temperature: request.temperature,
            max_tokens: request.max_tokens,
          },
          options
        );
        const finalDuration = Date.now() - finalStart;

        modelUsed = finalResp.model;
        accumulateUsage(finalResp.usage);

        const finalChoice = finalResp.choices[0];
        if (finalChoice) {
          finishReason = finalChoice.finish_reason;
          conversationMessages.push({
            role: 'assistant',
            content: finalChoice.message.content,
          });
          emitTrace({
            seq: ++seq,
            role: 'llm_call',
            model: finalResp.model,
            finish_reason: finalChoice.finish_reason,
            duration_ms: finalDuration,
            content_hash: finalChoice.message.content
              ? sha256Hash(String(finalChoice.message.content))
              : undefined,
          });
        }
      } catch (err) {
        finalizationError = redactSecrets(String(err));
      }
      break;
    }

    const llmStart = Date.now();
    const resp = await apiCallWithRetry(
      { ...request, messages: conversationMessages },
      options
    );
    const llmDuration = Date.now() - llmStart;

    modelUsed = resp.model;
    accumulateUsage(resp.usage);

    const choice = resp.choices[0];
    if (!choice) throw new Error('No choices in API response');

    const msg = choice.message;
    conversationMessages.push({
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    finishReason = choice.finish_reason;

    // Emit llm_call trace step
    emitTrace({
      seq: ++seq,
      role: 'llm_call',
      model: resp.model,
      finish_reason: choice.finish_reason,
      duration_ms: llmDuration,
      content_hash: msg.content
        ? sha256Hash(String(msg.content))
        : undefined,
    });

    if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
      break;
    }

    if (choice.finish_reason === 'tool_calls' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (options.maxToolCalls !== undefined && allToolCalls.length >= options.maxToolCalls) {
          toolLoopExhausted = true;
          conversationMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '[SYSTEM] Tool call skipped: the benchmark tool-call budget is exhausted.',
          });
          continue;
        }
        allToolCalls.push(tc);
        const toolStart = Date.now();
        let toolResult: string | null = null;
        let toolError: string | undefined;
        try {
          toolResult = await callbacks.onToolCall?.(tc) ?? null;
        } catch (err) {
          toolResult = `Error: ${redactSecrets(String(err))}`;
          toolError = redactSecrets(String(err));
        }
        const toolDuration = Date.now() - toolStart;
        const resultStr = options.maxToolResultBytes === undefined
          ? (toolResult || '')
          : truncateToolResult(toolResult || '', options.maxToolResultBytes);
        toolResult = resultStr;

        // Emit tool_exec trace step with sanitized args
        let argsRedacted: Record<string, unknown> | undefined;
        try {
          const raw = JSON.parse(tc.function.arguments || '{}');
          argsRedacted = redactToolArgs(raw);
        } catch {
          argsRedacted = { _parse_error: tc.function.arguments?.slice(0, 100) };
        }

        emitTrace({
          seq: ++seq,
          role: 'tool_exec',
          tool_name: tc.function.name,
          args_redacted: argsRedacted,
          duration_ms: toolDuration,
          result_bytes: Buffer.byteLength(resultStr, 'utf-8'),
          error_sanitized: toolError,
          content_hash: sha256Hash(resultStr),
        });

        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult || '',
        });
      }
      continue;
    }

    break;
  }

  return {
    messages: conversationMessages,
    toolCalls: allToolCalls,
    usage: totalUsage,
    model: modelUsed,
    latencyMs: Date.now() - apiStart,
    finishReason,
    toolLoopExhausted,
    finalizationError,
  };
}

/** Redact sensitive values from tool arguments. Keeps paths, redacts patterns. */
function redactToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      // Redact anything that looks like a secret
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function apiCallWithRetry(
  request: {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAIToolDefinition[];
    temperature?: number;
    max_tokens?: number;
    seed?: number;
  },
  options: ChatOptions
): Promise<import('../../llm/shared.js').ChatCompletionResponse> {
  let lastError: Error | null = null;

  const maxRetries = options.maxRetries ?? 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await openaiChatCompletion(request, {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        _fetch: options._fetch,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message.includes('aborted') || lastError.name === 'AbortError') {
        throw new Error(`API request timed out${options.timeoutMs ? ` after ${options.timeoutMs}ms` : ''}`);
      }

      // Check if status-based retry
      const statusMatch = lastError.message.match(/^API (\d+):/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      if (isRetryableStatus(status) && attempt < maxRetries) {
        const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (attempt < maxRetries && isRetryable(lastError)) {
        const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error('API request failed after retries');
}

// ── Pricing (DeepSeek official, subject to change) ─────────────

export interface PricingConfig {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k: number;
}

const DEEPSEEK_PRICING: PricingConfig = {
  inputPer1k: 0.00014,
  outputPer1k: 0.00028,
  cachedInputPer1k: 0.000014,
};

/** Estimated cost from token usage and pricing config. Classification: estimated. */
export function computeCost(usage: ApiUsage | undefined, pricing?: PricingConfig): number {
  if (!usage) return 0;
  const p = pricing || DEEPSEEK_PRICING;
  const cachedHit = usage.prompt_cache_hit_tokens || 0;
  const inputWithoutCache = usage.prompt_tokens - cachedHit;
  const inputCost = (inputWithoutCache / 1000) * p.inputPer1k;
  const cachedCost = (cachedHit / 1000) * p.cachedInputPer1k;
  const outputCost = (usage.completion_tokens / 1000) * p.outputPer1k;
  return Number((inputCost + cachedCost + outputCost).toFixed(8));
}

export function computeCostDetailed(
  usage: ApiUsage | undefined,
  pricing?: PricingConfig
): { inputCost: number; outputCost: number; cachedCost: number; total: number } {
  if (!usage) return { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  const p = pricing || DEEPSEEK_PRICING;
  const cachedHit = usage.prompt_cache_hit_tokens || 0;
  const inputWithoutCache = usage.prompt_tokens - cachedHit;
  const inputCost = (inputWithoutCache / 1000) * p.inputPer1k;
  const cachedCost = (cachedHit / 1000) * p.cachedInputPer1k;
  const outputCost = (usage.completion_tokens / 1000) * p.outputPer1k;
  return {
    inputCost: Number(inputCost.toFixed(8)),
    outputCost: Number(outputCost.toFixed(8)),
    cachedCost: Number(cachedCost.toFixed(8)),
    total: Number((inputCost + cachedCost + outputCost).toFixed(8)),
  };
}
