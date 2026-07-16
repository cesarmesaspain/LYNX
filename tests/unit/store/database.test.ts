import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { withLynxHome } from '../../../src/config/runtime.js';
import { LynxDatabase } from '../../../src/store/database.js';
import { insertEdge } from '../../../src/store/edges.js';
import { runSchemaMigrations } from '../../../src/store/migrations.js';

describe('schema migration runner', () => {
  it('applies migrations in version order exactly once', () => {
    const db = new Database(':memory:');
    let executions = 0;
    const migrations = [
      {
        version: 2,
        name: 'second',
        up: (target: Database.Database) => {
          executions++;
          target.exec('ALTER TABLE example ADD COLUMN value TEXT');
        },
      },
      {
        version: 1,
        name: 'first',
        up: (target: Database.Database) => {
          executions++;
          target.exec('CREATE TABLE example (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    try {
      runSchemaMigrations(db, migrations);
      runSchemaMigrations(db, migrations);
      expect(executions).toBe(2);
      const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
      expect(rows).toEqual([
        { version: 1, name: 'first' },
        { version: 2, name: 'second' },
      ]);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed migration and does not record it', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runSchemaMigrations(db, [{
        version: 1,
        name: 'failing',
        up: (target) => {
          target.exec('CREATE TABLE partial_change (id INTEGER PRIMARY KEY)');
          throw new Error('migration failed');
        },
      }])).toThrow('migration failed');

      const partial = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_change'",
      ).get();
      expect(partial).toBeUndefined();
      const recorded = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
      expect(recorded.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('LynxDatabase concurrency configuration', () => {
  it('waits briefly for a concurrent SQLite writer instead of failing immediately', () => {
    const db = LynxDatabase.openMemory();
    try {
      expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});


describe('LynxDatabase project paths', () => {
  it('rejects project names that escape the configured database directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-project-path-'));
    const escapedPath = path.resolve(home, 'dbs', '../../escape-proof.db');

    try {
      withLynxHome(home, () => {
        expect(() => LynxDatabase.openProject('../../escape-proof')).toThrow(/project name/i);
      });
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(escapedPath, { force: true });
    }
  });
});


describe('edge evidence ledger', () => {
  it('persists structural evidence for an edge and removes it with the edge', () => {
    const db = LynxDatabase.openMemory();
    try {
      const insertNode = db.db.prepare('INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)');
      const sourceId = Number(insertNode.run('evidence', 'Function', 'source', 'mod.source', 'src/mod.ts').lastInsertRowid);
      const targetId = Number(insertNode.run('evidence', 'Function', 'target', 'mod.target', 'src/mod.ts').lastInsertRowid);
      const edgeId = insertEdge(db, {
        project: 'evidence', sourceId, targetId, type: 'CALLS',
        properties: { line: 12, resolution: 'same-file', confidence: 0.9 },
      });
      const row = db.db.prepare('SELECT evidence_type, source_kind, start_line, strength, payload_json FROM edge_evidence WHERE edge_id = ?').get(edgeId) as { evidence_type: string; source_kind: string; start_line: number; strength: number; payload_json: string };
      expect(row.evidence_type).toBe('structural');
      expect(row.source_kind).toBe('same-file');
      expect(row.start_line).toBe(12);
      expect(row.strength).toBe(0.9);
      expect(JSON.parse(row.payload_json)).toMatchObject({ line: 12, resolution: 'same-file' });
      db.db.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);
      const remaining = db.db.prepare('SELECT COUNT(*) AS count FROM edge_evidence WHERE edge_id = ?').get(edgeId) as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('project indexed commit metadata', () => {
  it('migrates legacy project databases and persists the indexed commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-indexed-commit-'));
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'ready',
        status_error TEXT
      );
    `);
    legacy.close();

    const db = LynxDatabase.openPath(dbPath);
    try {
      const columns = db.db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('indexed_commit');
      const migrations = db.db
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all();
      expect(migrations).toEqual([
        { version: 1, name: 'project freshness columns' },
        { version: 2, name: 'project indexed commit' },
        { version: 3, name: 'SACG vertical slice tables' },
      ]);
      db.upsertProject('legacy', dir);
      expect(db.getProject('legacy')?.indexedCommit).toBeNull();
      db.setProjectIndexedCommit('legacy', 'abc123');
      expect(db.getProject('legacy')?.indexedCommit).toBe('abc123');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
