import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleManageAdr } from '../../../src/mcp/handlers/manage_adr.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'manage-adr';

afterEach(() => unsetDb(PROJECT, { close: false }));

describe('manage_adr', () => {
  it('creates, reads, and enumerates ADR sections in project memory', async () => {
    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, process.cwd());
      setDb(PROJECT, db);
      const content = '# Decision\nUse SQLite WAL.\n## Consequences\nRetry short writer conflicts.';

      expect(await handleManageAdr({ project: PROJECT, mode: 'update', content })).toMatchObject({ updated: true, size: content.length });
      expect(await handleManageAdr({ project: PROJECT, mode: 'get' })).toMatchObject({ content });
      expect(await handleManageAdr({ project: PROJECT, mode: 'sections', sections: ['consequence'] })).toMatchObject({
        sections: ['# Decision', '## Consequences'],
        count: 2,
        matched_bodies: '## Consequences',
      });
    } finally {
      db.close();
    }
  });
});
