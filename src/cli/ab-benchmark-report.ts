/* Benchmark summary and rendering helpers, separated from execution. */

import type { ABBenchmarkConfig, ABBenchmarkResult, ABSummary, ABMetric, ComparisonBlock, ConditionSummary, MethodologySection, TaskRun } from './ab-benchmark.js';

export function buildSummary(
  withRuns: TaskRun[],
  withoutRuns: TaskRun[],
  config: ABBenchmarkConfig,
  taskCount: number
): ABSummary {
  const withTotalTime = withRuns.map(r => Number(r.metrics.total_time_ms.value));
  const withoutTotalTime = withoutRuns.map(r => Number(r.metrics.total_time_ms.value));

  const withTtfu = withRuns.map(r => Number(r.metrics.time_to_first_useful_ms.value));
  const withoutTtfu = withoutRuns.map(r => Number(r.metrics.time_to_first_useful_ms.value));

  const withFiles = withRuns.map(r => Number(r.metrics.files_opened.value));
  const withoutFiles = withoutRuns.map(r => Number(r.metrics.files_opened.value));

  const withBytes = withRuns.map(r => Number(r.metrics.bytes_read.value));
  const withoutBytes = withoutRuns.map(r => Number(r.metrics.bytes_read.value));

  const withTools = withRuns.map(r => Number(r.metrics.tool_calls.value));
  const withoutTools = withoutRuns.map(r => Number(r.metrics.tool_calls.value));

  const withLlm = withRuns.map(r => Number(r.metrics.llm_calls.value));
  const withoutLlm = withoutRuns.map(r => Number(r.metrics.llm_calls.value));

  const withCorrect = withRuns.filter(r => r.correct).length;
  const withoutCorrect = withoutRuns.filter(r => r.correct).length;

  const withDefects = withRuns.map(r => Number(r.metrics.defects_introduced.value));
  const withoutDefects = withoutRuns.map(r => Number(r.metrics.defects_introduced.value));

  const sortNum = (arr: number[]) => [...arr].sort((a, b) => a - b);

  const withSummary: ConditionSummary = {
    total_time_ms: {
      median: median(sortNum(withTotalTime)),
      p95: percentile(sortNum(withTotalTime), 95),
      min: Math.min(...withTotalTime),
      max: Math.max(...withTotalTime),
    },
    time_to_first_useful_ms: {
      median: median(sortNum(withTtfu)),
      p95: percentile(sortNum(withTtfu), 95),
    },
    files_opened: { median: median(sortNum(withFiles)), total: sum(withFiles) },
    bytes_read: { median: median(sortNum(withBytes)), total: sum(withBytes) },
    tool_calls: { median: median(sortNum(withTools)), total: sum(withTools) },
    llm_calls: { median: median(sortNum(withLlm)), total: sum(withLlm) },
    functional_success_rate: withRuns.length > 0 ? withCorrect / withRuns.length : 0,
    defects_per_task: withRuns.length > 0 ? sum(withDefects) / withRuns.length : 0,
  };

  const withoutSummary: ConditionSummary = {
    total_time_ms: {
      median: median(sortNum(withoutTotalTime)),
      p95: percentile(sortNum(withoutTotalTime), 95),
      min: Math.min(...withoutTotalTime),
      max: Math.max(...withoutTotalTime),
    },
    time_to_first_useful_ms: {
      median: median(sortNum(withoutTtfu)),
      p95: percentile(sortNum(withoutTtfu), 95),
    },
    files_opened: { median: median(sortNum(withoutFiles)), total: sum(withoutFiles) },
    bytes_read: { median: median(sortNum(withoutBytes)), total: sum(withoutBytes) },
    tool_calls: { median: median(sortNum(withoutTools)), total: sum(withoutTools) },
    llm_calls: { median: median(sortNum(withoutLlm)), total: sum(withoutLlm) },
    functional_success_rate: withoutRuns.length > 0 ? withoutCorrect / withoutRuns.length : 0,
    defects_per_task: withoutRuns.length > 0 ? sum(withoutDefects) / withoutRuns.length : 0,
  };

  const deltaPct = (a: number, b: number): string => {
    if (b === 0) return a === 0 ? '0%' : 'N/A (baseline zero)';
    return `${((a - b) / b * 100).toFixed(1)}%`;
  };

  const comparison: ComparisonBlock[] = [
    {
      metric: 'Median total time',
      class: 'measured',
      with_lynx: `${withSummary.total_time_ms.median}ms`,
      without_lynx: `${withoutSummary.total_time_ms.median}ms`,
      delta: deltaPct(withSummary.total_time_ms.median, withoutSummary.total_time_ms.median),
      interpretation: withSummary.total_time_ms.median < withoutSummary.total_time_ms.median
        ? `LYNX is ${Math.abs(Math.round((withSummary.total_time_ms.median - withoutSummary.total_time_ms.median) / withoutSummary.total_time_ms.median * 100))}% faster`
        : 'No speed advantage detected',
    },
    {
      metric: 'Files opened (median)',
      class: 'measured',
      with_lynx: `${withSummary.files_opened.median}`,
      without_lynx: `${withoutSummary.files_opened.median}`,
      delta: deltaPct(withSummary.files_opened.median, withoutSummary.files_opened.median),
      interpretation: `LYNX reduces file opens by ${Math.abs(Math.round((withSummary.files_opened.median - withoutSummary.files_opened.median) / Math.max(withoutSummary.files_opened.median, 1) * 100))}%`,
    },
    {
      metric: 'Bytes read (median)',
      class: 'measured',
      with_lynx: `${withSummary.bytes_read.median}`,
      without_lynx: `${withoutSummary.bytes_read.median}`,
      delta: deltaPct(withSummary.bytes_read.median, withoutSummary.bytes_read.median),
      interpretation: 'Bytes read from disk during task execution',
    },
    {
      metric: 'Tool calls (median)',
      class: 'measured',
      with_lynx: `${withSummary.tool_calls.median}`,
      without_lynx: `${withoutSummary.tool_calls.median}`,
      delta: deltaPct(withSummary.tool_calls.median, withoutSummary.tool_calls.median),
      interpretation: 'One LYNX call replaces multiple grep/read operations',
    },
    {
      metric: 'Functional success rate',
      class: 'measured',
      with_lynx: `${(withSummary.functional_success_rate * 100).toFixed(0)}%`,
      without_lynx: `${(withoutSummary.functional_success_rate * 100).toFixed(0)}%`,
      delta: deltaPct(withSummary.functional_success_rate, withoutSummary.functional_success_rate),
      interpretation: 'Correctness of task results',
    },
    {
      metric: 'LLM calls',
      class: 'measured',
      with_lynx: `${withSummary.llm_calls.median}`,
      without_lynx: `${withoutSummary.llm_calls.median}`,
      delta: '0%',
      interpretation: 'LLM reranking disabled in benchmark (enable_llm=false)',
    },
  ];

  const sampleSize = withRuns.length;
  const roiBlocked = sampleSize < 6;
  const roiBlockedReason = roiBlocked
    ? `Sample size too small for ROI claims (${sampleSize} runs, need at least 6). Run with --rounds 3 or more.`
    : null;

  return {
    with_lynx: withSummary,
    without_lynx: withoutSummary,
    comparison,
    sample_size_note: `Based on ${sampleSize} measured runs (${config.measuredRounds} round(s) x ${taskCount} tasks x 2 conditions). ${
      sampleSize < 6
        ? 'Sample too small for statistical significance. Increase --rounds.'
        : 'Minimum sample size met.'
    }`,
    roi_blocked: roiBlocked,
    roi_blocked_reason: roiBlockedReason,
  };
}

