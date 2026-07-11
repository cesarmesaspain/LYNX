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
    this.db.exec(`
      DROP INDEX IF EXISTS idx_edges_project;
      DROP INDEX IF EXISTS idx_edges_source;
      DROP INDEX IF EXISTS idx_edges_target;
      DROP INDEX IF EXISTS idx_edges_type;
    `);
    this.edgeIndexesDropped = true;
  }

  private ensureEdgeIndexes(): void {
    if (!this.edgeIndexesDropped) return;
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);
    `);
    this.edgeIndexesDropped = false;
  }

  // ── Schema ──────────────────────────────────────────────────

  private migrate(): void {
    // Add columns to existing projects table (v0.1 → v0.2 freshness migration)
    for (const col of ['status', 'status_error']) {
      try {
        this.db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT${col === 'status' ? " NOT NULL DEFAULT 'ready'" : ''}`);
      } catch {
        // Column already exists — skip
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'ready',
        status_error TEXT
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        is_exported INTEGER NOT NULL DEFAULT 0,
        is_test INTEGER NOT NULL DEFAULT 0,
        is_entry_point INTEGER NOT NULL DEFAULT 0,
        properties TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project, qualified_name)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(project, kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(qualified_name);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);

      CREATE TABLE IF NOT EXISTS file_hashes (
        project TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ns INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project, rel_path)
      );

      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        target_qn TEXT NOT NULL,
        target_file TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        metrics TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project);
      CREATE INDEX IF NOT EXISTS idx_findings_qn ON findings(target_qn);
      CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(target_file);

      CREATE TABLE IF NOT EXISTS index_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT (datetime('now')),
        total_nodes INTEGER NOT NULL DEFAULT 0,
        total_edges INTEGER NOT NULL DEFAULT 0,
        hotspot_count INTEGER NOT NULL DEFAULT 0,
        avg_complexity REAL NOT NULL DEFAULT 0,
        files_processed INTEGER NOT NULL DEFAULT 0,
        files_skipped INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'full'
      );

      CREATE INDEX IF NOT EXISTS idx_index_runs_project ON index_runs(project);

      CREATE TABLE IF NOT EXISTS project_briefs (
        project TEXT PRIMARY KEY,
        digest_hash TEXT NOT NULL,
        brief TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        input_tokens_est INTEGER NOT NULL DEFAULT 0,
        output_tokens_est INTEGER NOT NULL DEFAULT 0,
        cost_usd_est REAL NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
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
