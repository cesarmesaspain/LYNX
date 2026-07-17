import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { detectClusters } from '../../../src/intelligence/clustering.js';

describe('deterministic clustering', () => {
  let db: LynxDatabase;

  beforeEach(() => { db = LynxDatabase.openMemory(); });
  afterEach(() => db.close());

  it('returns stable communities for an unchanged graph', () => {
    const insertNode = db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, properties)
       VALUES (?, 'fixture', 'Function', ?, ?, ?, '{}')`,
    );
    for (let id = 1; id <= 6; id++) {
      const group = id <= 3 ? 'alpha' : 'beta';
      insertNode.run(id, `${group}Worker${id}`, `${group}.worker${id}`, `${group}/${id}.ts`);
    }
    const insertEdge = db.db.prepare(
      `INSERT INTO edges (project, source_id, target_id, type, properties)
       VALUES ('fixture', ?, ?, 'CALLS', '{}')`,
    );
    for (const [source, target] of [[1, 2], [2, 3], [3, 1], [4, 5], [5, 6], [6, 4]]) {
      insertEdge.run(source, target);
    }

    const first = detectClusters(db, 'fixture');
    const second = detectClusters(db, 'fixture');

    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first.reduce((sum, cluster) => sum + cluster.members, 0)).toBe(6);
  });
});
