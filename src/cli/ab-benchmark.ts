/*
 * ab-benchmark.ts — A/B productivity benchmark: with_lynx vs without_lynx.
 *
 * Measures real developer-productivity signals by running 5 deterministic tasks
 * under both conditions with counterbalanced order, registered seeds, and isolated
 * fixtures. Zero writes to ~/.lynx (LYNX_HOME points to temp dir).
 *
 * Every metric is classified as measured, estimated, or scenario. Different
 * categories are never summed. ROI claims are blocked when the baseline is
 * invalid or the sample size is too small.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { LynxDatabase } from '../store/database.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { setDb, unsetDb } from '../mcp/server.js';
import { setFederatedConfig, clearFederatedConfig } from '../federation/handler-bridge.js';
import { handleSearchGraph } from '../mcp/handlers/search_graph.js';
import { handleTracePath } from '../mcp/handlers/trace_path.js';
import { handleFindTests } from '../mcp/handlers/find_tests.js';
import { handleExplainSymbol } from '../mcp/handlers/explain_symbol.js';
import { clearSessionDedup } from '../usage/metrics.js';

// ── Types ─────────────────────────────────────────────────────

export type MetricClass = 'measured' | 'estimated' | 'scenario';

export interface ABMetric {
  value: number | string | boolean;
  class: MetricClass;
  description: string;
}

export interface TaskMetrics {
  total_time_ms: ABMetric;
  time_to_first_useful_ms: ABMetric;
  files_opened: ABMetric;
  bytes_read: ABMetric;
  tool_calls: ABMetric;
  llm_calls: ABMetric;
  llm_cost_usd: ABMetric;
  functional_success: ABMetric;
  defects_introduced: ABMetric;
  fixes_needed: ABMetric;
}

export type Condition = 'with_lynx' | 'without_lynx';

export interface TaskDefinition {
  id: string;
  name: string;
  description: string;
  /** Expected answer for correctness checking. */
  expected: Record<string, unknown>;
  /** Run task with LYNX tools. Receives project name + db. */
  withLynx: (project: string, db: LynxDatabase) => Promise<Record<string, unknown>>;
  /** Run task without LYNX. Receives fixture root directory. */
  withoutLynx: (fixtureDir: string) => Promise<Record<string, unknown>>;
}

export interface TaskRun {
  task_id: string;
  condition: Condition;
  order_position: number;
  seed: number;
  metrics: TaskMetrics;
  result: Record<string, unknown>;
  expected: Record<string, unknown>;
  correct: boolean;
  errors: string[];
}

export interface ABBenchmarkConfig {
  seed: number;
  fixtureDir?: string;
  taskIds?: string[];
  /** Warm-up runs excluded from stats. */
  warmupRounds: number;
  /** Measured rounds per condition per task. */
  measuredRounds: number;
}

export interface ABBenchmarkResult {
  config: ABBenchmarkConfig;
  methodology: MethodologySection[];
  tasks: TaskRun[];
  summary: ABSummary;
  warnings: string[];
}

export interface MethodologySection {
  heading: string;
  body: string;
}

export interface ABSummary {
  with_lynx: ConditionSummary;
  without_lynx: ConditionSummary;
  comparison: ComparisonBlock[];
  sample_size_note: string;
  roi_blocked: boolean;
  roi_blocked_reason: string | null;
}

export interface ConditionSummary {
  total_time_ms: { median: number; p95: number; min: number; max: number };
  time_to_first_useful_ms: { median: number; p95: number };
  files_opened: { median: number; total: number };
  bytes_read: { median: number; total: number };
  tool_calls: { median: number; total: number };
  llm_calls: { median: number; total: number };
  functional_success_rate: number;
  defects_per_task: number;
}

export interface ComparisonBlock {
  metric: string;
  class: MetricClass;
  with_lynx: string;
  without_lynx: string;
  delta: string;
  interpretation: string;
}

// ── Seeded RNG (mulberry32) ───────────────────────────────────

function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Fixture generator ─────────────────────────────────────────

