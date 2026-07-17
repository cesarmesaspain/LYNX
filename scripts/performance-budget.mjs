import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynxDatabase } from '../dist/store/database.js';
import { runPipeline } from '../dist/pipeline/orchestrator.js';
import { searchFullText } from '../dist/store/search.js';
import { summarizePerformance } from '../dist/quality/performance-budget.js';

const BUDGETS_MS = Object.freeze({
  exact_graph_search_p95: 100,
  noop_incremental_index_p95: 250,
});

const root = mkdtempSync(join(tmpdir(), 'lynx-performance-budget-'));
const project = 'performance-budget-fixture';
const db = LynxDatabase.openMemory();

try {
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 40; index++) {
    const dependency = index === 0 ? '' : `import { operation${index - 1} } from './module-${index - 1}.js';\n`;
    const body = index === 0 ? 'return input + 1;' : `return operation${index - 1}(input) + 1;`;
    writeFileSync(
      join(root, 'src', `module-${index}.ts`),
      `${dependency}export function operation${index}(input: number): number { ${body} }\n`,
    );
  }

  await runPipeline(db, root, project, { mode: 'fast', incremental: false, testSkipProjectBrief: true });

  for (let index = 0; index < 10; index++) searchFullText(db, project, 'operation20', 8);
  const searchSamples = [];
  for (let index = 0; index < 100; index++) {
    const startedAt = performance.now();
    searchFullText(db, project, `operation${index % 40}`, 8);
    searchSamples.push(performance.now() - startedAt);
  }

  await runPipeline(db, root, project, { mode: 'fast', incremental: true, testSkipProjectBrief: true });
  const incrementalSamples = [];
  for (let index = 0; index < 20; index++) {
    const startedAt = performance.now();
    const result = await runPipeline(db, root, project, { mode: 'fast', incremental: true, testSkipProjectBrief: true });
    incrementalSamples.push(performance.now() - startedAt);
    if (result.filesProcessed !== 0) {
      throw new Error(`No-op incremental run processed ${result.filesProcessed} files.`);
    }
  }

  const operations = {
    exact_graph_search: {
      ...summarizePerformance(searchSamples),
      raw_samples_ms: searchSamples.map((value) => Number(value.toFixed(3))),
    },
    noop_incremental_index: {
      ...summarizePerformance(incrementalSamples),
      raw_samples_ms: incrementalSamples.map((value) => Number(value.toFixed(3))),
    },
  };
  const failures = [];
  if (operations.exact_graph_search.p95_ms > BUDGETS_MS.exact_graph_search_p95) {
    failures.push('exact_graph_search_p95');
  }
  if (operations.noop_incremental_index.p95_ms > BUDGETS_MS.noop_incremental_index_p95) {
    failures.push('noop_incremental_index_p95');
  }
  const report = {
    contract_version: 1,
    fixture: '<temporary-local-fixture>',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    budgets_ms: BUDGETS_MS,
    operations,
    passed: failures.length === 0,
    failures,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.LYNX_PERFORMANCE_OUTPUT) {
    mkdirSync(join(process.env.LYNX_PERFORMANCE_OUTPUT, '..'), { recursive: true });
    writeFileSync(process.env.LYNX_PERFORMANCE_OUTPUT, serialized);
  }
  process.stdout.write(serialized);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
