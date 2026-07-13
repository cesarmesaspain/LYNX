import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleQueryGraph } from '../../../src/mcp/handlers/query_graph.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'query-graph-grouping';
const UNKNOWN = 'query-graph-unknown';

describe('query_graph Cypher aggregation', () => {
  afterEach(() => {
    unsetDb(PROJECT, { close: false });
    unsetDb(UNKNOWN, { close: true });
  });

  it('reports an unindexed project instead of an empty graph result', async () => {
    const result = await handleQueryGraph({ project: UNKNOWN, query: 'MATCH (n:Function) RETURN n.name' }) as Record<string, unknown>;
    expect(result.error).toContain('not indexed');
  });

  it('groups non-aggregate RETURN fields implicitly like Cypher', async () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, process.cwd());
    for (const [id, name, file] of [[1, 'one', 'src/a.ts'], [2, 'two', 'src/a.ts'], [3, 'three', 'src/b.ts']] as const) {
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties) VALUES (?, ?, 'Function', ?, ?, ?, 1, 1, 0, 0, 0, '{}')`).run(id, PROJECT, name, `app.${name}`, file);
    }
    setDb(PROJECT, db);

    const result = await handleQueryGraph({ project: PROJECT, query: 'MATCH (n:Function) RETURN n.file_path AS file, COUNT(*) AS functions ORDER BY functions DESC' }) as { rows: Array<{ file: string; functions: number }> };
    expect(result.rows).toEqual([{ file: 'src/a.ts', functions: 2 }, { file: 'src/b.ts', functions: 1 }]);
    db.close();
  });

  it('filters numeric node flags from their graph columns, not JSON properties', async () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, process.cwd());
    db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
      VALUES (1, ?, 'Function', 'main', 'app.main', 'src/index.ts', 1, 1, 1, 0, 1, '{}'),
             (2, ?, 'Function', 'helper', 'app.helper', 'src/helper.ts', 1, 1, 0, 0, 0, '{}')`).run(PROJECT, PROJECT);
    setDb(PROJECT, db);

    const result = await handleQueryGraph({
      project: PROJECT,
      query: "MATCH (n) WHERE n.is_entry_point = 1 RETURN n.name AS name, n.file_path AS file, n.is_entry_point AS entry",
    }) as { rows: Array<{ name: string; file: string; entry: number }> };

    expect(result.rows).toEqual([{ name: 'main', file: 'src/index.ts', entry: 1 }]);
    db.close();
  });
});
