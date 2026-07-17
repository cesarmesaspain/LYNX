import { describe, expect, it } from 'vitest';
import { percentile, summarizePerformance } from '../../../src/quality/performance-budget.js';

describe('performance budget statistics', () => {
  it('sorts independent input and uses nearest-rank percentiles', () => {
    const input = [5, 1, 4, 2, 3];
    expect(percentile(input, 50)).toBe(3);
    expect(percentile(input, 95)).toBe(5);
    expect(input).toEqual([5, 1, 4, 2, 3]);
  });

  it('bounds percentile requests and handles empty samples', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([2, 8], -1)).toBe(2);
    expect(percentile([2, 8], 101)).toBe(8);
  });

  it('produces deterministic rounded summaries', () => {
    expect(summarizePerformance([1.11149, 2.22251, 3.33349])).toEqual({
      samples: 3,
      median_ms: 2.223,
      p95_ms: 3.333,
      max_ms: 3.333,
    });
  });
});
