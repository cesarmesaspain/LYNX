import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireProjectLock,
  forceAcquireProjectLock,
  releaseDeadProjectLockOwnedBy,
  releaseProjectLock,
  isProjectLocked,
  listOrphanedLocks,
} from '../../../src/store/lock.js';
import { assertIsolated, testHome } from '../../setup.js';

describe('project locks', () => {
  let originalHome: string | undefined;
  let lynxHome: string;

  beforeEach(() => {
    // Verify we start from the worker's isolated home (set by tests/setup.ts)
    assertIsolated();

    // Capture worker home INSIDE the hook (never at module level)
    originalHome = testHome();

    // Create a per-test subdir — NOT under the real ~/.lynx
    lynxHome = fs.mkdtempSync(path.join(originalHome, 'lock-sub-'));
    process.env.LYNX_HOME = lynxHome;

    // Write minimal config for lock TTL
    fs.writeFileSync(
      path.join(lynxHome, 'config.json'),
      JSON.stringify({ stale_threshold_hours: 24, lock_ttl_minutes: 5 })
    );
  });

  afterEach(() => {
    // Restore to the worker's temp home (never the real ~/.lynx)
    process.env.LYNX_HOME = originalHome!;
    fs.rmSync(lynxHome, { recursive: true, force: true });
  });

  it('acquire then release', () => {
    const r = acquireProjectLock('test-acquire');
    expect(r.acquired).toBe(true);
    expect(isProjectLocked('test-acquire')).toBe(true);

    releaseProjectLock('test-acquire');
    expect(isProjectLocked('test-acquire')).toBe(false);
  });

  it('denies re-acquire while held by same PID', () => {
    acquireProjectLock('test-deny');
    const r2 = acquireProjectLock('test-deny');
    expect(r2.acquired).toBe(false);
    expect(r2.reason).toContain('already being indexed');
    releaseProjectLock('test-deny');
  });

  it('idempotent release', () => {
    acquireProjectLock('test-idem');
    releaseProjectLock('test-idem');
    releaseProjectLock('test-idem'); // no-op
    expect(isProjectLocked('test-idem')).toBe(false);
  });

  it('does not overwrite a lock created between inspection and acquisition', () => {
    const project = 'atomic-create';
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `${project}.lock`),
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), project })
    );

    const result = acquireProjectLock(project);

    expect(result.acquired).toBe(false);
    expect(result.reason).toContain('already being indexed');
    releaseProjectLock(project);
  });

  it('stale lock recovery: non-existent PID', () => {
    // Write a lock file with a PID that doesn't exist (large number unlikely to be live)
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'stale.lock'),
      JSON.stringify({ pid: 99999, timestamp: Date.now() - 10 * 60 * 1000, project: 'stale' })
    );

    // Should break the stale lock and acquire
    const r = acquireProjectLock('stale');
    expect(r.acquired).toBe(true);
    releaseProjectLock('stale');
  });

  it('listOrphanedLocks detects dead-PID locks', () => {
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'ghost.lock'),
      JSON.stringify({ pid: 99998, timestamp: Date.now() - 60000, project: 'ghost' })
    );

    const orphaned = listOrphanedLocks();
    expect(orphaned.length).toBeGreaterThanOrEqual(1);
    const match = orphaned.find(l => l.project === 'ghost');
    expect(match).toBeDefined();
    expect(match!.processAlive).toBe(false);
  });

  it('recent dead PID within TTL is denied', () => {
    // Write a lock file with non-existent PID that died very recently
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'recent-dead.lock'),
      JSON.stringify({ pid: 99997, timestamp: Date.now() - 1000, project: 'recent-dead' })
    );

    // Within TTL (5 min), should deny
    const r = acquireProjectLock('recent-dead');
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain('TTL');
  });

  it('force acquisition recovers a recent dead owner without waiting for TTL', () => {
    const project = 'force-dead';
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `${project}.lock`),
      JSON.stringify({ pid: 99996, timestamp: Date.now(), project })
    );

    expect(forceAcquireProjectLock(project).acquired).toBe(true);
    releaseProjectLock(project);
  });

  it('force acquisition never bypasses a live owner', () => {
    const project = 'force-live';
    expect(acquireProjectLock(project).acquired).toBe(true);

    const forced = forceAcquireProjectLock(project);
    expect(forced.acquired).toBe(false);
    expect(forced.reason).toContain('live pid');
    releaseProjectLock(project);
  });

  it('cleans only the exact dead supervised-worker lock', () => {
    const project = 'supervised-dead';
    const deadPid = 2_000_000_000;
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `${project}.lock`),
      JSON.stringify({ pid: deadPid, timestamp: Date.now(), project }),
    );

    expect(releaseDeadProjectLockOwnedBy(project, deadPid - 1)).toBe(false);
    expect(isProjectLocked(project)).toBe(true);
    expect(releaseDeadProjectLockOwnedBy(project, deadPid)).toBe(true);
    expect(isProjectLocked(project)).toBe(false);
  });

  it('keeps project lock files inside the lock directory', () => {
    const project = '../outside-lock';
    expect(acquireProjectLock(project).acquired).toBe(true);
    expect(fs.existsSync(path.join(lynxHome, 'outside-lock.lock'))).toBe(false);
    releaseProjectLock(project);
  });

  it('recovers an expired malformed lock', () => {
    const project = 'malformed-expired';
    const lockDir = path.join(lynxHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lock = path.join(lockDir, `${project}.lock`);
    fs.writeFileSync(lock, '{bad json');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lock, old, old);

    expect(acquireProjectLock(project).acquired).toBe(true);
    releaseProjectLock(project);
  });
});
