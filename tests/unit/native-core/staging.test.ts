import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_STAGING_DDL,
  NATIVE_STAGING_SCHEMA_VERSION,
  validateNativeStaging,
} from '../../../src/native-core/staging.js';

function staging(): Database.Database {
  const db = new Database(':memory:');
  db.exec(NATIVE_STAGING_DDL);
  return db;
}

describe('native staging contract', () => {
  it('accepts a complete, internally consistent extraction artifact', () => {
    const db = staging();
    try {
      db.prepare('INSERT INTO native_run VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
        NATIVE_STAGING_SCHEMA_VERSION,
        'native-v1',
        'fixture',
        '/repo',
        'complete',
        '2026-07-16T00:00:00.000Z',
        '2026-07-16T00:00:01.000Z',
      );
      const fileId = Number(db.prepare(
        "INSERT INTO native_files (rel_path, language, sha256, size_bytes, status) VALUES ('src/a.c', 'c', 'abc', 10, 'complete')",
      ).run().lastInsertRowid);
      db.prepare(
        "INSERT INTO native_nodes (file_id, kind, name, qualified_name, start_line, end_line, is_exported, is_test, is_entry_point) VALUES (?, 'Function', 'main', 'src.a.main', 1, 3, 1, 0, 1)",
      ).run(fileId);
      db.prepare(
        "INSERT INTO native_calls (file_id, enclosing_qualified_name, callee_name, dispatch_kind, start_line) VALUES (?, 'src.a.main', 'run', 'direct', 2)",
      ).run(fileId);

      expect(validateNativeStaging(db, 'fixture')).toEqual({
        valid: true,
        errors: [],
        counts: { files: 1, nodes: 1, calls: 1, imports: 0, usages: 0, edges: 0, partialFiles: 0 },
      });
    } finally {
      db.close();
    }
  });

  it('rejects incomplete or wrong-project artifacts before publication', () => {
    const db = staging();
    try {
      db.prepare('INSERT INTO native_run VALUES (1, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(
        NATIVE_STAGING_SCHEMA_VERSION,
        'native-v1',
        'other-project',
        '/repo',
        'building',
        '2026-07-16T00:00:00.000Z',
      );

      const result = validateNativeStaging(db, 'fixture');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('project identity mismatch');
      expect(result.errors).toContain('native run is not complete');
    } finally {
      db.close();
    }
  });

  it('rejects schema drift before querying artifact contents', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE native_run (singleton INTEGER PRIMARY KEY)');
      const result = validateNativeStaging(db, 'fixture');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('staging table native_run has incompatible columns');
      expect(result.errors).toContain('missing staging table native_files');
    } finally {
      db.close();
    }
  });

  it('rejects edges whose source or target node is missing', () => {
    const db = staging();
    try {
      db.prepare('INSERT INTO native_run VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
        NATIVE_STAGING_SCHEMA_VERSION,
        'native-v1',
        'fixture',
        '/repo',
        'complete',
        '2026-07-16T00:00:00.000Z',
        '2026-07-16T00:00:01.000Z',
      );
      const fileId = Number(db.prepare(
        "INSERT INTO native_files (rel_path, language, sha256, size_bytes, status) VALUES ('src/a.c', 'c', 'abc', 10, 'complete')",
      ).run().lastInsertRowid);
      db.prepare(
        "INSERT INTO native_nodes (file_id, kind, name, qualified_name, start_line, end_line, is_exported, is_test, is_entry_point) VALUES (?, 'Function', 'main', 'src.a.main', 1, 3, 1, 0, 1)",
      ).run(fileId);
      db.prepare(
        "INSERT INTO native_edges (file_id, source_qualified_name, target_qualified_name, type, start_line, start_column, confidence, strategy) VALUES (?, 'src.a.main', 'src.a.missing', 'CALLS', 2, 4, 1.0, 'fixture')",
      ).run(fileId);

      const result = validateNativeStaging(db, 'fixture');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('1 edges reference missing nodes');
    } finally {
      db.close();
    }
  });
});
