import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLynxHome } from '../../../src/config/runtime.js';
import { LynxDatabase } from '../../../src/store/database.js';
import { insertEdge } from '../../../src/store/edges.js';

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
