/*
 * tests/setup.ts — Vitest setupFiles entry (runs in each worker thread before test files).
 *
 * Creates an isolated LYNX_HOME per forked worker so zero test data touches
 * the user's real ~/.lynx directory.
 *
 * Cleanup uses Vitest's afterAll hook (runs when all test suites in this
 * worker finish) plus process.once('exit') as a safety net. All known
 * SQLite singletons are closed before the temp dir is removed.
 *
 * Individual tests that need per-test sub-isolation MUST:
 *   1. Capture the current LYNX_HOME INSIDE the hook (not at module level)
 *   2. Create subdirs under the worker temp or os.tmpdir()
 *   3. closeMetricsDb() before changing LYNX_HOME
 *   4. Restore to the captured worker value after the test
 *   5. Use dynamic import() for modules that open metrics/DB after env change
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterAll } from 'vitest';

// ── Worker identity (unique per forked worker process) ─────────

const WORKER_ID = `w${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── Create temp home once per worker ────────────────────

const g = globalThis as any;
const ALREADY_SETUP = '__lynx_test_home_setup_done__';

if (!g[ALREADY_SETUP]) {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-test-home-'));

  // Ensure dbs/ and config exist so module imports don't crash
  fs.mkdirSync(path.join(TEST_HOME, 'dbs'), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_HOME, 'config.json'),
    JSON.stringify({
      auto_index: false,
      auto_index_limit: 0,
      auto_watch: false,
      auto_dashboard: false,
      stale_threshold_hours: 24,
      lock_ttl_minutes: 5,
      locale: 'en',
    }),
    'utf-8'
  );

  process.env.LYNX_HOME = TEST_HOME;
  // Tests intentionally exercise Pro-only paths; production never receives this bypass.
  process.env.LYNX_DEV_LICENSE_BYPASS = '1';

  g[ALREADY_SETUP] = true;
  g.__LYNX_TEST_HOME__ = TEST_HOME;
  g.__LYNX_WORKER_ID__ = WORKER_ID;

  // ── Primary cleanup: Vitest afterAll (runs when all suites in this worker finish) ──
  afterAll(async () => {
    // Close all known SQLite singletons before removing the temp dir.
    // Use dynamic imports to avoid pulling modules into the setup context
    // before LYNX_HOME is established.
    try {
      const { closeMetricsDb } = await import('../src/store/metrics-db.js');
      closeMetricsDb();
    } catch { /* ok */ }

    try {
      const { closeProjectDbs } = await import('../src/mcp/server.js');
      closeProjectDbs();
    } catch { /* ok */ }

    // Remove the temp home
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ok */ }

    // Log a visible warning if cleanup failed (directory still exists)
    if (fs.existsSync(TEST_HOME)) {
      const prefix = '\n[LYNX TEST ISOLATION]';
      console.error(`${prefix} WARNING: failed to remove ${TEST_HOME}`);
    }
  });

  // ── Safety net: process.once for signals (no listener accumulation) ──
  const emergencyCleanup = () => {
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ok */ }
  };
  process.once('exit', emergencyCleanup);
  process.once('SIGINT', () => { emergencyCleanup(); process.exit(1); });
  process.once('SIGTERM', () => { emergencyCleanup(); process.exit(1); });
}

// ── Exports for tests that need to assert isolation ─────

/** The isolated LYNX_HOME path for the current worker. */
export function testHome(): string {
  return process.env.LYNX_HOME || '';
}

/**
 * A unique, stable identifier for this vitest worker.
 * Useful for asserting home-directory uniqueness under concurrency.
 */
export function workerId(): string {
  return (g.__LYNX_WORKER_ID__ as string) || WORKER_ID;
}

/** Assert that the current LYNX_HOME is NOT the user's real home. */
export function assertIsolated(): void {
  const realHome = path.join(os.homedir(), '.lynx');
  const current = testHome();
  if (path.resolve(current) === path.resolve(realHome)) {
    throw new Error(
      `LYNX_HOME isolation violated: ${current} === ${realHome}. ` +
      `Tests must not write to the real ~/.lynx directory.`
    );
  }
}
