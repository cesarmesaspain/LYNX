/*
 * cache.ts — LRU result cache for LLM outputs.
 *
 * Keyed by SHA256 of the source code, so unchanged files always hit cache.
 * In-memory Map with capped size; no disk persistence needed.
 */

interface CacheEntry<T> {
  value: T;
  ts: number;
}

export class LlmCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxSize: number;

  constructor(maxSize = 5000) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(1, Math.floor(maxSize)) : 5000;
  }

  private key(hash: string, task: string): string {
    return `${hash}:${task}`;
  }

  get<T>(hash: string, task: string): T | undefined {
    const cacheKey = this.key(hash, task);
    const entry = this.store.get(cacheKey);
    if (!entry) return undefined;

    this.store.delete(cacheKey);
    this.store.set(cacheKey, { ...entry, ts: Date.now() });
    return entry.value as T;
  }

  set<T>(hash: string, task: string, value: T): void {
    const cacheKey = this.key(hash, task);
    this.store.delete(cacheKey);

    if (this.store.size >= this.maxSize) {
      // Evict the oldest 20%, but always remove at least one entry.
      const keys = Array.from(this.store.keys());
      const deleteCount = Math.max(1, Math.floor(this.maxSize * 0.2));
      for (const k of keys.slice(0, deleteCount)) this.store.delete(k);
    }
    this.store.set(cacheKey, { value, ts: Date.now() });
  }

  has(hash: string, task: string): boolean {
    return this.store.has(this.key(hash, task));
  }

  get size(): number {
    return this.store.size;
  }
}

/** Shared global cache instance */
export const llmCache = new LlmCache();