export function buildMethodology(): MethodologySection[] {
  return [
    {
      heading: 'Design',
      body: '5 deterministic tasks executed under two conditions: with_lynx (using LYNX MCP graph tools: search_graph, trace_path, explain_symbol, find_tests) and without_lynx (using standard Unix tools: grep, file reads). Tasks are counterbalanced: half the cohort runs with_lynx first, half without_lynx first, to control for order effects.',
    },
    {
      heading: 'Tasks',
      body: '1) find_definition — locate function definition; 2) find_callers — trace inbound callers; 3) change_impact — assess interface change impact; 4) find_tests — locate test functions; 5) locate_definitions — batch symbol lookup. Each task has a deterministic expected answer verified post-hoc.',
    },
    {
      heading: 'Metric classification',
      body: 'Every metric is tagged as measured (actual wall-clock or count), estimated (extrapolated from constants, e.g. LLM cost), or scenario (hypothetical, not based on real data). Different classes are never summed. ROI claims are blocked when the baseline is invalid or sample size is insufficient (n < 6).',
    },
    {
      heading: 'Isolation',
      body: 'Each benchmark run creates a temp directory with a self-contained fixture project. LYNX_HOME is set to a temp directory so zero writes hit ~/.lynx. The fixture is indexed in-memory. LLM reranking is disabled (enable_llm=false) for deterministic results.',
    },
    {
      heading: 'Limitations',
      body: 'The without_lynx condition simulates developer behavior via grep + file reads — it cannot capture the cognitive overhead of manual code exploration. Tasks are small and targeted; real-world tasks involve more ambiguity. LLM cost estimates use LYNX pricing constants and may differ from actual API costs.',
    },
  ];
}

// ── Math helpers ──────────────────────────────────────────────

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

// ── Output generators ─────────────────────────────────────────

export function resultToJSON(result: ABBenchmarkResult): string {
  return JSON.stringify(
    {
      config: result.config,
      methodology: result.methodology,
      summary: result.summary,
      tasks: result.tasks.map(r => ({
        task_id: r.task_id,
        condition: r.condition,
        order_position: r.order_position,
        metrics: Object.fromEntries(
          Object.entries(r.metrics).map(([k, v]) => [k, { value: v.value, class: v.class }])
        ),
        correct: r.correct,
        errors: r.errors,
      })),
      warnings: result.warnings,
    },
    null,
    2
  );
}

