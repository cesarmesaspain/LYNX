import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handlePackMemory } from '../../../src/mcp/handlers/pack_memory.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'pack-memory-query';

afterEach(() => unsetDb(PROJECT, { close: false }));

describe('pack_memory text query', () => {
  it('filters broad memory findings by query text and records the applied query', async () => {
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, process.cwd());
      const insert = db.db.prepare(`INSERT INTO findings (project, target_qn, target_file, category, severity, title, description)
        VALUES (?, ?, ?, ?, 'low', ?, ?)`);
      insert.run(PROJECT, 'store.database', 'src/store/database.ts', 'reliability', 'SQLite lock recovery', 'Wait for a concurrent SQLite writer.');
      insert.run(PROJECT, 'dashboard.home', 'src/dashboard/home.ts', 'ui', 'Dashboard color', 'Adjust the dashboard palette.');
      setDb(PROJECT, db);

      const result = await handlePackMemory({ project: PROJECT, query: 'SQLite writer' }) as {
        query: { text?: string };
        findings: Array<{ title: string }>;
        run_comparison?: unknown;
      };

      expect(result.query.text).toBe('SQLite writer');
      expect(result.findings).toEqual([expect.objectContaining({ title: 'SQLite lock recovery' })]);
      expect(result.run_comparison).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
