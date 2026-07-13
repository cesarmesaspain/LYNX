import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleIngestTraces } from '../../../src/mcp/handlers/ingest_traces.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'ingest-traces';

afterEach(() => unsetDb(PROJECT, { close: false }));

describe('ingest_traces', () => {
  it('reports an unindexed project instead of treating all traces as skipped', async () => {
    const result = await handleIngestTraces({
      project: 'unknown-ingest-project',
      traces: [{ from: 'a', to: 'b', type: 'call' }],
    }) as Record<string, unknown>;

    expect(result.error).toContain('not indexed');
  });

  it('ingests a valid trace once and skips its duplicate', async () => {
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, process.cwd());
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'Function', 'source', 'app.source', 'src/a.ts', 1, 1, 0, 0, 0, '{}'),
               (2, ?, 'Function', 'target', 'app.target', 'src/b.ts', 1, 1, 0, 0, 0, '{}')`).run(PROJECT, PROJECT);
      setDb(PROJECT, db);

      const trace = { from: 'app.source', to: 'app.target', type: 'call' };
      expect(await handleIngestTraces({ project: PROJECT, traces: [trace] })).toMatchObject({ ingested: 1, skipped: 0 });
      expect(await handleIngestTraces({ project: PROJECT, traces: [trace] })).toMatchObject({ ingested: 0, skipped: 1 });
    } finally {
      db.close();
    }
  });
});
