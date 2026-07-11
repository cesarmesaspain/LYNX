/*
 * router.ts — Intelligence router: picks a provider per task and executes.
 *
 * Provider chain: primary → fallback → heuristic (never returns 500).
 * Cache hits in Redis avoid re-running identical payloads.
 *
 * Zero-knowledge: the payload never contains source code.
 * Only metadata: function names, line counts, caller counts, complexity numbers.
 */

import { providerDb } from '../db.js';
import type { IntelligenceRequest, IntelligenceResponse } from '../types.js';
import { cacheGet, cacheSet } from './cache.js';
import { createHash } from 'node:crypto';
import { callQwen } from './providers/qwen.js';
import { callDeepSeek } from './providers/deepseek.js';
import { callHeuristic } from './providers/heuristic.js';

const QWEN_URL = process.env.LYNX_QWEN_URL || 'http://10.0.0.2:8080';
const DEEPSEEK_KEY = process.env.LYNX_DEEPSEEK_KEY || '';

interface RoutingConfig {
  task: string;
  primary_provider: string;
  fallback_provider: string | null;
  max_tokens: number;
  temperature: number;
  cache_ttl_seconds: number;
  enabled: number;
}

const routingCache = new Map<string, RoutingConfig>();

function getRouting(task: string): RoutingConfig | null {
  const cached = routingCache.get(task);
  if (cached) return cached;

  const row = providerDb.prepare(
    'SELECT * FROM intelligence_routing WHERE task = ? AND enabled = 1'
  ).get(task) as RoutingConfig | undefined;

  if (row) {
    routingCache.set(task, row);
    // TTL the cache after 60 seconds so we can hot-swap providers
    setTimeout(() => routingCache.delete(task), 60_000);
  }
  return row || null;
}

function cacheKey(task: string, payload: Record<string, unknown>): string {
  const normalized = JSON.stringify({ task, ...payload }, Object.keys(payload).sort());
  return `lynx:intel:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export async function routeIntelligence(
  req: IntelligenceRequest
): Promise<IntelligenceResponse> {
  const routing = getRouting(req.task);
  if (!routing) {
    // No routing configured — fall through to heuristic
    return callHeuristic(req);
  }

  // Check cache
  const key = cacheKey(req.task, req.payload);
  const cached = await cacheGet(key);
  if (cached) {
    return { result: cached, latency_ms: 0, cached: true };
  }

  const providers = [routing.primary_provider, routing.fallback_provider].filter(Boolean) as string[];

  for (const provider of providers) {
    try {
      const t0 = Date.now();
      let result: string | null = null;

      switch (provider) {
        case 'qwen-14b':
          result = await callQwen(QWEN_URL, req.task, req.payload, routing.max_tokens, routing.temperature);
          break;
        case 'deepseek':
          if (!DEEPSEEK_KEY) continue;
          result = await callDeepSeek(DEEPSEEK_KEY, req.task, req.payload, routing.max_tokens, routing.temperature);
          break;
        case 'heuristic':
          result = (await callHeuristic(req)).result;
          break;
      }

      if (result) {
        await cacheSet(key, result, routing.cache_ttl_seconds);
        return { result, latency_ms: Date.now() - t0 };
      }
    } catch {
      // Provider failed — try next
      continue;
    }
  }

  // All providers failed — heuristic is the safety net
  const fallback = await callHeuristic(req);
  return { ...fallback, fallback: true };
}

// Invalidate routing cache (call after DB update)
export function invalidateRoutingCache(task?: string): void {
  if (task) {
    routingCache.delete(task);
  } else {
    routingCache.clear();
  }
}
