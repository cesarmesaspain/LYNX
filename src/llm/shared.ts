/*
 * llm/shared.ts — Shared OpenAI-compatible client utilities.
 *
 * Used by both provider-deepseek.ts (simple chat) and agent-ab (tool-calling loop).
 * Credential resolution: LYNX_DEEPSEEK_KEY first, then DEEPSEEK_API_KEY fallback.
 * Never persisted, printed, or logged.
 */

import { createHash } from 'node:crypto';
import { getConfiguredApiKey } from '../config/runtime.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';
/** Prevent provider outages from leaving CLI and MCP requests open forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
const PLACEHOLDER_KEY = 'sk-lynx-placeholder';

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[^\s]{20,}/g,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.startsWith('Bearer ')) return 'Bearer [REDACTED]';
      if (match.startsWith('sk-')) return 'sk-[REDACTED]';
      return '[REDACTED]';
    });
  }
  return result;
}

/** Resolve API key: LYNX_DEEPSEEK_KEY → DEEPSEEK_API_KEY → config.json → null. */
export function getApiKey(): string | null {
  const lynx = process.env.LYNX_DEEPSEEK_KEY;
  if (lynx && lynx.trim() !== '' && lynx !== PLACEHOLDER_KEY) {
    return lynx.trim();
  }
  const deepseek = process.env.DEEPSEEK_API_KEY;
  if (deepseek && deepseek.trim() !== '') {
    return deepseek.trim();
  }
  return getConfiguredApiKey('deepseek');
}

export function sha256Hash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
}

export interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  /** Provider seed. Benchmarks pass a fixed value so paired runs are reproducible. */
  seed?: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** Single API call — no retries, no tool loop. Returns raw response. */
export async function openaiChatCompletion(
  request: ChatCompletionRequest,
  options: {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    _fetch?: typeof fetch;
  }
): Promise<ChatCompletionResponse> {
  const fetchFn = options._fetch || fetch;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        tools: request.tools,
        temperature: request.temperature ?? 0.0,
        ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const redacted = redactSecrets(body);
      throw new Error(`API ${response.status}: ${redacted.slice(0, 200)}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
