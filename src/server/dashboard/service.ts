/*
 * dashboard/service.ts — Lifecycle manager for the standalone local dashboard.
 *
 * MCP servers are short-lived stdio children of Codex, Claude, VS Code, etc.
 * The dashboard must never share that lifecycle.  This module starts one
 * detached local process and tracks only its PID; it does not send telemetry
 * or expose the service outside loopback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { lynxHome } from '../../config/runtime.js';

function pidPath(): string {
  return path.join(lynxHome(), 'dashboard.pid');
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

function removeStalePid(): void {
  try { fs.unlinkSync(pidPath()); } catch { /* already absent */ }
}

export function dashboardServiceStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (!pid) return { running: false, pid: null };
  if (isProcessAlive(pid)) return { running: true, pid };
  removeStalePid();
  return { running: false, pid: null };
}

/** Start the dashboard as a detached process, independent from any MCP client. */
export function startDashboardService(command: string, args: string[], dryRun = false): string {
  const existing = dashboardServiceStatus();
  if (existing.running) return `dashboard service already running (pid ${existing.pid})`;
  // getLynxCommand() is shared with MCP configuration and therefore ends in
  // `serve`.  A dashboard service is a different CLI command, not an MCP
  // server with extra positional arguments.
  const baseArgs = args.at(-1) === 'serve' ? args.slice(0, -1) : args;
  const serviceArgs = [...baseArgs, 'dashboard', '--service'];
  if (dryRun) return `would start standalone dashboard service (${command} ${serviceArgs.join(' ')})`;

  fs.mkdirSync(lynxHome(), { recursive: true });
  const child = spawn(command, serviceArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, LYNX_DASHBOARD_SERVICE: '1' },
  });
  child.unref();
  fs.writeFileSync(pidPath(), String(child.pid));
  return `started standalone dashboard service (pid ${child.pid})`;
}

/** Stop only the detached dashboard service created by LYNX install. */
export function stopDashboardService(dryRun = false): string {
  const status = dashboardServiceStatus();
  if (!status.running || !status.pid) return 'dashboard service not running';
  if (dryRun) return `would stop standalone dashboard service (pid ${status.pid})`;

  try { process.kill(status.pid, 'SIGTERM'); } catch { /* process exited between checks */ }
  removeStalePid();
  return `stopped standalone dashboard service (pid ${status.pid})`;
}
