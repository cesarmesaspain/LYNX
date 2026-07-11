/*
 * cache.ts — Time-window metrics cache with invalidation on new events.
 *
 * Strategy: cache key = `${project}:${window}`. Invalidation is event-count-based:
 * each project tracks the last known event count from events_archive. When new events
 * arrive, the count changes → cache miss → recompute. TTL enforces freshness floor.
 */

import { aggregateByWindow, aggregateTotal, type TimeWindow, type WindowedMetrics } from './aggregation.js';
import { readArchivedEvents } from '../store/metrics-db.js';

interface CacheEntry {
  metrics: WindowedMetrics;
  eventCount: number;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

// project → last known event count for invalidation
const projectEventCounts = new Map<string, number>();

const TTL_MS: Record<TimeWindow, number> = {
  '24h': 60_000,       // 1 min
  '7d': 300_000,       // 5 min
  '30d': 600_000,      // 10 min
  'total': 900_000,    // 15 min
};

function cacheKey(project: string, window: TimeWindow): string {
  return `${project}:${window}`;
}

function getCurrentEventCount(project: string): number {
  // Fast count query against events_archive
  try {
    const events = readArchivedEvents(project, 50000);
    return events.length;
  } catch {
    return -1; // force miss
  }
}

export function getCachedMetrics(project: string, window: TimeWindow): WindowedMetrics {
  const key = cacheKey(project, window);
  const entry = cache.get(key);
  const now = Date.now();

  // Check TTL
  if (entry && now - entry.cachedAt < TTL_MS[window]) {
    // Check event count for invalidation
    const currentCount = getCurrentEventCount(project);
    const lastCount = projectEventCounts.get(project) ?? 0;
    if (currentCount === lastCount && currentCount >= 0) {
      return entry.metrics;
    }
  }

  // Miss or invalidated — recompute
  const metrics = window === 'total'
    ? aggregateTotal(project)
    : aggregateByWindow(project, window);

  const eventCount = getCurrentEventCount(project);
  projectEventCounts.set(project, eventCount);

  cache.set(key, { metrics, eventCount, cachedAt: now });
  return metrics;
}

/** Invalidate cache for a specific project (e.g. after recording a usage event). */
export function invalidateProject(project: string): void {
  projectEventCounts.delete(project);
  for (const w of ['24h', '7d', '30d', 'total'] as TimeWindow[]) {
    cache.delete(cacheKey(project, w));
  }
}

/** Invalidate all caches (e.g. after rebuild). */
export function invalidateAll(): void {
  cache.clear();
  projectEventCounts.clear();
}

/** Expose cache stats for debugging. */
export function cacheStats(): { size: number; entries: Array<{ key: string; ageMs: number }> } {
  const now = Date.now();
  return {
    size: cache.size,
    entries: [...cache.entries()].map(([key, e]) => ({
      key,
      ageMs: now - e.cachedAt,
    })),
  };
}
