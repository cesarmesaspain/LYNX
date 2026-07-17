/*
 * dashboard/service.ts — Lifecycle manager for the standalone local dashboard.
 *
 * MCP servers are short-lived stdio children of Codex, Claude, VS Code, etc.
 * The dashboard must never share that lifecycle.  This module starts one
 * detached local process and tracks only its PID; it does not send telemetry
 * or expose the service outside loopback.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { lynxHome } from '../../config/runtime.js';

const STARTUP_TIMEOUT_MS = 5_000;
const STARTUP_POLL_MS = 100;
const STARTUP_LOCK_STALE_MS = 10_000;

function pidPath(): string {
  return path.join(lynxHome(), 'dashboard.pid');
}

function startupLockPath(): string {
  return path.join(lynxHome(), 'dashboard.start.lock');
}

function readPid(): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDashboardServiceProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'ps';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`]
      : ['-p', String(pid), '-o', 'command='];
    const command = execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /(?:^|\s)dashboard(?:\s|$)/.test(command) && /(?:^|\s)--service(?:\s|$)/.test(command);
  } catch {
    return false;
  }
}

function isDashboardHealthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: 9191, path: '/api/health', timeout: 250 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireStartupLock(): number | null {
  try {
    return fs.openSync(startupLockPath(), 'wx', 0o600);
  } catch {
    try {
      const age = Date.now() - fs.statSync(startupLockPath()).mtimeMs;
      if (age > STARTUP_LOCK_STALE_MS) {
        fs.unlinkSync(startupLockPath());
        return fs.openSync(startupLockPath(), 'wx', 0o600);
      }
    } catch { /* another process released or replaced it */ }
    return null;
  }
}

function releaseStartupLock(fd: number): void {
  try { fs.closeSync(fd); } catch { /* already closed */ }
  try { fs.unlinkSync(startupLockPath()); } catch { /* already absent */ }
}

function removeStalePid(): void {
  try { fs.unlinkSync(pidPath()); } catch { /* already absent */ }
}

export function dashboardServiceStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (!pid) return { running: false, pid: null };
  if (isDashboardServiceProcess(pid)) return { running: true, pid };
  removeStalePid();
  return { running: false, pid: null };
}

/** Ensure one healthy detached dashboard exists, independent from any MCP client. */
export async function ensureDashboardService(command: string, args: string[], dryRun = false): Promise<string> {
  const existing = dashboardServiceStatus();
  if (existing.running && await isDashboardHealthy()) {
    return `dashboard service already running (pid ${existing.pid})`;
  }
  // getLynxCommand() is shared with MCP configuration and therefore ends in
  // `serve`.  A dashboard service is a different CLI command, not an MCP
  // server with extra positional arguments.
  const baseArgs = args.at(-1) === 'serve' ? args.slice(0, -1) : args;
  const serviceArgs = [...baseArgs, 'dashboard', '--service'];
  if (dryRun) return `would start standalone dashboard service (${command} ${serviceArgs.join(' ')})`;

  fs.mkdirSync(lynxHome(), { recursive: true });
  const lockFd = acquireStartupLock();
  if (lockFd === null) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(STARTUP_POLL_MS);
      const concurrent = dashboardServiceStatus();
      if (concurrent.running && await isDashboardHealthy()) {
        return `dashboard service already running (pid ${concurrent.pid})`;
      }
    }
    return 'dashboard service startup is already in progress but did not become healthy';
  }

  try {
    const afterLock = dashboardServiceStatus();
    if (afterLock.running && await isDashboardHealthy()) {
      return `dashboard service already running (pid ${afterLock.pid})`;
    }
    if (afterLock.pid) {
      try { process.kill(afterLock.pid, 'SIGTERM'); } catch { /* already exited */ }
      removeStalePid();
    }

    const child = spawn(command, serviceArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, LYNX_DASHBOARD_SERVICE: '1' },
    });
    child.unref();
    let startupFailure: string | null = null;
    child.once('error', (error) => { startupFailure = `failed to start standalone dashboard service (${error.message})`; });
    child.once('exit', (code, signal) => { startupFailure = `dashboard service exited during startup (${signal || `code ${code ?? 'unknown'}`})`; });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let healthyChecks = 0;
    while (Date.now() < deadline && !startupFailure) {
      await delay(STARTUP_POLL_MS);
      const pid = child.pid ?? null;
      const healthy = pid !== null && isDashboardServiceProcess(pid) && await isDashboardHealthy();
      healthyChecks = healthy ? healthyChecks + 1 : 0;
      if (healthyChecks >= 2 && pid !== null) {
        fs.writeFileSync(pidPath(), String(pid));
        return `started standalone dashboard service (pid ${pid})`;
      }
    }

    const pid = child.pid ?? null;
    if (pid && isDashboardServiceProcess(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    removeStalePid();
    return startupFailure || 'dashboard service failed health verification';
  } finally {
    releaseStartupLock(lockFd);
  }
}

export const startDashboardService = ensureDashboardService;

/** Stop only the detached dashboard service created by LYNX install. */
export function stopDashboardService(dryRun = false): string {
  const status = dashboardServiceStatus();
  if (!status.running || !status.pid) return 'dashboard service not running';
  if (dryRun) return `would stop standalone dashboard service (pid ${status.pid})`;

  try { process.kill(status.pid, 'SIGTERM'); } catch { /* process exited between checks */ }
  removeStalePid();
  return `stopped standalone dashboard service (pid ${status.pid})`;
}
