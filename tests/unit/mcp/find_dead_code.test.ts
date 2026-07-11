import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleFindDeadCode } from '../../../src/mcp/handlers/find_dead_code.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'test-find-dead-code';

describe('find_dead_code evidence contract', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, '/tmp/test-find-dead-code');
    const insert = db.db.prepare(`
      INSERT INTO nodes (
        id, project, kind, name, qualified_name, file_path,
        start_line, end_line, is_exported, is_test, is_entry_point, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(1, PROJECT, 'Function', 'caller', 'src.caller', 'src/caller.ts', 1, 4, 0, 0, 1, '{}');
    insert.run(2, PROJECT, 'Function', 'used', 'src.used', 'src/used.ts', 1, 10, 0, 0, 0, '{}');
    insert.run(3, PROJECT, 'Function', 'dead', 'src.dead', 'src/dead.ts', 5, 20, 0, 0, 0, '{"signature":"dead()"}');
    insert.run(4, PROJECT, 'Class', 'PublicApi', 'src.PublicApi', 'src/public.ts', 1, 30, 1, 0, 0, '{}');
    insert.run(5, PROJECT, 'Function', 'testHelper', 'tests.testHelper', 'tests/helper.test.ts', 1, 5, 0, 1, 0, '{}');
    db.db.prepare(
      "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 1, 2, 'CALLS', '{}')"
    ).run(PROJECT);
    setDb(PROJECT, db);
  });

  afterEach(() => {
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  it('returns verified unreferenced definitions and excludes used, test, and entry symbols', async () => {
    const result = await handleFindDeadCode({ project: PROJECT }) as {
      candidates: Array<Record<string, unknown>>;
      verification_complete: boolean;
    };

    expect(result.verification_complete).toBe(true);
    expect(result.candidates.map((candidate) => candidate.qualified_name)).toEqual([
      'src.dead',
      'src.PublicApi',
    ]);
    expect(result.candidates[0]).toMatchObject({
      definition_verified: true,
      zero_incoming_references: true,
      incoming_calls: 0,
      confidence: 'high',
      signature: 'dead()',
    });
    expect(result.candidates[1]).toMatchObject({ confidence: 'medium' });
  });
});
