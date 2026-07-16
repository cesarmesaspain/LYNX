import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lynxHome } from '../config/runtime.js';
import { getProjectRoot, isPkg } from '../paths.js';
import type { PipelineResult } from '../pipeline/orchestrator.js';
import { releaseDeadProjectLockOwnedBy } from '../store/lock.js';

export interface SupervisedIndexOptions {
  repoPath: string;
  project: string;
  mode: 'full' | 'moderate' | 'fast';
  incremental: boolean;
  forceLock: boolean;
  timeoutMs?: number;
}

export interface SupervisedIndexResult {
  pipeline: PipelineResult;
  workerPid: number;
}

/**
 * Run indexing outside the long-lived MCP process. A parser crash, OOM or
 * native abort can terminate the worker without closing the JSON-RPC transport.
 */
export function runSupervisedIndex(
  options: SupervisedIndexOptions,
): Promise<SupervisedIndexResult> {
  const resultDir = path.join(lynxHome(), 'tmp', 'index-results');
  fs.mkdirSync(resultDir, { recursive: true });
  const resultFile = path.join(resultDir, `${process.pid}-${randomUUID()}.json`);
  const cliArgs = [
    'index', options.repoPath,
    '--name', options.project,
    '--mode', options.mode,
    '--result-file', resultFile,
    ...(options.incremental ? ['--incremental'] : []),
    ...(options.forceLock ? ['--force-lock'] : []),
  ];
  const command = isPkg() ? process.execPath : process.execPath;
  const args = isPkg()
    ? cliArgs
    : [path.join(getProjectRoot(), 'dist', 'cli.js'), ...cliArgs];
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15 * 60_000);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.repoPath,
      env: { ...process.env, LYNX_INDEX_WORKER: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const workerPid = child.pid ?? -1;
    let stderr = '';
    let settled = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      try { fs.rmSync(resultFile, { force: true }); } catch { /* best effort */ }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`Index worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => fail(error));
    child.once('close', (code, signal) => {
      releaseDeadProjectLockOwnedBy(options.project, workerPid);
      if (settled) return;
      if (code !== 0) {
        fail(new Error(
          `Index worker failed (${signal ? `signal ${signal}` : `exit ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ));
        return;
      }
      try {
        const pipeline = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as PipelineResult;
        settled = true;
        cleanup();
        resolve({ pipeline, workerPid });
      } catch (error) {
        fail(new Error(`Index worker produced no valid result: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}
