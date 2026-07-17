export interface PerformanceSummary {
  samples: number;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const bounded = Math.min(100, Math.max(0, percentileValue));
  const index = Math.max(0, Math.ceil((bounded / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizePerformance(values: readonly number[]): PerformanceSummary {
  return {
    samples: values.length,
    median_ms: Number(percentile(values, 50).toFixed(3)),
    p95_ms: Number(percentile(values, 95).toFixed(3)),
    max_ms: Number(Math.max(...values, 0).toFixed(3)),
  };
}
