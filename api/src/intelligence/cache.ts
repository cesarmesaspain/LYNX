/*
 * cache.ts — Redis cache wrapper for intelligence responses.
 *
 * If Redis is unavailable, caching is silently skipped (no-op).
 * This keeps the API server functional even without Redis.
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null, // don't retry
    });
    redis.on('error', () => {
      redis = null;
    });
    return redis;
  } catch {
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.setex(key, ttlSeconds, value);
  } catch {
    // silent — cache is best-effort
  }
}
