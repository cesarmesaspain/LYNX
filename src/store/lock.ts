/*
 * lock.ts — Per-project lock files for index freshness.
 *
 * Prevents concurrent index runs on the same project and recovers
 * from stale locks left by crashed or killed processes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lynxHome, readLynxConfig } from '../config/runtime.js';

function locksDir(): string {
  const dir = path.join(lynxHome(), 'locks');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(project: string): string {
  // Project names may originate from CLI/MCP input. Encode separators so a
  // project cannot address files outside LYNX_HOME/locks.
  return path.join(locksDir(), `${encodeURIComponent(project)}.lock`);
}

export interface LockInfo {
  pid: number;
  timestamp: number;
  project: string;
}

function readLockInfoAt(filePath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

function readLockInfo(project: string): LockInfo | null {
  return readLockInfoAt(lockPath(project));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireProjectLock(project: string): { acquired: boolean; reason?: string } {
  const cfg = readLynxConfig();
  const ttlMs = cfg.lock_ttl_minutes * 60 * 1000;
  const existing = readLockInfo(project);

  if (!existing && fs.existsSync(lockPath(project))) {
    const age = Date.now() - fs.statSync(lockPath(project)).mtimeMs;
    if (age >= ttlMs) {
      releaseProjectLock(project);
    } else {
      return { acquired: false, reason: `Project ${project} has an incomplete lock file; retry after lock TTL.` };
    }
  }

  if (existing) {
    // Check if the owning process is still alive
    if (isProcessAlive(existing.pid)) {
      return { acquired: false, reason: `Project ${project} is already being indexed (pid ${existing.pid})` };
    }
    // Stale lock — process is dead
    const age = Date.now() - existing.timestamp;
    if (age < ttlMs) {
      return { acquired: false, reason: `Project ${project} has a recent lock (pid ${existing.pid} died ${Math.round(age / 1000)}s ago, TTL ${cfg.lock_ttl_minutes}m). Waiting for TTL expiry.` };
    }
    // Stale lock past TTL — break it
    releaseProjectLock(project);
  }

  const info: LockInfo = { pid: process.pid, timestamp: Date.now(), project };
  try {
    // `wx` makes the check-and-create operation atomic across indexer
    // processes. A second process must never overwrite a fresh lock.
    fs.writeFileSync(lockPath(project), JSON.stringify(info), { flag: 'wx' });
    return { acquired: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { acquired: false, reason: `Project ${project} is already being indexed` };
    }
    return { acquired: false, reason: `Unable to create index lock for ${project}` };
  }
}

/**
 * Break a stale lock immediately, but never bypass a live owner. This is the
 * safe implementation behind MCP `force_lock`: it shortens stale-lock TTL
 * recovery without permitting two indexers to mutate one project together.
 */
export function forceAcquireProjectLock(project: string): { acquired: boolean; reason?: string } {
  const filePath = lockPath(project);
  const existing = readLockInfo(project);
  if (existing && isProcessAlive(existing.pid)) {
    return {
      acquired: false,
      reason: `Project ${project} is already being indexed by live pid ${existing.pid}; force_lock cannot bypass an active owner.`,
    };
  }
  if (fs.existsSync(filePath)) releaseProjectLock(project);
  return acquireProjectLock(project);
}

export function releaseProjectLock(project: string): void {
  try { fs.rmSync(lockPath(project), { force: true }); } catch { /* ok */ }
}

/** Remove a supervised worker's orphaned lock without touching any successor. */
export function releaseDeadProjectLockOwnedBy(project: string, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const info = readLockInfo(project);
  if (!info || info.pid !== pid || isProcessAlive(pid)) return false;
  releaseProjectLock(project);
  return true;
}

export function isProjectLocked(project: string): boolean {
  return readLockInfo(project) !== null;
}

export interface StaleLockInfo {
  project: string;
  pid: number;
  ageMs: number;
  processAlive: boolean;
}

export function listOrphanedLocks(): StaleLockInfo[] {
  const dir = path.join(lynxHome(), 'locks');
  if (!fs.existsSync(dir)) return [];
  const results: StaleLockInfo[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.lock')) continue;
    const info = readLockInfoAt(path.join(dir, file));
    if (!info) continue;
    const alive = isProcessAlive(info.pid);
    if (!alive) {
      results.push({ project: info.project, pid: info.pid, ageMs: Date.now() - info.timestamp, processAlive: false });
    }
  }
  return results;
}
