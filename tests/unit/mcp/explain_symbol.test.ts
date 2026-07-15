import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleExplainSymbol } from '../../../src/mcp/handlers/explain_symbol.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'explain-symbol-metrics';

afterEach(() => unsetDb(PROJECT, { close: false }));

describe('explain_symbol dependency metrics', () => {
  it('excludes structural edges from fan metrics and exposes matching callers', async () => {
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, process.cwd());
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'File', 'service.ts', 'app.file.service', 'src/service.ts', 1, 1, 0, 0, 0, '{}'),
               (2, ?, 'Function', 'service', 'app.service', 'src/service.ts', 1, 1, 1, 0, 0, '{}'),
               (3, ?, 'Function', 'caller', 'app.caller', 'src/caller.ts', 1, 1, 0, 0, 0, '{}')`).run(PROJECT, PROJECT, PROJECT);
      db.db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties) VALUES
        (?, 1, 2, 'DEFINES', '{}'), (?, 3, 2, 'CALLS', '{}'), (?, 2, 1, 'WRITES', '{}')`).run(PROJECT, PROJECT, PROJECT);
      setDb(PROJECT, db);

      const result = await handleExplainSymbol({ project: PROJECT, qualified_name: 'app.service' }) as Record<string, any>;

      expect(result.dependencies.fan_in).toBe(1);
      expect(result.dependencies.fan_out).toBe(0);
      expect(result.dependencies.callers).toEqual([expect.objectContaining({ name: 'caller', type: 'CALLS' })]);
    } finally {
      db.close();
    }
  });
});
