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
    this.maxSize = maxSize;
  }

  private key(hash: string, task: string): string {
    return `${hash}:${task}`;
  }

  get<T>(hash: string, task: string): T | undefined {
    const entry = this.store.get(this.key(hash, task));
    if (entry) return entry.value as T;
    return undefined;
  }

  set<T>(hash: string, task: string, value: T): void {
    if (this.store.size >= this.maxSize) {
      // Evict oldest 20%
      const keys = Array.from(this.store.keys());
      const toDelete = keys.slice(0, Math.floor(this.maxSize * 0.2));
      for (const k of toDelete) this.store.delete(k);
    }
    this.store.set(this.key(hash, task), { value, ts: Date.now() });
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