export function resultToCSV(result: ABBenchmarkResult): string {
  const metricNames = Object.keys(result.tasks[0]?.metrics || {});
  const header = [
    'task_id',
    'condition',
    'order_position',
    'correct',
    ...metricNames.map(m => `${m}_value`),
    ...metricNames.map(m => `${m}_class`),
    'errors',
  ];
  const rows = result.tasks.map(r => {
    const metricsRecord = r.metrics as unknown as Record<string, ABMetric>;
    const vals = metricNames.map(m => String(metricsRecord[m]?.value ?? ''));
    const classes = metricNames.map(m => metricsRecord[m]?.class ?? '');
    return [
      r.task_id,
      r.condition,
      String(r.order_position),
      String(r.correct),
      ...vals,
      ...classes,
      `"${(r.errors || []).join('; ')}"`,
    ];
  });
  return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export function resultToHTML(result: ABBenchmarkResult): string {
  const comparisonRows = result.summary.comparison.map(c =>
    `<tr><td>${c.metric}</td><td class="cls-${c.class}">${c.class}</td><td>${c.with_lynx}</td><td>${c.without_lynx}</td><td>${c.delta}</td><td>${c.interpretation}</td></tr>`
  ).join('\n');

  const taskRows = result.tasks.map(r =>
    `<tr class="${r.correct ? 'pass' : 'fail'}"><td>${r.task_id}</td><td>${r.condition}</td><td>${r.order_position}</td><td>${r.correct ? 'yes' : 'no'}</td><td>${r.metrics.total_time_ms.value}ms</td><td>${r.metrics.files_opened.value}</td><td>${r.metrics.functional_success.value}</td><td>${(r.errors || []).join('; ')}</td></tr>`
  ).join('\n');

  const methodologySections = result.methodology.map(s =>
    `<section><h3>${s.heading}</h3><p>${s.body}</p></section>`
  ).join('\n');

  const warningsHTML = result.warnings.length > 0
    ? `<div class="warnings"><h2>Warnings</h2><ul>${result.warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>`
    : '';

  const roiBlocked = result.summary.roi_blocked
    ? `<div class="roi-blocked"><strong>ROI claims blocked:</strong> ${result.summary.roi_blocked_reason}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>LYNX A/B Benchmark</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 20px; background: #fff; color: #222; }
h1, h2 { border-bottom: 2px solid #eee; padding-bottom: 8px; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 14px; }
th { background: #f5f5f5; }
.pass { background: #e8f5e9; }
.fail { background: #ffebee; }
.cls-measured { color: #2e7d32; font-weight: 600; }
.cls-estimated { color: #e65100; font-weight: 600; }
.cls-scenario { color: #6a1b9a; font-weight: 600; }
.warnings { background: #fff3e0; padding: 12px 20px; margin: 16px 0; border-left: 4px solid #ff9800; }
.roi-blocked { background: #ffebee; padding: 12px 20px; margin: 16px 0; border-left: 4px solid #f44336; }
.summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.summary-card { background: #fafafa; padding: 16px; border-radius: 8px; border: 1px solid #e0e0e0; }
section { margin: 16px 0; }
</style>
</head>
<body>
<h1>LYNX A/B Benchmark Results</h1>
<p>Seed: ${result.config.seed} | Rounds: ${result.config.measuredRounds} | Tasks: ${result.tasks.length / (2 * result.config.measuredRounds)}</p>
${warningsHTML}${roiBlocked}

<h2>Comparison</h2>
<table>
<thead><tr><th>Metric</th><th>Class</th><th>With LYNX</th><th>Without LYNX</th><th>Delta</th><th>Interpretation</th></tr></thead>
<tbody>${comparisonRows}</tbody>
</table>

<div class="summary-grid">
<div class="summary-card"><h3>With LYNX</h3>
<p>Median time: ${result.summary.with_lynx.total_time_ms.median}ms | Success: ${(result.summary.with_lynx.functional_success_rate * 100).toFixed(0)}%</p>
<p>Files: ${result.summary.with_lynx.files_opened.median} median | Bytes: ${result.summary.with_lynx.bytes_read.median} median</p>
</div>
<div class="summary-card"><h3>Without LYNX</h3>
<p>Median time: ${result.summary.without_lynx.total_time_ms.median}ms | Success: ${(result.summary.without_lynx.functional_success_rate * 100).toFixed(0)}%</p>
<p>Files: ${result.summary.without_lynx.files_opened.median} median | Bytes: ${result.summary.without_lynx.bytes_read.median} median</p>
</div>
</div>

<h2>Methodology</h2>
${methodologySections}

<h2>Sample Size</h2>
<p>${result.summary.sample_size_note}</p>

<h2>Per-Task Results</h2>
<table>
<thead><tr><th>Task</th><th>Condition</th><th>Pos</th><th>Correct</th><th>Time</th><th>Files</th><th>Success</th><th>Errors</th></tr></thead>
<tbody>${taskRows}</tbody>
</table>

<p><small>Generated: ${new Date().toISOString()}</small></p>
</body>
</html>`;
}

