import { describe, expect, it, vi } from 'vitest';
import { getBenchmarkRerankProvider } from '../../../src/cli/benchmark.js';

vi.mock('../../../src/llm/client.js', () => ({
  getRerankProviderMode: vi.fn(() => 'api'),
  rerankSearch: vi.fn(),
}));

// Test the percentile helper used by the benchmark
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

describe('benchmark statistics', () => {
  describe('semantic provider', () => {
    it('keeps --no-llm local to this benchmark invocation', () => {
      const before = process.env.LYNX_NO_LLM;

      expect(getBenchmarkRerankProvider(['--no-llm'])).toBe('heuristic');
      expect(process.env.LYNX_NO_LLM).toBe(before);
    });

    it('uses the configured provider when semantic ranking is enabled', () => {
      expect(getBenchmarkRerankProvider([])).toBe('api');
    });
  });

  describe('percentile', () => {
    it('p50 of [1,2,3,4,5] is 3', () => {
      expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it('p95 of 100 values picks the 95th', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(percentile(values, 95)).toBe(95);
    });

    it('empty array returns 0', () => {
      expect(percentile([], 50)).toBe(0);
    });

    it('single value', () => {
      expect(percentile([42], 50)).toBe(42);
      expect(percentile([42], 95)).toBe(42);
    });

    it('p95 of 20 values is 19th', () => {
      const values = Array.from({ length: 20 }, (_, i) => i + 1);
      expect(percentile(values, 95)).toBe(19);
    });

    it('median of even-length array picks midpoint', () => {
      // [1,2,3,4] → ceil(50%*4)-1 = ceil(2)-1 = 2-1 = 1 → index 1 → value 2
      expect(median([1, 2, 3, 4])).toBe(2);
    });

    it('median of odd-length array picks middle', () => {
      // [1,2,3,4,5] → ceil(50%*5)-1 = ceil(2.5)-1 = 3-1 = 2 → value 3
      expect(median([1, 2, 3, 4, 5])).toBe(3);
    });
  });

  describe('response bytes measurement', () => {
    it('returns a positive integer for non-empty payload', () => {
      const payload = { rows: [{ query: 'test', results: 5 }] };
      const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
      expect(bytes).toBeGreaterThan(0);
      expect(Number.isInteger(bytes)).toBe(true);
    });

    it('grows with more data', () => {
      const small = Buffer.byteLength(JSON.stringify({ rows: [{ q: 'a' }] }), 'utf-8');
      const large = Buffer.byteLength(
        JSON.stringify({ rows: Array.from({ length: 10 }, (_, i) => ({ query: `q${i}`, results: i })) }),
        'utf-8'
      );
      expect(large).toBeGreaterThan(small);
    });
  });
});