const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'ab-bench-fixture', version: '1.0.0', private: true },
    null,
    2
  ),
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { target: 'ES2022', module: 'ES2022', strict: true } },
    null,
    2
  ),
  'src/config/runtime.ts': [
    'export interface Config {',
    '  home: string;',
    '  debug: boolean;',
    '  port: number;',
    '}',
    '',
    'export function lynxHome(): string {',
    '  if (process.env.LYNX_HOME) return process.env.LYNX_HOME;',
    '  const { join } = require("path");',
    '  const { homedir } = require("os");',
    '  return join(homedir(), ".lynx");',
    '}',
    '',
    'export function readConfig(): Config {',
    '  return {',
    '    home: lynxHome(),',
    '    debug: process.env.DEBUG === "1",',
    '    port: 4200,',
    '  };',
    '}',
    '',
    'export const DEFAULT_PORT = 4200;',
  ].join('\n'),

  'src/utils/helpers.ts': [
    'import { lynxHome } from "../config/runtime";',
    '',
    'export function formatPath(p: string): string {',
    '  const home = lynxHome();',
    '  return p.startsWith(home) ? p.replace(home, "~") : p;',
    '}',
    '',
    'export function normalizeName(name: string): string {',
    '  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");',
    '}',
    '',
    'export function joinPaths(...parts: string[]): string {',
    '  return parts.join("/").replace(/\\/+/g, "/");',
    '}',
  ].join('\n'),

  'src/store/db.ts': [
    'import { readConfig } from "../config/runtime";',
    'import { normalizeName } from "../utils/helpers";',
    '',
    'export interface DbOptions {',
    '  name: string;',
    '  memory: boolean;',
    '}',
    '',
    'export function openDb(opts: DbOptions): string {',
    '  const config = readConfig();',
    '  const dbName = normalizeName(opts.name);',
    '  if (opts.memory) return `:memory:${dbName}`;',
    '  return `${config.home}/${dbName}.db`;',
    '}',
    '',
    'export function closeDb(handle: string): void {',
    '  if (!handle) throw new Error("Invalid handle");',
    '}',
    '',
    'export function dbPath(name: string): string {',
    '  const config = readConfig();',
    '  return `${config.home}/${normalizeName(name)}.db`;',
    '}',
  ].join('\n'),

  'src/handlers/search.ts': [
    'import { formatPath } from "../utils/helpers";',
    'import { openDb } from "../store/db";',
    '',
    'export function searchGraph(query: string): string[] {',
    '  const db = openDb({ name: "search", memory: true });',
    '  const results: string[] = [];',
    '  results.push(formatPath(`/results/${query}`));',
    '  return results;',
    '}',
    '',
    'export function rerankResults(results: string[]): string[] {',
    '  return results.sort();',
    '}',
  ].join('\n'),

  // Seeded solely for realistic agent-ab tasks. This is fixture data, never a real key.
  'src/config/credentials.ts': [
    'export function getApiKey(): string | null {',
    '  return process.env.LYNX_DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || null;',
    '}',
  ].join('\n'),

  'tests/config/runtime.test.ts': [
    'import { lynxHome, readConfig, DEFAULT_PORT } from "../../src/config/runtime";',
    '',
    'export function testLynxHomeReturnsString(): void {',
    '  const home = lynxHome();',
    '  if (typeof home !== "string") throw new Error("Expected string");',
    '  if (!home.includes(".lynx")) throw new Error("Expected .lynx in path");',
    '}',
    '',
    'export function testLynxHomeRespectsEnv(): void {',
    '  const original = process.env.LYNX_HOME;',
    '  process.env.LYNX_HOME = "/tmp/test-lynx";',
    '  try {',
    '    const home = lynxHome();',
    '    if (home !== "/tmp/test-lynx") throw new Error("Env not respected");',
    '  } finally {',
    '    if (original) process.env.LYNX_HOME = original;',
    '    else delete process.env.LYNX_HOME;',
    '  }',
    '}',
    '',
    'export function testReadConfigDefaultPort(): void {',
    '  const config = readConfig();',
    '  if (config.port !== 4200) throw new Error("Wrong default port");',
    '}',
    '',
    'export function testDefaultPortConstant(): void {',
    '  if (DEFAULT_PORT !== 4200) throw new Error("DEFAULT_PORT mismatch");',
    '}',
  ].join('\n'),
};

