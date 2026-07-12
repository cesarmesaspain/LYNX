import { describe, expect, it } from 'vitest';
import { cacheKey } from '../src/intelligence/router.js';

describe('intelligence cache keys', () => {
  it('separates tasks, licenses, and nested payload values', () => {
    const payload = { candidate: { name: 'first', score: 1 } };
    const base = cacheKey('rerank_search', 'license-a', payload);

    expect(cacheKey('summarize_module', 'license-a', payload)).not.toBe(base);
    expect(cacheKey('rerank_search', 'license-b', payload)).not.toBe(base);
    expect(cacheKey('rerank_search', 'license-a', { candidate: { name: 'second', score: 1 } })).not.toBe(base);
  });

  it('is stable when object keys arrive in another order', () => {
    expect(cacheKey('detect_test', 'license-a', { b: 2, nested: { z: 1, a: 2 }, a: 1 }))
      .toBe(cacheKey('detect_test', 'license-a', { a: 1, nested: { a: 2, z: 1 }, b: 2 }));
  });
});
