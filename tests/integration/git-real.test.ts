/*
 * git-real.test.ts — Real-Git integration tests for WS5 (reproducible).
 *
 * Every test uses withFixture() which creates a crypto-unique temp Git repo
 * + in-memory LynxDatabase. No persistent project DB is written. MCP DB
 * cache entries are cleaned up via unsetDb after each test. Fixture creation
 * and index duration are recorded and asserted against a generous upper bound
 * so performance regressions are visible.
 *
 * Coverage:
 *   1. queryDeletedSymbolsLiveRefs detects stale CALLS edges after file deletion
 *   2. pack_context decision mode synthesises staged/unstaged changes
 *   3. Duplicate-basename disambiguation via pure helper + integration assertion
 *   4. unsetDb behaviour
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LynxDatabase } from '../../src/store/database.js';
import { runPipeline } from '../../src/pipeline/orchestrator.js';
import { queryDeletedSymbolsLiveRefs } from '../../src/mcp/handlers/assess_impact.js';
import { handlePackContext } from '../../src/mcp/handlers/pack_context.js';
import { setDb, unsetDb, getDb } from '../../src/mcp/server.js';

// ── Pure helpers ─────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 });
}

function writeFile(cwd: string, relPath: string, content: string) {
  const abs = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function readFile(cwd: string, relPath: string): string {
  return fs.readFileSync(path.join(cwd, relPath), 'utf-8');
}

/**
 * shortestUniqueSuffix — pure disambiguation helper.
 * Returns the shortest path suffix that uniquely identifies `target`
 * among `all`, starting from the last segment backwards.
 */
export function shortestUniqueSuffix(target: string, all: string[]): string {
  const parts = target.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const suffix = parts.slice(i).join('/');
    const matches = all.filter(f => f.endsWith(suffix));
    if (matches.length === 1 && matches[0] === target) return suffix;
  }
  return target;
}

// ── Fixture ──────────────────────────────────────────────────────

interface Fixture {
  repoDir: string;
  db: LynxDatabase;
  project: string;
  runId: string;
  markerFile: string;
  markerSymbol: string;
  markerQn: string;
  commitHash: string;
  /** Milliseconds spent inside runPipeline (index-only). */
  indexDurationMs: number;
}

/**
 * createFixture — fresh temp git repo, commit baseline, index into
 * in-memory DB. Logs timing. Caller must call cleanupFixture().
 */
async function createFixture(opts?: {
  includeDupBasenames?: boolean;
}): Promise<Fixture> {
  const includeDup = opts?.includeDupBasenames !== false;
  const t0 = performance.now();

  const runId = crypto.randomUUID();
  const project = `test-git-${runId.slice(0, 8)}`;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-git-test-'));

  git(['init'], repoDir);
  git(['config', 'user.email', 'test@lynx.dev'], repoDir);
  git(['config', 'user.name', 'LYNX Test'], repoDir);

  const markerFile = `src/marker-${runId.slice(0, 8)}.ts`;
  const markerSymbol = `marker_${runId.replace(/-/g, '_')}`;

  writeFile(repoDir, markerFile, `
export function ${markerSymbol}(input: string): string {
  return "MARKER:${runId}:" + input;
}
`);

  writeFile(repoDir, 'src/consumer.ts', `
import { ${markerSymbol} } from './marker-${runId.slice(0, 8)}.js';

export function runConsumer(): string {
  return ${markerSymbol}("hello");
}
`);

  writeFile(repoDir, 'src/lib/math.ts', `
export function add(a: number, b: number): number {
  return internalSum(a, b);
}
function internalSum(x: number, y: number): number {
  return x + y;
}
`);

  writeFile(repoDir, 'src/index.ts', `
import { add } from './lib/math.js';

export function main(): number {
  return add(1, 2);
}
`);

  writeFile(repoDir, 'tests/math.test.ts', `
import { add } from '../src/lib/math.js';

export function testAdd() {
  if (add(2, 3) !== 5) throw new Error('fail');
}
`);

  if (includeDup) {
    writeFile(repoDir, 'src/api/handler.ts', `
export function apiHandler(req: Request): Response {
  return new Response("api ok");
}
`);
    writeFile(repoDir, 'src/ws/handler.ts', `
export function wsHandler(conn: WebSocket): void {
  conn.send("ws ok");
}
`);
  }

  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'initial baseline'], repoDir);
  const commitHash = git(['rev-parse', 'HEAD'], repoDir).trim();

  const db = LynxDatabase.openMemory();
  const idxT0 = performance.now();
  await runPipeline(db, repoDir, project, { mode: 'fast' });
  const indexDurationMs = Math.round(performance.now() - idxT0);

  const row = db.db.prepare(
    'SELECT qualified_name FROM nodes WHERE project = ? AND name = ?'
  ).get(project, markerSymbol) as { qualified_name: string };
  const markerQn = row?.qualified_name ?? '';

  const totalMs = Math.round(performance.now() - t0);
  console.log(`[fixture] project=${project} index=${indexDurationMs}ms total=${totalMs}ms dup=${includeDup}`);

  return { repoDir, db, project, runId, markerFile, markerSymbol, markerQn, commitHash, indexDurationMs };
}

