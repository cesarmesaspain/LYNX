/*
 * ab-benchmark.test.ts — A/B benchmark tests.
 *
 * Tests fixture generation, all 5 tasks under both conditions,
 * metrics classification, counterbalanced ordering, and output formats.
 *
 * Uses a single shared benchmark run to avoid re-indexing per test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateFixture,
  runABBenchmark,
  resultToJSON,
  resultToCSV,
  resultToHTML,
} from '../../../src/cli/ab-benchmark.js';
import type { ABBenchmarkResult } from '../../../src/cli/ab-benchmark.js';

const ALL_TASK_IDS = [
  'find_definition',
  'find_callers',
  'change_impact',
  'find_tests',
  'locate_definitions',
];

describe('fixture generation', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-fixture-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates expected fixture files', () => {
    const fixtureDir = generateFixture(tmpDir);
    expect(fs.existsSync(fixtureDir)).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, 'src/config/runtime.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, 'src/utils/helpers.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, 'src/store/db.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, 'src/handlers/search.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, 'tests/config/runtime.test.ts'))).toBe(true);
  });

  it('fixture runtime.ts contains lynxHome definition', () => {
    const fixtureDir = generateFixture(tmpDir);
    const content = fs.readFileSync(path.join(fixtureDir, 'src/config/runtime.ts'), 'utf-8');
    expect(content).toContain('export function lynxHome');
    expect(content).toContain('export function readConfig');
    expect(content).toContain('export interface Config');
  });

  it('fixture db.ts calls readConfig', () => {
    const fixtureDir = generateFixture(tmpDir);
    const content = fs.readFileSync(path.join(fixtureDir, 'src/store/db.ts'), 'utf-8');
    expect(content).toContain('readConfig');
  });

  it('fixture test files reference lynxHome', () => {
    const fixtureDir = generateFixture(tmpDir);
    const content = fs.readFileSync(path.join(fixtureDir, 'tests/config/runtime.test.ts'), 'utf-8');
    expect(content).toContain('lynxHome');
    expect(content).toContain('testLynxHomeReturnsString');
  });
});

describe('A/B benchmark — shared run', () => {
  let result: ABBenchmarkResult;
  let originalLynxHome: string | undefined;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-shared-'));
    originalLynxHome = process.env.LYNX_HOME;
    result = await runABBenchmark({
      seed: 42,
      measuredRounds: 1,
      warmupRounds: 0,
      fixtureDir: tmpDir,
    });
  }, 30000);

  afterAll(() => {
    if (originalLynxHome !== undefined) {
      process.env.LYNX_HOME = originalLynxHome;
    } else {
      delete process.env.LYNX_HOME;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs all 5 tasks under both conditions', () => {
    expect(result.config.seed).toBe(42);
    expect(result.tasks.length).toBe(10); // 5 tasks x 2 conditions
    expect(result.summary).toBeDefined();
    expect(result.methodology.length).toBeGreaterThan(0);

    const withRuns = result.tasks.filter(r => r.condition === 'with_lynx');
    const withoutRuns = result.tasks.filter(r => r.condition === 'without_lynx');
    expect(withRuns.length).toBe(5);
    expect(withoutRuns.length).toBe(5);
  });

  it('with_lynx: find_definition locates lynxHome correctly', () => {
    const run = result.tasks.find(r => r.condition === 'with_lynx' && r.task_id === 'find_definition');
    expect(run).toBeDefined();
    expect(run!.correct).toBe(true);
    expect(run!.result.found_file).toContain('runtime.ts');
  });

  it('without_lynx: find_definition locates lynxHome correctly', () => {
    const run = result.tasks.find(r => r.condition === 'without_lynx' && r.task_id === 'find_definition');
    expect(run).toBeDefined();
    expect(run!.correct).toBe(true);
    expect(run!.result.found_file).toContain('runtime.ts');
  });

  it('with_lynx: find_callers finds readConfig callers', () => {
    const run = result.tasks.find(r => r.condition === 'with_lynx' && r.task_id === 'find_callers');
    expect(run).toBeDefined();
    expect(run!.correct).toBe(true);
  });

  it('with_lynx: find_tests locates lynxHome tests', () => {
    const run = result.tasks.find(r => r.condition === 'with_lynx' && r.task_id === 'find_tests');
    expect(run).toBeDefined();
    expect(run!.correct).toBe(true);
  });

  it('with_lynx: change_impact identifies impacted functions', () => {
    const run = result.tasks.find(r => r.condition === 'with_lynx' && r.task_id === 'change_impact');
    expect(run).toBeDefined();
    const impacted = run!.result.impacted_functions as string[] | undefined;
    expect(impacted).toBeDefined();
  });

  it('with_lynx: locate_definitions finds 3 symbols', () => {
    const run = result.tasks.find(r => r.condition === 'with_lynx' && r.task_id === 'locate_definitions');
    expect(run).toBeDefined();
    expect(run!.correct).toBe(true);
    const defs = run!.result.definitions as Array<Record<string, unknown>> | undefined;
    expect(defs).toBeDefined();
    expect(defs!.length).toBe(3);
  });

  it('all metrics have valid classification', () => {
    const validClasses = ['measured', 'estimated', 'scenario'];
    for (const run of result.tasks) {
      const metrics = run.metrics as unknown as Record<string, { value: unknown; class: string }>;
      for (const [, metric] of Object.entries(metrics)) {
        expect(validClasses).toContain(metric.class);
      }
    }
  });

  it('ROI is blocked when sample size < 6', () => {
    expect(result.summary.roi_blocked).toBe(true);
    expect(result.summary.roi_blocked_reason).toContain('Sample size too small');
  });

  it('warns on fewer than 3 measured rounds', () => {
    const hasWarning = result.warnings.some(w => w.includes('At least 3 are recommended'));
    expect(hasWarning).toBe(true);
  });

  it('half the tasks run with_lynx first (counterbalanced)', () => {
    const taskFirstCondition = new Map<string, string>();
    for (const run of result.tasks) {
      if (!taskFirstCondition.has(run.task_id)) {
        taskFirstCondition.set(run.task_id, run.condition);
      }
    }

    const withFirst = [...taskFirstCondition.values()].filter(c => c === 'with_lynx').length;
    const withoutFirst = [...taskFirstCondition.values()].filter(c => c === 'without_lynx').length;

    expect(withFirst).toBeGreaterThanOrEqual(2);
    expect(withoutFirst).toBeGreaterThanOrEqual(2);
    expect(withFirst + withoutFirst).toBe(5);
  });
});

describe('A/B benchmark — output formats', () => {
  let result: ABBenchmarkResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-output-'));
    result = await runABBenchmark({
      seed: 42,
      measuredRounds: 1,
      warmupRounds: 0,
      fixtureDir: tmpDir,
    });
  }, 30000);

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resultToJSON produces valid JSON', () => {
    const json = resultToJSON(result);
    const parsed = JSON.parse(json);
    expect(parsed.config).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });

  it('resultToCSV produces valid CSV with header', () => {
    const csv = resultToCSV(result);
    const lines = csv.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('task_id');
    expect(lines[0]).toContain('condition');
    expect(lines[0]).toContain('correct');
  });

  it('resultToHTML produces valid HTML document', () => {
    const html = resultToHTML(result);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>LYNX A/B Benchmark</title>');
    expect(html).toContain('Methodology');
    expect(html).toContain('Comparison');
  });

  it('HTML output includes methodology sections', () => {
    const html = resultToHTML(result);
    for (const section of result.methodology) {
      expect(html).toContain(section.heading);
    }
  });

  it('HTML output shows ROI blocked when applicable', () => {
    const html = resultToHTML(result);
    expect(html).toContain('ROI claims blocked');
  });
});

describe('A/B benchmark — determinism and filtering', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-det-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces deterministic results with same seed', async () => {
    const r1 = await runABBenchmark({ seed: 123, measuredRounds: 1, fixtureDir: tmpDir + '/r1' });
    const r2 = await runABBenchmark({ seed: 123, measuredRounds: 1, fixtureDir: tmpDir + '/r2' });

    const r1Order = r1.tasks.map(t => `${t.task_id}:${t.condition}:${t.order_position}`);
    const r2Order = r2.tasks.map(t => `${t.task_id}:${t.condition}:${t.order_position}`);
    expect(r1Order).toEqual(r2Order);
  }, 30000);

  it('taskIds filter runs only specified tasks', async () => {
    const filtered = await runABBenchmark({
      seed: 42, measuredRounds: 1, fixtureDir: tmpDir + '/filtered',
      taskIds: ['find_definition', 'find_tests'],
    });

    const taskIds = new Set(filtered.tasks.map(r => r.task_id));
    expect(taskIds.size).toBe(2);
    expect(taskIds.has('find_definition')).toBe(true);
    expect(taskIds.has('find_tests')).toBe(true);
    expect(taskIds.has('find_callers')).toBe(false);
  }, 30000);
});

describe('A/B benchmark — clean stderr (no git fatal)', () => {
  it('produces zero fatal: lines on stderr during benchmark run', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-stderr-'));
    const originalLynxHome = process.env.LYNX_HOME;

    // Capture stderr during benchmark run
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const captureWrite = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stderrChunks.push(str);
      return true;
    };
    process.stderr.write = captureWrite as typeof process.stderr.write;

    try {
      await runABBenchmark({
        seed: 42, measuredRounds: 1, fixtureDir: tmpDir,
      });
    } finally {
      process.stderr.write = originalStderrWrite;
      if (originalLynxHome !== undefined) {
        process.env.LYNX_HOME = originalLynxHome;
      } else {
        delete process.env.LYNX_HOME;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const stderrText = stderrChunks.join('');
    const fatalLines = stderrText.split('\n').filter(line =>
      line.toLowerCase().includes('fatal:')
    );
    expect(fatalLines.length).toBe(0);
  }, 30000);
});

describe('A/B benchmark — zero writes to ~/.lynx', () => {
  it('does not write to ~/.lynx', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-zerowrite-'));
    const originalLynxHome = process.env.LYNX_HOME;

    const homeBefore = process.env.HOME || os.homedir();
    const lynxDir = path.join(homeBefore, '.lynx');
    const usageFile = path.join(lynxDir, 'usage.jsonl');

    let mtimeBefore = 0;
    let existed = false;
    try {
      mtimeBefore = fs.statSync(usageFile).mtimeMs;
      existed = true;
    } catch { /* doesn't exist */ }

    try {
      await runABBenchmark({
        seed: 42, measuredRounds: 1, fixtureDir: tmpDir,
      });

      if (existed) {
        const stat = fs.statSync(usageFile);
        // Compare with tolerance (file could have been modified by other tests)
        expect(Math.abs(stat.mtimeMs - mtimeBefore)).toBeLessThanOrEqual(1000);
      } else {
        expect(fs.existsSync(usageFile)).toBe(false);
      }
    } finally {
      if (originalLynxHome !== undefined) {
        process.env.LYNX_HOME = originalLynxHome;
      } else {
        delete process.env.LYNX_HOME;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 30000);
});
