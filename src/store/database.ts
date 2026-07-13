/*
 * database.ts — SQLite graph store for LYNX.
 *
 * Uses better-sqlite3 with WAL mode for concurrent reads.
 * All graph data lives here: nodes, edges, file hashes, findings.
 * Schema is fully declarative — created on first open.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { lynxHome } from '../config/runtime.js';
import { CORE_SCHEMA, DROP_EDGE_INDEXES, CREATE_EDGE_INDEXES, migrateV01toV02 } from './ddl.js';

export class LynxDatabase {
  readonly db: BetterSqlite3.Database;
  readonly dbPath: string;
  private edgeIndexesDropped = false;

  private constructor(db: BetterSqlite3.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.configure();
  }

  // ── Factory methods ──────────────────────────────────────────

  static openMemory(): LynxDatabase {
    const db = new Database(':memory:');
    const instance = new LynxDatabase(db, ':memory:');
    instance.migrate();
    return instance;
  }

  static openPath(dbPath: string): LynxDatabase {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(dbPath);
    const instance = new LynxDatabase(db, dbPath);
    instance.migrate();
    return instance;
  }

  static openProject(projectName: string): LynxDatabase {
    const dbPath = path.join(lynxHome(), 'dbs', `${projectName}.db`);
    return LynxDatabase.openPath(dbPath);
  }

  // ── Configuration ────────────────────────────────────────────

  private configure(): void {
    // Let a concurrent writer finish a short transaction instead of failing
    // immediately with SQLITE_BUSY. Project locks still prevent concurrent
    // indexing; this only protects normal cross-process read/write overlap.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('cache_size = -64000'); // 64MB
  }

  beginBulk(): void {
    this.db.pragma('synchronous = OFF');
    this.db.pragma('cache_size = -256000'); // 256MB
    this.dropEdgeIndexesForBulk();
  }

  endBulk(): void {
    this.ensureEdgeIndexes();
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  private dropEdgeIndexesForBulk(): void {
    this.db.exec(DROP_EDGE_INDEXES);
    this.edgeIndexesDropped = true;
  }

  private ensureEdgeIndexes(): void {
    if (!this.edgeIndexesDropped) return;
    this.db.exec(CREATE_EDGE_INDEXES);
    this.edgeIndexesDropped = false;
  }

  // ── Schema ──────────────────────────────────────────────────

  private migrate(): void {
    migrateV01toV02(this.db);
    this.db.exec(CORE_SCHEMA);
  }

  // ── Project CRUD ────────────────────────────────────────────

  upsertProject(name: string, rootPath: string): void {
    this.db
      .prepare(
        `INSERT INTO projects (name, root_path, indexed_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, indexed_at = datetime('now')`
      )
      .run(name, rootPath);
  }

  setProjectStatus(name: string, status: string, error?: string): void {
    this.db
      .prepare(
        `UPDATE projects SET status = ?, status_error = ?, indexed_at = datetime('now') WHERE name = ?`
      )
      .run(status, error || null, name);
  }

  getProject(name: string): { name: string; rootPath: string; indexedAt: string; status: string; statusError: string | null } | null {
    const row = this.db
      .prepare('SELECT name, root_path, indexed_at, status, status_error FROM projects WHERE name = ?')
      .get(name) as { name: string; root_path: string; indexed_at: string; status: string; status_error: string | null } | undefined;
    if (!row) return null;
    return { name: row.name, rootPath: row.root_path, indexedAt: row.indexed_at, status: row.status, statusError: row.status_error };
  }

  listProjectsWithStatus(): Array<{ name: string; rootPath: string; indexedAt: string; status: string; statusError: string | null; nodeCount: number }> {
    const rows = this.db.prepare(`
      SELECT p.name, p.root_path, p.indexed_at, p.status, p.status_error,
        (SELECT COUNT(*) FROM nodes n WHERE n.project = p.name) as node_count
      FROM projects p ORDER BY p.name
    `).all() as Array<{ name: string; root_path: string; indexed_at: string; status: string; status_error: string | null; node_count: number }>;
    return rows.map(r => ({
      name: r.name,
      rootPath: r.root_path,
      indexedAt: r.indexed_at,
      status: r.status,
      statusError: r.status_error,
      nodeCount: r.node_count,
    }));
  }

  deleteProject(name: string): void {
    this.db.prepare('DELETE FROM edges WHERE project = ?').run(name);
    this.db.prepare('DELETE FROM nodes WHERE project = ?').run(name);
    this.db.prepare('DELETE FROM file_hashes WHERE project = ?').run(name);
    this.db.prepare('DELETE FROM findings WHERE project = ?').run(name);
    this.db.prepare('DELETE FROM project_briefs WHERE project = ?').run(name);
    this.db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  }

  // ── Transaction helpers ─────────────────────────────────────

  transaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  getDb(): BetterSqlite3.Database {
    return this.db;
  }
}