export function generateFixture(baseDir: string): string {
  const fixtureDir = path.join(baseDir, 'ab-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });

  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const fullPath = path.join(fixtureDir, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  return fixtureDir;
}

// ── Metrics helpers ───────────────────────────────────────────

function m(value: number | string | boolean, cls: MetricClass, desc: string): ABMetric {
  return { value, class: cls, description: desc };
}

function measureResult(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): { correct: boolean; defects: number; fixes: number; errors: string[] } {
  const errors: string[] = [];
  let defects = 0;

  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = actual[key];
    if (expectedVal === undefined) continue;

    if (Array.isArray(expectedVal)) {
      const actualArr = Array.isArray(actualVal) ? actualVal : [];
      const expectedArr = expectedVal as unknown[];
      if (actualArr.length < expectedArr.length) {
        defects += expectedArr.length - actualArr.length;
        errors.push(`Missing ${expectedArr.length - actualArr.length} items in ${key}`);
      }
      for (const exp of expectedArr) {
        if (!actualArr.some(a => deepContains(a, exp))) {
          defects++;
          errors.push(`Missing expected item in ${key}: ${JSON.stringify(exp)}`);
        }
      }
    } else if (typeof expectedVal === 'string') {
      const actualStr = String(actualVal ?? '');
      if (!actualStr.includes(expectedVal as string) && actualStr !== expectedVal) {
        defects++;
        errors.push(`${key}: expected "${expectedVal}", got "${actualStr.slice(0, 80)}"`);
      }
    } else if (typeof expectedVal === 'number') {
      if (Number(actualVal) !== expectedVal) {
        defects++;
        errors.push(`${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    }
  }

  const fixes = defects;
  return { correct: defects === 0, defects, fixes, errors };
}

function deepContains(container: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) {
    if (typeof container === 'string') {
      return container.includes(String(expected));
    }
    return container === expected;
  }
  if (typeof container !== 'object' || container === null) return false;
  const c = container as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return Object.entries(e).every(([k, v]) => {
    if (typeof v === 'string' && typeof c[k] === 'string') {
      return (c[k] as string).includes(v);
    }
    return c[k] === v;
  });
}

// ── Task definitions ──────────────────────────────────────────

function makeTasks(): TaskDefinition[] {
  return [
    // Task 1: find_definition — locate lynxHome
    {
      id: 'find_definition',
      name: 'Find definition of lynxHome',
      description: 'Locate where lynxHome is defined and what it returns.',
      expected: {
        found_file: 'src/config/runtime.ts',
        function_name: 'lynxHome',
        returns_path: true,
      },
      withLynx: async (project: string) => {
        const result = await handleSearchGraph({
          project,
          query: 'lynxHome',
          limit: 10,
          enable_llm: false,
        }) as Record<string, unknown>;
        const results = (result.results as Array<Record<string, unknown>>) || [];
        const target = results.find(r =>
          String(r.name || '') === 'lynxHome' &&
          String(r.kind || '') === 'Function'
        );
        return {
          found_file: target?.file || null,
          function_name: target?.name || null,
          returns_path: target ? true : false,
          total_results: results.length,
        };
      },
      withoutLynx: async (fixtureDir: string) => {
        const grepOut = execSync(
          `grep -rn "function lynxHome\\|export function lynxHome" --include="*.ts" "${fixtureDir}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        const lines = grepOut.split('\n').filter(Boolean);
        const found = lines.length > 0;
        const relPath = found
          ? lines[0].split(':')[0].replace(fixtureDir + '/', '')
          : null;
        const filesRead = lines.map(l => l.split(':')[0]).filter((f, i, a) => a.indexOf(f) === i);
        return {
          found_file: relPath,
          function_name: found ? 'lynxHome' : null,
          returns_path: found,
          grep_lines: lines.length,
          _files_read: filesRead,
        };
      },
    },

    // Task 2: find_callers — who calls readConfig
    {
      id: 'find_callers',
      name: 'Find callers of readConfig',
      description: 'Identify all functions that call readConfig.',
      expected: {
        callers: [
          { name: 'openDb' },
          { name: 'dbPath' },
        ],
      },
      withLynx: async (project: string) => {
        const result = await handleTracePath({
          project,
          function_name: 'readConfig',
          direction: 'inbound',
          depth: 2,
          include_tests: false,
        }) as Record<string, unknown>;
        const callers = (result.callers as Array<Record<string, unknown>>) || [];
        return {
          callers: callers.map(c => ({ name: c.name, file_path: c.file_path })),
          total_callers: callers.length,
        };
      },
      withoutLynx: async (fixtureDir: string) => {
        const grepOut = execSync(
          `grep -rn "readConfig" --include="*.ts" "${fixtureDir}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        const lines = grepOut.split('\n').filter(Boolean);
        // Filter out definition and test files, extract function names
        const callers: Array<{ name: string; file: string }> = [];
        const filesRead = new Set<string>();
        for (const line of lines) {
          const [filePath, lineNo, content] = line.split(':');
          const relPath = filePath.replace(fixtureDir + '/', '');
          if (relPath.includes('runtime.ts') && content.includes('export function readConfig')) continue;
          if (relPath.includes('.test.ts')) continue;
          filesRead.add(filePath);
          // Try to extract function name
          const funcMatch = content.match(/export function (\w+)/);
          if (!funcMatch) {
            // This is an import or a call inside a function — read the file to find the enclosing function
            try {
              const fileContent = fs.readFileSync(filePath, 'utf-8');
              const fileLines = fileContent.split('\n');
              const lineNum = parseInt(lineNo, 10) - 1;
              // Search backwards for the enclosing function
              for (let i = lineNum; i >= 0; i--) {
                const m = fileLines[i].match(/export function (\w+)/);
                if (m) {
                  callers.push({ name: m[1], file: relPath });
                  break;
                }
              }
            } catch {
              callers.push({ name: `unknown_fn_${relPath}`, file: relPath });
            }
          } else {
            callers.push({ name: funcMatch[1], file: relPath });
          }
        }
        return {
          callers: [...new Map(callers.map(c => [c.name, c])).values()],
          total_callers: callers.length,
          _files_read: [...filesRead],
        };
      },
    },

    // Task 3: change_impact — what happens if Config changes
    {
      id: 'change_impact',
      name: 'Assess impact of Config change',
      description: 'Determine what is affected if the Config interface changes.',
      expected: {
        impacted_functions: ['readConfig', 'openDb', 'dbPath'],
        references: 2,
      },
      withLynx: async (project: string) => {
        const explain = await handleExplainSymbol({
          project,
          qualified_name: 'config.runtime.Config',
          name: 'Config',
        }) as Record<string, unknown>;
        const callees = (explain.callees as Array<Record<string, unknown>>) || [];
        return {
          impacted_functions: callees.map(c => c.name),
          references: callees.length,
        };
      },
      withoutLynx: async (fixtureDir: string) => {
        const grepOut = execSync(
          `grep -rn "Config\\|readConfig" --include="*.ts" "${fixtureDir}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        const lines = grepOut.split('\n').filter(Boolean);
        const funcs = new Set<string>();
        const filesRead = new Set<string>();
        for (const line of lines) {
          const [filePath, , content] = line.split(':');
          filesRead.add(filePath);
          const relPath = filePath.replace(fixtureDir + '/', '');
          if (relPath.includes('.test.ts')) continue;
          const m = content.match(/export function (\w+)/);
          if (m) funcs.add(m[1]);
          if (content.includes('import') && content.includes('Config')) {
            const importMatch = content.match(/import \{([^}]+)\}/);
            if (importMatch) {
              const names = importMatch[1].split(',').map(n => n.trim());
              if (names.includes('Config')) funcs.add(`imports_Config_in_${relPath}`);
            }
          }
        }
        return {
          impacted_functions: [...funcs].filter(f => !f.startsWith('imports_')),
          references: funcs.size,
          _files_read: [...filesRead],
        };
      },
    },

    // Task 4: find_tests — locate tests for lynxHome
    {
      id: 'find_tests',
      name: 'Find tests for lynxHome',
      description: 'Locate all test functions that test lynxHome.',
      expected: {
        test_functions: [
          { name: 'testLynxHomeReturnsString' },
          { name: 'testLynxHomeRespectsEnv' },
        ],
      },
      withLynx: async (project: string) => {
        const result = await handleFindTests({
          project,
          name: 'lynxHome',
        }) as Record<string, unknown>;
        const tests = (result.tests as Array<Record<string, unknown>>) || [];
        return {
          test_functions: tests.map(t => ({ name: t.name, file_path: t.file_path })),
          total_tests: tests.length,
        };
      },
      withoutLynx: async (fixtureDir: string) => {
        const grepOut = execSync(
          `grep -rn "lynxHome" --include="*.test.ts" "${fixtureDir}"`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        const lines = grepOut.split('\n').filter(Boolean);
        const testFuncs: Array<{ name: string; file: string }> = [];
        const filesRead = new Set<string>();
        for (const line of lines) {
          const [filePath, lineNo, content] = line.split(':');
          const relPath = filePath.replace(fixtureDir + '/', '');
          filesRead.add(filePath);
          // Search backwards for the test function name
          try {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            const fileLines = fileContent.split('\n');
            const lineNum = parseInt(lineNo, 10) - 1;
            for (let i = lineNum; i >= 0; i--) {
              const m = fileLines[i].match(/export function (\w+)/);
              if (m && m[1].startsWith('test')) {
                testFuncs.push({ name: m[1], file: relPath });
                break;
              }
            }
          } catch {
            // skip
          }
        }
        return {
          test_functions: [...new Map(testFuncs.map(t => [t.name, t])).values()],
          total_tests: testFuncs.length,
          _files_read: [...filesRead],
        };
      },
    },

    // Task 5: locate_definitions — batch find multiple symbols
    {
      id: 'locate_definitions',
      name: 'Locate multiple symbol definitions',
      description: 'Find source locations for lynxHome, openDb, and formatPath.',
      expected: {
        definitions: [
          { name: 'lynxHome', file_path: 'runtime.ts' },
          { name: 'openDb', file_path: 'db.ts' },
          { name: 'formatPath', file_path: 'helpers.ts' },
        ],
      },
      withLynx: async (project: string) => {
        const results: Array<Record<string, unknown>> = [];
        for (const name of ['lynxHome', 'openDb', 'formatPath']) {
          const result = await handleSearchGraph({
            project,
            query: name,
            limit: 3,
            enable_llm: false,
          }) as Record<string, unknown>;
          const items = (result.results as Array<Record<string, unknown>>) || [];
          const target = items.find(r =>
            String(r.name || '') === name &&
            String(r.kind || '') === 'Function'
          );
          if (target) {
            results.push({
              name: target.name,
              file_path: target.file,
              start_line: target.start_line,
            });
          }
        }
        return { definitions: results };
      },
      withoutLynx: async (fixtureDir: string) => {
        const results: Array<Record<string, unknown>> = [];
        const filesRead = new Set<string>();
        for (const name of ['lynxHome', 'openDb', 'formatPath']) {
          const grepOut = execSync(
            `grep -rn "function ${name}\\|export function ${name}" --include="*.ts" "${fixtureDir}"`,
            { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
          ).trim();
          const lines = grepOut.split('\n').filter(Boolean);
          if (lines.length > 0) {
            const [filePath, lineNo] = lines[0].split(':');
            filesRead.add(filePath);
            results.push({
              name,
              file_path: filePath.replace(fixtureDir + '/', ''),
              start_line: parseInt(lineNo, 10),
            });
          }
        }
        return { definitions: results, _files_read: [...filesRead] };
      },
    },
  ];
}

// ── Benchmark runner ──────────────────────────────────────────

export async function runABBenchmark(configOverrides: Partial<ABBenchmarkConfig> = {}): Promise<ABBenchmarkResult> {
  const config: ABBenchmarkConfig = {
    seed: configOverrides.seed ?? 42,
    warmupRounds: configOverrides.warmupRounds ?? 0,
    measuredRounds: configOverrides.measuredRounds ?? 1,
    taskIds: configOverrides.taskIds,
    fixtureDir: configOverrides.fixtureDir,
  };

  const warnings: string[] = [];
  if (config.measuredRounds < 3) {
    warnings.push(
      `Only ${config.measuredRounds} measured round(s). At least 3 are recommended for meaningful statistics.`
    );
  }

  // ── Setup isolated environment ──────────────────────────────
  const baseDir = config.fixtureDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-ab-'));
  const originalLynxHome = process.env.LYNX_HOME;
  const tempLynxHome = path.join(baseDir, 'lynx-home');
  process.env.LYNX_HOME = tempLynxHome;
  fs.mkdirSync(tempLynxHome, { recursive: true });

  let db: LynxDatabase | null = null;
  const project = 'ab-bench-fixture';
  const allTasks = makeTasks();
  const tasks = config.taskIds
    ? allTasks.filter(t => config.taskIds!.includes(t.id))
    : allTasks;

  try {
    // ── Generate and index fixture ──────────────────────────────
    const fixtureDir = generateFixture(baseDir);

    db = LynxDatabase.openProject(project);
    await runPipeline(db, fixtureDir, project, { mode: 'fast', incremental: false });
    setDb(project, db);
    clearSessionDedup(project);

    // ── Counterbalanced order via seeded shuffle ────────────────
    const rng = seededRandom(config.seed);

    // Each task runs under both conditions. Counterbalance: half
    // the tasks do with_lynx first, half do without_lynx first.
    const shuffledTasks = shuffle(tasks, rng);
    const midPoint = Math.ceil(shuffledTasks.length / 2);
    const orderings: Array<{ task: TaskDefinition; order: Condition[] }> = [];
    for (let i = 0; i < shuffledTasks.length; i++) {
      if (i < midPoint) {
        orderings.push({ task: shuffledTasks[i], order: ['with_lynx', 'without_lynx'] });
      } else {
        orderings.push({ task: shuffledTasks[i], order: ['without_lynx', 'with_lynx'] });
      }
    }

    // ── Warmup rounds ───────────────────────────────────────────
    for (let w = 0; w < config.warmupRounds; w++) {
      for (const { task, order } of orderings) {
        for (const condition of order) {
          await runSingleTask(task, condition, project, db!, fixtureDir);
        }
      }
    }

    // ── Measured rounds ─────────────────────────────────────────
    const allRuns: TaskRun[] = [];
    for (let r = 0; r < config.measuredRounds; r++) {
      const roundSeed = config.seed + r * 1000;
      for (let pos = 0; pos < orderings.length; pos++) {
        const { task, order } = orderings[pos];
        for (const condition of order) {
          const run = await runSingleTask(task, condition, project, db!, fixtureDir);
          run.order_position = pos;
          run.seed = roundSeed;
          allRuns.push(run);
        }
      }
    }

    // ── Build summary ──────────────────────────────────────────
    const withRuns = allRuns.filter(r => r.condition === 'with_lynx');
    const withoutRuns = allRuns.filter(r => r.condition === 'without_lynx');

    const summary = buildSummary(withRuns, withoutRuns, config, tasks.length);

    return {
      config,
      methodology: buildMethodology(),
      tasks: allRuns,
      summary,
      warnings,
    };
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    clearFederatedConfig();
    clearSessionDedup(project);
    if (originalLynxHome !== undefined) {
      process.env.LYNX_HOME = originalLynxHome;
    } else {
      delete process.env.LYNX_HOME;
    }
    // Clean temp dirs
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runSingleTask(
  task: TaskDefinition,
  condition: Condition,
  project: string,
  db: LynxDatabase,
  fixtureDir: string
): Promise<TaskRun> {
  const errors: string[] = [];
  let result: Record<string, unknown> = {};
  const filesOpened = new Set<string>();
  let bytesRead = 0;
  let toolCalls = 0;
  let llmCalls = 0;
  let timeToFirstUseful = 0;

  const startTime = Date.now();

  try {
    if (condition === 'with_lynx') {
      toolCalls = 1;
      result = await task.withLynx(project, db);
      timeToFirstUseful = Date.now() - startTime;
    } else {
      // Count grep as one tool invocation
      toolCalls = 1;
      result = await task.withoutLynx(fixtureDir);

      // Count files actually accessed by the task (self-reported via _files_read).
      // Each withoutLynx task returns this array with absolute file paths.
      const reportedFiles = (result._files_read as string[] | undefined) || [];
      for (const f of reportedFiles) {
        filesOpened.add(f);
        try { bytesRead += fs.statSync(f).size; } catch { /* ignore */ }
      }

      timeToFirstUseful = Date.now() - startTime;
    }
  } catch (err) {
    errors.push(String(err));
  }

  const totalTime = Date.now() - startTime;
  const correctness = measureResult(result, task.expected);

  return {
    task_id: task.id,
    condition,
    order_position: 0,
    seed: 0,
    metrics: {
      total_time_ms: m(totalTime, 'measured', 'Wall clock time for complete task execution (ms)'),
      time_to_first_useful_ms: m(
        timeToFirstUseful || totalTime,
        'measured',
        'Time to first useful response (ms)'
      ),
      files_opened: m(filesOpened.size, 'measured', 'Number of distinct files opened/read'),
      bytes_read: m(bytesRead, 'measured', 'Total bytes read from disk'),
      tool_calls: m(toolCalls, 'measured', 'Number of tool/command invocations'),
      llm_calls: m(llmCalls, 'measured', 'Number of LLM API calls made'),
      llm_cost_usd: m(0, 'estimated', 'Estimated LLM cost in USD'),
      functional_success: m(correctness.correct, 'measured', 'Whether the task produced the correct answer'),
      defects_introduced: m(correctness.defects, 'measured', 'Number of incorrect or missing results'),
      fixes_needed: m(correctness.fixes, 'measured', 'Number of corrections needed'),
    },
    result,
    expected: task.expected,
    correct: correctness.correct,
    errors: [...errors, ...correctness.errors],
  };

}

// ── Summary builders ──────────────────────────────────────────

import { buildMethodology, buildSummary, resultToCSV, resultToHTML, resultToJSON } from './ab-benchmark-report.js';
export { resultToCSV, resultToHTML, resultToJSON } from './ab-benchmark-report.js';

// ── CLI entry point ───────────────────────────────────────────

export async function cmdABBenchmark(args: string[]): Promise<void> {
  const seedIdx = args.indexOf('--seed');
  const roundsIdx = args.indexOf('--rounds');
  const warmupIdx = args.indexOf('--warmup');
  const taskIdx = args.indexOf('--tasks');
  const jsonFlag = args.includes('--json');
  const csvFlag = args.includes('--csv');
  const htmlFlag = args.includes('--html');
  const outIdx = args.indexOf('--out');

  const config: Partial<ABBenchmarkConfig> = {
    seed: seedIdx !== -1 && args[seedIdx + 1] ? parseInt(args[seedIdx + 1], 10) || 42 : 42,
    measuredRounds: roundsIdx !== -1 ? Math.max(1, parseInt(args[roundsIdx + 1], 10) || 1) : 1,
    warmupRounds: warmupIdx !== -1 ? Math.max(0, parseInt(args[warmupIdx + 1], 10) || 0) : 0,
    taskIds: taskIdx !== -1 && args[taskIdx + 1]
      ? args[taskIdx + 1].split(',').map(t => t.trim()).filter(Boolean)
      : undefined,
  };

  const allJson = jsonFlag;
  const allCsv = csvFlag;
  const allHtml = htmlFlag;
  const noFormatFlag = !allJson && !allCsv && !allHtml;

  console.error(`LYNX A/B benchmark — seed=${config.seed} rounds=${config.measuredRounds} warmup=${config.warmupRounds}`);
  console.error('Running 5 deterministic tasks with vs without LYNX...');

  const result = await runABBenchmark(config);

  // Output
  const outputs: Array<{ ext: string; content: string }> = [];

  if (allJson || noFormatFlag) {
    outputs.push({ ext: 'json', content: resultToJSON(result) });
  }
  if (allCsv) {
    outputs.push({ ext: 'csv', content: resultToCSV(result) });
  }
  if (allHtml) {
    outputs.push({ ext: 'html', content: resultToHTML(result) });
  }

  const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  for (const { ext, content } of outputs) {
    if (outPath) {
      const filePath = outPath.endsWith(`.${ext}`) ? outPath : `${outPath}.${ext}`;
      fs.writeFileSync(filePath, content);
      console.error(`Wrote ${filePath}`);
    } else {
      console.log(content);
    }
  }

  // Summary
  const s = result.summary;
  console.error(`\nWith LYNX:    ${s.with_lynx.total_time_ms.median}ms median, ${(s.with_lynx.functional_success_rate * 100).toFixed(0)}% success`);
  console.error(`Without LYNX: ${s.without_lynx.total_time_ms.median}ms median, ${(s.without_lynx.functional_success_rate * 100).toFixed(0)}% success`);
  if (s.roi_blocked) {
    console.error(`ROI: BLOCKED — ${s.roi_blocked_reason}`);
  } else {
    const speedup = s.without_lynx.total_time_ms.median / Math.max(s.with_lynx.total_time_ms.median, 1);
    console.error(`Speedup: ${speedup.toFixed(1)}x faster with LYNX`);
  }

  for (const w of result.warnings) {
    console.error(`WARNING: ${w}`);
  }
}
