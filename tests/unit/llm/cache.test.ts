import { describe, expect, it } from 'vitest';
import { LlmCache } from '../../../src/llm/cache.js';

describe('LlmCache', () => {
  it('never exceeds its configured maximum for small caches', () => {
    const cache = new LlmCache(3);

    cache.set('a', 'task', 1);
    cache.set('b', 'task', 2);
    cache.set('c', 'task', 3);
    cache.set('d', 'task', 4);

    expect(cache.size).toBe(3);
    expect(cache.has('a', 'task')).toBe(false);
    expect(cache.get<number>('d', 'task')).toBe(4);
  });

  it('refreshes recently read entries before evicting least-recently-used entries', () => {
    const cache = new LlmCache(5);

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      cache.set(key, 'task', key);
    }

    expect(cache.get<string>('a', 'task')).toBe('a');
    cache.set('f', 'task', 'f');

    expect(cache.has('a', 'task')).toBe(true);
    expect(cache.has('b', 'task')).toBe(false);
    expect(cache.size).toBe(5);
  });
});