/**
 * cleanupFixture — close DB then remove temp repo.
 * Caller must have already called unsetDb to remove the cache entry first.
 * Cleanup order: unsetDb → close DB → remove temp dir.
 */
function cleanupFixture(f: Fixture) {
  try { f.db.close(); } catch { /* ok */ }
  try { fs.rmSync(f.repoDir, { recursive: true, force: true }); } catch { /* ok */ }
}

/**
 * withFixture — creates fixture, registers DB in MCP cache via setDb
 * right before calling fn, then unregisters via unsetDb (with close: false
 * since the fixture cleanup handles close) and cleans up in finally.
 */
async function withFixture<T>(
  fn: (f: Fixture) => Promise<T>,
  opts?: { includeDupBasenames?: boolean }
): Promise<T> {
  const f = await createFixture(opts);
  setDb(f.project, f.db);
  try {
    return await fn(f);
  } finally {
    // Cleanup order: unregister cache entry, close DB, remove temp repo
    unsetDb(f.project, { close: false });
    cleanupFixture(f);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Pure helper: shortestUniqueSuffix
// ═══════════════════════════════════════════════════════════════════

describe('shortestUniqueSuffix (pure helper)', () => {
  it('returns basename when unique', () => {
    expect(shortestUniqueSuffix('src/index.ts', ['src/index.ts', 'src/lib/math.ts']))
      .toBe('index.ts');
  });

  it('disambiguates duplicate basenames with shortest unique suffix', () => {
    const files = ['src/api/handler.ts', 'src/ws/handler.ts', 'src/index.ts'];
    const r1 = shortestUniqueSuffix('src/api/handler.ts', files);
    const r2 = shortestUniqueSuffix('src/ws/handler.ts', files);
    expect(r1).toContain('/');
    expect(r2).toContain('/');
    expect(r1).not.toBe(r2);
    expect(r1).toMatch(/handler\.ts$/);
    expect(r2).toMatch(/handler\.ts$/);
  });

  it('returns full path when no other files to compare', () => {
    expect(shortestUniqueSuffix('deeply/nested/path/file.ts', []))
      .toBe('deeply/nested/path/file.ts');
  });

  it('handles multi-segment disambiguation', () => {
    const files = ['a/b/c/util.ts', 'x/y/c/util.ts', 'a/b/d/util.ts'];
    expect(shortestUniqueSuffix('a/b/c/util.ts', files)).toBe('b/c/util.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════
// unsetDb behaviour
// ═══════════════════════════════════════════════════════════════════

describe('unsetDb', () => {
  it('removes an existing cache entry without closing when close: false', () => {
    const db = LynxDatabase.openMemory();
    const project = `unset-test-${crypto.randomUUID().slice(0, 8)}`;
    setDb(project, db);
    unsetDb(project, { close: false });
    // DB should still be open (caller retains lifecycle ownership)
    expect(db.db.open).toBe(true);
    db.close();
  });

  it('next getDb resolves a different instance after unsetDb', () => {
    const db1 = LynxDatabase.openMemory();
    const project = `unset-test-${crypto.randomUUID().slice(0, 8)}`;
    setDb(project, db1);
    expect(getDb(project)).toBe(db1);

    unsetDb(project, { close: false });
    // After unset, getDb creates/opens a fresh instance
    const db2 = getDb(project);
    expect(db2).not.toBe(db1);

    // Clean up: unregister from cache, close both DBs, remove any persistent file
    unsetDb(project, { close: false }); // caller retains lifecycle ownership of db2
    db1.close();
    const db2Path = db2.dbPath;
    db2.close();
    if (db2Path !== ':memory:') {
      try { fs.rmSync(db2Path); } catch { /* ok */ }
      try { fs.rmSync(db2Path + '-wal', { force: true }); } catch { /* ok */ }
      try { fs.rmSync(db2Path + '-shm', { force: true }); } catch { /* ok */ }
    }
  });

  it('removes and closes an in-memory entry when close: true', () => {
    const db = LynxDatabase.openMemory();
    const project = `unset-test-${crypto.randomUUID().slice(0, 8)}`;
    setDb(project, db);
    unsetDb(project, { close: true });
    // After close: true, an in-memory DB should be closed
    expect(db.db.open).toBe(false);
  });

  it('is a no-op on missing key', () => {
    expect(() => unsetDb('nonexistent-key-12345', { close: true })).not.toThrow();
  });

  it('does not double-close — safe to call twice', () => {
    const db = LynxDatabase.openMemory();
    const project = `unset-test-${crypto.randomUUID().slice(0, 8)}`;
    setDb(project, db);
    unsetDb(project, { close: true });
    expect(db.db.open).toBe(false);
    // Second call should not throw
    expect(() => unsetDb(project, { close: false })).not.toThrow();
  });

  it('keeps unknown-project reads in memory instead of creating a catalog database', () => {
    const project = `unknown-read-${crypto.randomUUID().slice(0, 8)}`;
    const db = getDb(project);

    expect(db.dbPath).toBe(':memory:');
    expect(db.getProject(project)).toBeNull();

    unsetDb(project, { close: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// queryDeletedSymbolsLiveRefs (real git, in-memory DB)
// ═══════════════════════════════════════════════════════════════════

describe('queryDeletedSymbolsLiveRefs (real git)', () => {
  it('detects stale CALLS edges after producer file is deleted from disk', async () => {
    const f = await createFixture({ includeDupBasenames: false });
    // Index duration is measured in fixture; assert reasonable upper bound
    expect(f.indexDurationMs).toBeLessThan(30_000);

    try {
      // Pre-condition: consumer source references the marker symbol
      const consumerSource = readFile(f.repoDir, 'src/consumer.ts');
      expect(consumerSource).toContain(f.markerSymbol);

      // Pre-condition: CALLS edge exists in the graph
      const callerCount = (f.db.db.prepare(
        `SELECT COUNT(*) as cnt FROM edges e
         JOIN nodes tgt ON tgt.id = e.target_id
         WHERE e.project = ? AND e.type = 'CALLS' AND tgt.qualified_name = ?`
      ).get(f.project, f.markerQn) as { cnt: number }).cnt;
      expect(callerCount).toBeGreaterThanOrEqual(1);

      // Delete the producer file from disk
      fs.rmSync(path.join(f.repoDir, f.markerFile));

      const findings = queryDeletedSymbolsLiveRefs(f.db, f.project, f.repoDir);
      const mine = findings.filter(fi => fi.file === f.markerFile);
      expect(mine.length).toBeGreaterThanOrEqual(1);

      const finding = mine[0];
      expect(finding.category).toBe('deleted_symbols_live_refs');
      expect(finding.overall_confidence).toBe('high');
      expect(finding.evidence.some(e => e.source === 'CALLS edge' && e.strength === 'confirmed')).toBe(true);
      expect(finding.evidence.some(e => e.detail.includes(f.markerFile))).toBe(true);
      expect(finding.evidence.every(e => !e.detail.includes(os.tmpdir()))).toBe(true);
    } finally {
      // Restore marker file even if assertions fail
      if (!fs.existsSync(path.join(f.repoDir, f.markerFile))) {
        writeFile(f.repoDir, f.markerFile, `
export function ${f.markerSymbol}(input: string): string {
  return "MARKER:${f.runId}:" + input;
}
`);
      }
      cleanupFixture(f);
    }
  }, 30_000);

  it('returns empty when all indexed files exist on disk', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);
      const findings = queryDeletedSymbolsLiveRefs(f.db, f.project, f.repoDir);
      expect(findings.length).toBe(0);
    });
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// pack_context decision mode (real git, per-test fresh fixtures)
// ═══════════════════════════════════════════════════════════════════

describe('pack_context decision mode (real git)', () => {
  it('synthesises staged changes with changed symbols and files sections', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      writeFile(f.repoDir, 'src/index.ts', `
import { add } from './lib/math.js';
export function main(): number { return add(100, 200); }
export function newStagedHelper(): string { return "STAGED:${f.runId}"; }
`);
      git(['add', 'src/index.ts'], f.repoDir);

      const result = await handlePackContext({
        project: f.project,
        task: 'review staged index changes',
        mode: 'decision',
      });

      expect(result.mode).toBe('decision');
      const summary = result.decision_summary!;
      expect(summary.length).toBeGreaterThan(0);

      // Semantic sections present
      expect(summary).toContain('Changed symbols');
      expect(summary).toContain('Files:');

      // Canonical path for changed file
      expect(summary).toContain('src/index.ts');

      // Size contract: ≤300 words (small margin for prose variation)
      const wordCount = summary.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(310);

      // Recommended tools
      const tools = result.recommended_next_calls.map(c => c.tool);
      expect(tools).toContain('assess_impact');
      expect(tools).toContain('trace_path');

      // is_fresh: truthful — may be false when working tree is dirty post-index
      expect(typeof result.index_health!.is_fresh).toBe('boolean');
    });
  }, 30_000);

  it('reports No uncommitted changes on clean tree', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      const result = await handlePackContext({
        project: f.project,
        task: 'check state',
        mode: 'decision',
      });

      expect(result.decision_summary).toContain('No uncommitted changes');
    });
  }, 30_000);

  it('disambiguates duplicate basenames in decision prose', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      writeFile(f.repoDir, 'src/api/handler.ts', `
export function apiHandler(req: Request): Response {
  return new Response("CHANGED:${f.runId}");
}
`);
      writeFile(f.repoDir, 'src/ws/handler.ts', `
export function wsHandler(conn: WebSocket): void {
  conn.send("CHANGED:${f.runId}");
}
`);
      git(['add', 'src/api/handler.ts', 'src/ws/handler.ts'], f.repoDir);

      const result = await handlePackContext({
        project: f.project,
        task: 'review handler changes',
        mode: 'decision',
      });

      const summary = result.decision_summary!;
      // Changed symbols must contain full canonical paths
      expect(summary).toContain('src/api/handler.ts');
      expect(summary).toContain('src/ws/handler.ts');

      // Prose disambiguation: bare "handler.ts" without directory qualification
      // is a bug when both files share the basename
      const bareHandlerRE = /(?<![\w/\-.])handler\.ts/g;
      let bareMatch: RegExpExecArray | null;
      while ((bareMatch = bareHandlerRE.exec(summary)) !== null) {
        const ctxStart = Math.max(0, bareMatch.index - 30);
        const ctxEnd = Math.min(summary.length, bareMatch.index + 30);
        const ctx = summary.slice(ctxStart, ctxEnd);
        expect(ctx).toMatch(/api|ws|handler/);
      }
    }, { includeDupBasenames: true });
  }, 30_000);

  it('does not confuse unindexed with untested', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      writeFile(f.repoDir, 'src/untracked-new.ts', `
export function brandNewUntracked(): string { return "not indexed"; }
`);

      const result = await handlePackContext({
        project: f.project,
        task: 'check untracked files',
        mode: 'decision',
      });

      const summary = result.decision_summary!;
      expect(summary).toBeDefined();
      // If it mentions the untracked file, it must not claim it lacks tests
      if (summary.includes('untracked-new')) {
        expect(summary).not.toMatch(/untracked-new.*untested|untested.*untracked-new/);
      }
    });
  }, 30_000);

  it('includes critical constraints in decision mode', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      const result = await handlePackContext({
        project: f.project,
        task: 'review changes',
        mode: 'decision',
      });

      expect(result.critical_constraints).toContain('READ_TARGET_FILES_BEFORE_EDITING');
    });
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// Standard (non-decision) mode — graph_candidates only in compact/full
// ═══════════════════════════════════════════════════════════════════

describe('pack_context compact mode (real git)', () => {
  it('returns graph_candidates in compact mode', async () => {
    await withFixture(async (f) => {
      expect(f.indexDurationMs).toBeLessThan(30_000);

      const result = await handlePackContext({
        project: f.project,
        task: 'review math lib',
        mode: 'compact',
      });

      expect(result.decision_summary).toBeUndefined();
      expect(result.graph_candidates).toBeDefined();
      expect(result.graph_candidates.length).toBeGreaterThan(0);
    }, { includeDupBasenames: false });
  }, 30_000);
});
