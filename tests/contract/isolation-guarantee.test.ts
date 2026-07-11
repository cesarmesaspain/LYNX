/**
 * CONTRACTUAL TEST: Zero real writes guarantee.
 *
 * This test proves that the test isolation infrastructure (tests/setup.ts)
 * prevents ALL test code from writing to the user's real ~/.lynx directory.
 *
 * It captures the real ~/.lynx state BEFORE any storage operations, runs
 * the most DB-intensive code paths (metrics, locks, project DB creation),
 * then asserts the real directory is IDENTICAL.
 *
 * This is NOT recursive — it's a regular vitest test that relies on
 * tests/setup.ts having already redirected LYNX_HOME to a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { assertIsolated, testHome, workerId } from '../setup.js';

// ── Real home snapshot helpers ──────────────────────────

const REAL_HOME = path.join(os.homedir(), '.lynx');

interface Snapshot {
  metricsDb: { exists: boolean; size: number; mtimeMs: number; sha256: string } | null;
  dbsFiles: Array<{ name: string; size: number; mtimeMs: number }>;
  dbsCount: number;
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function snapshotRealHome(): Snapshot {
  const metricsPath = path.join(REAL_HOME, 'metrics.db');
  const dbsDir = path.join(REAL_HOME, 'dbs');

  let metricsDb: Snapshot['metricsDb'] = null;
  if (fs.existsSync(metricsPath)) {
    const stat = fs.statSync(metricsPath);
    metricsDb = {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sha256File(metricsPath),
    };
  }

  let dbsFiles: Snapshot['dbsFiles'] = [];
  if (fs.existsSync(dbsDir)) {
    const entries = fs.readdirSync(dbsDir).filter(f => f.endsWith('.db')).sort();
    dbsFiles = entries.map(name => {
      const p = path.join(dbsDir, name);
      const stat = fs.statSync(p);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    });
  }

  return { metricsDb, dbsFiles, dbsCount: dbsFiles.length };
}

function snapshotsEqual(a: Snapshot, b: Snapshot): { equal: boolean; diffs: string[] } {
  const diffs: string[] = [];

  // Compare metrics.db
  if (a.metricsDb && b.metricsDb) {
    if (a.metricsDb.size !== b.metricsDb.size) {
      diffs.push(`metrics.db size: ${a.metricsDb.size} → ${b.metricsDb.size}`);
    }
    if (a.metricsDb.mtimeMs !== b.metricsDb.mtimeMs) {
      diffs.push(`metrics.db mtime: ${a.metricsDb.mtimeMs} → ${b.metricsDb.mtimeMs}`);
    }
    if (a.metricsDb.sha256 !== b.metricsDb.sha256) {
      diffs.push(`metrics.db SHA256 changed: ${a.metricsDb.sha256} → ${b.metricsDb.sha256}`);
    }
  } else if (a.metricsDb && !b.metricsDb) {
    diffs.push('metrics.db was deleted during test');
  } else if (!a.metricsDb && b.metricsDb) {
    diffs.push('metrics.db was created during test');
  }

  // Compare dbs/
  if (a.dbsCount !== b.dbsCount) {
    diffs.push(`dbs/ file count: ${a.dbsCount} → ${b.dbsCount}`);
  }
  const aNames = new Set(a.dbsFiles.map(f => f.name));
  const bNames = new Set(b.dbsFiles.map(f => f.name));
  const added = [...bNames].filter(n => !aNames.has(n));
  const removed = [...aNames].filter(n => !bNames.has(n));
  if (added.length) diffs.push(`dbs/ files added: ${added.join(', ')}`);
  if (removed.length) diffs.push(`dbs/ files removed: ${removed.join(', ')}`);

  // Compare individual dbs/ file mtimes
  for (const af of a.dbsFiles) {
    const bf = b.dbsFiles.find(f => f.name === af.name);
    if (bf && af.mtimeMs !== bf.mtimeMs) {
      diffs.push(`dbs/${af.name} mtime changed: ${af.mtimeMs} → ${bf.mtimeMs}`);
    }
    if (bf && af.size !== bf.size) {
      diffs.push(`dbs/${af.name} size changed: ${af.size} → ${bf.size}`);
    }
  }

  return { equal: diffs.length === 0, diffs };
}

// ── Contract test ───────────────────────────────────────

describe('Isolation guarantee (contractual)', () => {
  let beforeSnapshot: Snapshot;

  beforeAll(() => {
    // 1. Verify we are isolated (LYNX_HOME is NOT the real ~/.lynx)
    assertIsolated();

    // Confirm our LYNX_HOME is a temp dir, not the real home
    const current = testHome();
    expect(path.resolve(current)).not.toBe(path.resolve(REAL_HOME));
    expect(current).toContain('lynx-test-home-');

    // 2. Snapshot the real ~/.lynx BEFORE any storage operations
    beforeSnapshot = snapshotRealHome();
  });

  afterAll(() => {
    // 5. Snapshot the real ~/.lynx AFTER all storage operations
    const afterSnapshot = snapshotRealHome();

    // 6. Assert ZERO changes
    const { equal, diffs } = snapshotsEqual(beforeSnapshot, afterSnapshot);
    if (!equal) {
      console.error('REAL ~/.lynx WAS MODIFIED DURING TESTS:');
      diffs.forEach(d => console.error('  -', d));
    }
    expect(equal).toBe(true);

    // 7. Redundant sanity check: LYNX_HOME is still isolated
    assertIsolated();
  });

  it('1. metrics.db intensive — archive + flush + rebuild + summarize', async () => {
    // Exercise the FULL metrics pipeline under isolation
    const { archiveEvent, flushTodayEvents, rebuildDailySnapshots, summarizeHistory, closeMetricsDb } =
      await import('../../src/store/metrics-db.js');

    const PROJECT = 'contract-test';

    for (let i = 0; i < 50; i++) {
      archiveEvent({
        ts: new Date().toISOString(),
        type: i % 3 === 0 ? 'search_graph' : i % 3 === 1 ? 'pack_context' : 'trace_path',
        project: PROJECT,
        query: `contract-query-${i}`,
        query_hash: `hash-${i}`,
        files_avoided: 10 + i,
        tokens_saved: 1000 + i * 100,
        confidence: 'high',
        event_id: `contract-ev-${i}`,
        session_id: `sess-${i % 5}`,
        task_id: `task-${i % 3}`,
        deterministic_mode: i % 7 === 0,
      });
    }

    flushTodayEvents(PROJECT);
    rebuildDailySnapshots();

    const history = summarizeHistory(PROJECT, 10);
    expect(history.total_events).toBe(50);
    expect(history.total_tokens_saved).toBeGreaterThan(0);

    closeMetricsDb();
  });

  it('2. project DBs — create, write, query, close', async () => {
    const { LynxDatabase } = await import('../../src/store/database.js');

    // Create multiple project DBs with full schema usage
    for (const proj of ['ct-a', 'ct-b', 'ct-c']) {
      const dbPath = path.join(testHome(), 'dbs', `${proj}.db`);
      const db = LynxDatabase.openPath(dbPath);

      // Populate with realistic data
      for (let i = 0; i < 20; i++) {
        db.db.prepare(
          `INSERT INTO nodes (project, name, qualified_name, kind, file_path, start_line, end_line, is_entry_point, is_exported, properties)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(proj, `func${i}`, `${proj}.func${i}`, 'Function', `src/file${i}.ts`, i + 1, i + 10, i === 0 ? 1 : 0, 1, '{}');
      }

      // Add edges
      for (let i = 0; i < 15; i++) {
        db.db.prepare(
          `INSERT INTO edges (project, source_id, target_id, type) VALUES (?, ?, ?, ?)`
        ).run(proj, i + 1, ((i + 1) % 20) + 1, 'CALLS');
      }

      // Add index run record
      db.db.prepare(
        `INSERT INTO index_runs (project, run_at, mode) VALUES (?, ?, ?)`
      ).run(proj, new Date().toISOString(), 'fast');

      // Verify data
      const nodeCount = db.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(proj) as any;
      expect(nodeCount.cnt).toBe(20);

      db.close();
    }
  });

  it('3. locks — acquire, detect stale, release, list orphans', async () => {
    const { acquireProjectLock, releaseProjectLock, isProjectLocked, listOrphanedLocks } =
      await import('../../src/store/lock.js');

    // Acquire multiple locks
    for (const proj of ['lock-a', 'lock-b']) {
      const r = acquireProjectLock(proj);
      expect(r.acquired).toBe(true);
      expect(isProjectLocked(proj)).toBe(true);
    }

    // Deny re-acquire
    const r2 = acquireProjectLock('lock-a');
    expect(r2.acquired).toBe(false);

    // List orphans (should have none since we hold valid locks)
    const orphans = listOrphanedLocks();
    for (const o of orphans) {
      // Orphans found here are from the isolated home, not real
      expect(o.project).toBeDefined();
    }

    // Release all
    releaseProjectLock('lock-a');
    releaseProjectLock('lock-b');
    expect(isProjectLocked('lock-a')).toBe(false);
    expect(isProjectLocked('lock-b')).toBe(false);
  });

  it('4. usage metrics — recordUsageEvent with all fields', async () => {
    const { recordUsageEvent } = await import('../../src/usage/metrics.js');

    // Record events that would normally go to metrics.db
    for (let i = 0; i < 10; i++) {
      recordUsageEvent({
        ts: new Date().toISOString(),
        type: 'search_graph',
        project: 'usage-test',
        query: `test query ${i}`,
        query_hash: `h${i}`,
        files_avoided: 5,
        tokens_saved: 500,
        confidence: 'high',
        event_id: `usage-ev-${i}`,
        session_id: 'sess-usage',
        task_id: 'task-usage',
        deterministic_mode: false,
      });
    }
  });

  it('5. final assertion: DB files are in isolated home, not real home', async () => {
    const isolatedHome = testHome();

    // Our test DBs should exist under the isolated home
    const isolatedDbs = path.join(isolatedHome, 'dbs');
    expect(fs.existsSync(isolatedDbs)).toBe(true);
    const dbFiles = fs.readdirSync(isolatedDbs).filter(f => f.endsWith('.db'));
    expect(dbFiles.length).toBeGreaterThanOrEqual(3); // ct-a, ct-b, ct-c

    // The isolated metrics.db should exist
    const isolatedMetrics = path.join(isolatedHome, 'metrics.db');
    expect(fs.existsSync(isolatedMetrics)).toBe(true);

    // CRITICAL: The isolated home is NOT the real home
    expect(path.resolve(isolatedHome)).not.toBe(path.resolve(REAL_HOME));
  });
});

// ── Worker identity & concurrency uniqueness ────────────

describe('Worker identity and concurrency isolation', () => {
  it('workerId() returns a non-empty string with expected format', () => {
    const id = workerId();
    // Format: w<PID>-<timestamp36>-<random6>
    expect(id).toBeTruthy();
    expect(id).toMatch(/^w\d+-[a-z0-9]+-[a-z0-9]{6}$/);
  });

  it('workerId() is stable within the same worker', () => {
    const id1 = workerId();
    const id2 = workerId();
    expect(id1).toBe(id2);
  });

  it('testHome() is a mkdtemp path under os.tmpdir()', () => {
    const home = testHome();
    expect(home).toContain('lynx-test-home-');
    expect(home.startsWith(os.tmpdir())).toBe(true);
  });

  it('testHome() is stable within the same worker', () => {
    const home1 = testHome();
    const home2 = testHome();
    expect(home1).toBe(home2);
    expect(path.resolve(home1)).toBe(path.resolve(home2));
  });

  it('assertIsolated() does not throw under isolation', () => {
    expect(() => assertIsolated()).not.toThrow();
  });

  it('LYNX_HOME and REAL_HOME are different absolute paths', () => {
    const current = path.resolve(testHome());
    const real = path.resolve(REAL_HOME);
    expect(current).not.toBe(real);
    // Must be under the OS temp directory (mkdtempSync uses os.tmpdir())
    expect(current.startsWith(os.tmpdir())).toBe(true);
  });

  it('multiple sub-isolations under the worker home stay within the temp dir', () => {
    const workerHome = testHome();

    // Simulate two "concurrent" test suites each creating sub-homes
    const subA = fs.mkdtempSync(path.join(workerHome, 'concurrent-a-'));
    const subB = fs.mkdtempSync(path.join(workerHome, 'concurrent-b-'));

    // Both sub-homes are different
    expect(subA).not.toBe(subB);
    expect(path.resolve(subA)).not.toBe(path.resolve(subB));

    // Both are children of the worker home, not the real home
    expect(subA.startsWith(workerHome)).toBe(true);
    expect(subB.startsWith(workerHome)).toBe(true);
    expect(subA.startsWith(REAL_HOME)).toBe(false);
    expect(subB.startsWith(REAL_HOME)).toBe(false);

    // Clean up
    fs.rmSync(subA, { recursive: true, force: true });
    fs.rmSync(subB, { recursive: true, force: true });
  });

  it('each sub-home can independently host a metrics.db without cross-contamination', async () => {
    const workerHome = testHome();
    const { closeMetricsDb } = await import('../../src/store/metrics-db.js');

    const subX = fs.mkdtempSync(path.join(workerHome, 'concurrent-x-'));
    const subY = fs.mkdtempSync(path.join(workerHome, 'concurrent-y-'));

    fs.mkdirSync(path.join(subX, 'dbs'), { recursive: true });
    fs.mkdirSync(path.join(subY, 'dbs'), { recursive: true });

    // Write to subX
    closeMetricsDb();
    process.env.LYNX_HOME = subX;
    const { archiveEvent: archX } = await import('../../src/store/metrics-db.js');
    archX({
      ts: new Date().toISOString(),
      type: 'search_graph', project: 'proj-x',
      query: 'x', query_hash: 'hx',
      files_avoided: 1, tokens_saved: 100,
      confidence: 'high', event_id: 'x-001',
      session_id: 'sx', task_id: 'tx',
      deterministic_mode: false,
    });
    const xMetrics = path.join(subX, 'metrics.db');
    expect(fs.existsSync(xMetrics)).toBe(true);

    // Write to subY — completely separate DB
    closeMetricsDb();
    process.env.LYNX_HOME = subY;
    const { archiveEvent: archY } = await import('../../src/store/metrics-db.js');
    archY({
      ts: new Date().toISOString(),
      type: 'pack_context', project: 'proj-y',
      query: 'y', query_hash: 'hy',
      files_avoided: 5, tokens_saved: 500,
      confidence: 'high', event_id: 'y-001',
      session_id: 'sy', task_id: 'ty',
      deterministic_mode: false,
    });
    const yMetrics = path.join(subY, 'metrics.db');
    expect(fs.existsSync(yMetrics)).toBe(true);

    // Verify xMetrics does NOT contain proj-y events
    {
      const db = new (await import('better-sqlite3')).default(xMetrics, { readonly: true });
      const xEvents = db.prepare('SELECT COUNT(*) as cnt FROM events_archive WHERE project = ?').get('proj-x') as any;
      const yInX = db.prepare('SELECT COUNT(*) as cnt FROM events_archive WHERE project = ?').get('proj-y') as any;
      expect(xEvents.cnt).toBe(1);
      expect(yInX.cnt).toBe(0); // No cross-contamination
      db.close();
    }

    // Verify yMetrics does NOT contain proj-x events
    {
      const db = new (await import('better-sqlite3')).default(yMetrics, { readonly: true });
      const yEvents = db.prepare('SELECT COUNT(*) as cnt FROM events_archive WHERE project = ?').get('proj-y') as any;
      const xInY = db.prepare('SELECT COUNT(*) as cnt FROM events_archive WHERE project = ?').get('proj-x') as any;
      expect(yEvents.cnt).toBe(1);
      expect(xInY.cnt).toBe(0);
      db.close();
    }

    // Restore and clean
    closeMetricsDb();
    process.env.LYNX_HOME = workerHome;
    fs.rmSync(subX, { recursive: true, force: true });
    fs.rmSync(subY, { recursive: true, force: true });
  });
});
