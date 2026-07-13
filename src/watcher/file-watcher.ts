/*
 * file-watcher.ts — Real-time file watcher with incremental re-indexing.
 *
 * Uses chokidar to watch the project directory. Changed files are debounced
 * (500ms) and re-indexed surgically: only the changed file is re-extracted,
 * its old nodes/edges deleted, and fresh edges resolved.
 *
 * Auto-pause: after 30min of inactivity the watcher closes to save battery.
 * It re-opens automatically when new file events arrive.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { watch, FSWatcher } from 'chokidar';
import type { LynxDatabase } from '../store/database.js';
import { upsertNode, upsertNodesBatch, deleteNodesByFile } from '../store/nodes.js';
import { deleteEdgesForNodesInFile } from '../store/edges.js';
import { upsertFileHash } from '../store/memory.js';
import { extractFile } from '../extraction/extractor.js';
import { fileToModuleQn } from '../pipeline/phases/extract.js';
import { resolveAll } from '../pipeline/phases/resolve/index.js';
import { isSupportedFilePath } from '../extraction/language-registry.js';
import { getGitContext } from '../git/context.js';
import type { LynxIndexMode, LynxIndexStatus } from '../types.js';
import type { ExtractionBatch } from '../pipeline/phases/extract.js';
import { ensureProjectBrief } from '../intelligence/project-brief.js';

const DEBOUNCE_MS = 500;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const PAUSE_CHECK_MS = 60_000; // Check every 1 min

export interface WatcherStatus {
  watching: boolean;
  paused: boolean;
  filesWatched: number;
  pendingChanges: number;
  lastActivity: number;
  changesProcessed: number;
}

/**
 * Real-time file watcher. Watches a project directory and re-indexes changed
 * files on the fly so the code graph stays fresh without manual re-indexing.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private pauseTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private paused = false;
  private changesProcessed = 0;
  private db: LynxDatabase;
  private repoPath: string;
  private project: string;
  private mode: LynxIndexMode;
  private active = false;

  constructor(
    db: LynxDatabase,
    repoPath: string,
    project: string,
    mode: LynxIndexMode = 'fast'
  ) {
    this.db = db;
    this.repoPath = repoPath;
    this.project = project;
    this.mode = mode;
  }

  /** Start watching the project directory. */
  start(): WatcherStatus {
    if (this.active) return this.status();
    this.active = true;
    this.paused = false;
    this.lastActivity = Date.now();

    const { ignored } = this.buildWatchConfig();

    this.watcher = watch(this.repoPath, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      depth: 50,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this.watcher.on('change', (filePath: string) => this.enqueue(filePath, 'change'));
    this.watcher.on('add', (filePath: string) => this.enqueue(filePath, 'add'));
    this.watcher.on('unlink', (filePath: string) => this.enqueue(filePath, 'unlink'));

    this.watcher.on('ready', () => {
      process.stderr.write(`[lynx-watcher] Watching ${this.watchedCount()} files\n`);
    });

    this.watcher.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[lynx-watcher] Error: ${msg}\n`);
    });

    // Periodic idle check
    this.pauseTimer = setInterval(() => this.checkIdle(), PAUSE_CHECK_MS);

    return this.status();
  }

  /** Stop watching (keep DB connection open). */
  async stop(): Promise<void> {
    this.active = false;
    await this.flushPending();
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    if (this.pauseTimer) { clearInterval(this.pauseTimer); this.pauseTimer = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  /** Current status for health checks. */
  status(): WatcherStatus {
    return {
      watching: this.active,
      paused: this.paused,
      filesWatched: this.watcher ? this.watchedCount() : 0,
      pendingChanges: this.pending.size,
      lastActivity: this.lastActivity,
      changesProcessed: this.changesProcessed,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private enqueue(absPath: string, _event: string): void {
    // Skip unsupported files
    const relPath = path.relative(this.repoPath, absPath);
    if (!isSupportedFilePath(relPath)) return;

    this.pending.add(relPath);
    this.lastActivity = Date.now();

    // Resume watcher on activity
    if (this.paused) {
      this.resume();
      return;
    }

    // Reset debounce — wait for quiet period before flushing
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushPending(), DEBOUNCE_MS);
  }

  private async flushPending(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return this.flushPending();
    }

    const flush = this.doFlushPending();
    this.flushInFlight = flush;
    try {
      await flush;
    } finally {
      this.flushInFlight = null;
    }
  }

  private async doFlushPending(): Promise<void> {
    if (this.pending.size === 0) return;

    const files = [...this.pending];
    this.pending.clear();

    const start = Date.now();
    let success = 0;
    let failed = 0;

    for (const relPath of files) {
      try {
        await this.reindexOneFile(relPath);
        success++;
      } catch (err: any) {
        failed++;
        process.stderr.write(
          `[lynx-watcher] Failed to reindex ${relPath}: ${err.message}\n`
        );
      }
    }

    this.changesProcessed += success;
    if (success > 0) {
      ensureProjectBrief(this.db, this.project).catch(() => {});
    }
    const elapsed = Date.now() - start;

    if (files.length > 1 || elapsed > 200) {
      process.stderr.write(
        `[lynx-watcher] Reindexed ${success} file(s)${failed > 0 ? ` (${failed} failed)` : ''} in ${elapsed}ms\n`
      );
    }
  }

  /**
   * Re-index a single file: extract → delete old → insert new → resolve edges.
   */
  private async reindexOneFile(relPath: string): Promise<void> {
    const absPath = path.resolve(this.repoPath, relPath);

    // Handle deleted files — just remove their nodes/edges
    if (!fs.existsSync(absPath)) {
      this.db.transaction(() => {
        deleteEdgesForNodesInFile(this.db, this.project, relPath);
        deleteNodesByFile(this.db, this.project, relPath);
      });
      return;
    }

    // Extract the file
    const source = fs.readFileSync(absPath, 'utf-8');
    const sha256 = createHash('sha256').update(source).digest('hex');
    const moduleQn = fileToModuleQn(relPath);
    const result = await extractFile(source, this.project, relPath, moduleQn);

    if (result.hasError) return;

    // Transaction: delete old, insert new
    this.db.transaction(() => {
      deleteEdgesForNodesInFile(this.db, this.project, relPath);
      deleteNodesByFile(this.db, this.project, relPath);

      if (result.nodes.length > 1) {
        upsertNodesBatch(this.db, result.nodes);
      } else if (result.nodes.length === 1) {
        upsertNode(this.db, result.nodes[0]);
      }
    });

    // Build a lightweight batch for edge resolution
    const batch: ExtractionBatch = {
      file: { relPath, absPath, extension: relPath.split('.').pop() || '', size: source.length },
      result,
      sha256,
    };

    resolveAll(this.db, [batch], this.project);

    // Update file hash cache
    let mtimeNs = 0;
    try {
      const stat = fs.statSync(absPath);
      mtimeNs = Math.floor(stat.mtimeMs * 1_000_000);
    } catch { /* keep 0 */ }
    this.db.transaction(() => {
      upsertFileHash(this.db, this.project, relPath, sha256, mtimeNs, source.length);
    });
  }

  private checkIdle(): void {
    const idle = Date.now() - this.lastActivity;
    if (!this.paused && idle >= IDLE_TIMEOUT_MS) {
      this.pause();
    }
  }

  private pause(): void {
    if (!this.watcher || this.paused) return;
    this.paused = true;
    this.watcher.close().catch(() => {});
    this.watcher = null;
    process.stderr.write(
      `[lynx-watcher] Paused after ${Math.round(IDLE_TIMEOUT_MS / 60000)}min idle\n`
    );
  }

  private resume(): void {
    if (!this.paused || !this.active) return;
    this.paused = false;

    const { ignored } = this.buildWatchConfig();

    this.watcher = watch(this.repoPath, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      depth: 50,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this.watcher.on('change', (fp: string) => this.enqueue(fp, 'change'));
    this.watcher.on('add', (fp: string) => this.enqueue(fp, 'add'));
    this.watcher.on('unlink', (fp: string) => this.enqueue(fp, 'unlink'));
    this.watcher.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[lynx-watcher] Error: ${msg}\n`);
    });

    process.stderr.write('[lynx-watcher] Resumed\n');
  }

  private buildWatchConfig(): { ignored: RegExp[] } {
    const names = [
      'node_modules', '.git', 'dist', 'build', '.next', '.next-build',
      '__pycache__', '.venv', 'venv', 'vendor', 'target', 'tmp', 'tmp_build',
      '.backups', 'backups', '.turbo', '.cache',
      'coverage', '.nyc_output', 'logs', 'public', 'workspace',
    ];
    const patterns = names.map((n) => new RegExp(`(^|[/\\\\])${n}($|[/\\\\])`));
    // Also ignore binary/media files
    patterns.push(/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|eot|mp[34]|wav|ogg|pdf|zip|tar|gz)$/i);
    return { ignored: patterns };
  }

  private watchedCount(): number {
    // chokidar doesn't expose watched count directly; estimate from file tree
    if (!this.watcher) return 0;
    const watched = (this.watcher as any)._watched as Map<string, any> | undefined;
    if (!watched) return 0;
    let count = 0;
    for (const [, files] of watched) {
      count += files instanceof Map ? files.size : Object.keys(files || {}).length;
    }
    return count;
  }
}
