import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleSemanticSearch } from '../../../src/mcp/handlers/semantic_search.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'semantic-ranking';

function insertNode(db: LynxDatabase, id: number, name: string, qualifiedName: string, kind: string, complexity = 1) {
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (?, ?, ?, ?, ?, ?, 1, 10, 1, 0, 0, ?)`
  ).run(id, PROJECT, kind, name, qualifiedName, `src/${name}.ts`, JSON.stringify({ cyclomaticComplexity: complexity }));
}

describe('semantic_search ranking', () => {
  afterEach(() => unsetDb(PROJECT, { close: false }));

  it('ranks a high direct-coverage OAuth symbol above a popular generic route', async () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, process.cwd());
    insertNode(db, 1, 'exchangeCodeForTokens', 'lib.connectors.google.exchangeCodeForTokens', 'Function');
    insertNode(db, 2, 'GET', 'app.api.analytics.google.route.GET', 'Route', 62);
    insertNode(db, 3, 'caller', 'src.caller', 'Function');
    for (let i = 0; i < 20; i++) {
      db.db.prepare(
        `INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, 'CALLS', '{}')`
      ).run(PROJECT, 3, 2);
    }
    setDb(PROJECT, db);

    const result = await handleSemanticSearch({
      project: PROJECT,
      query: 'exchange Google OAuth authorization code and persist token',
      limit: 2,
    }) as { results: Array<{ name: string }> };

    expect(result.results[0]?.name).toBe('exchangeCodeForTokens');
    db.close();
  });

  it('treats a plural query token as direct evidence for a lock symbol', async () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, process.cwd());
    insertNode(db, 1, 'releaseProjectLock', 'store.lock.releaseProjectLock', 'Function');
    insertNode(db, 2, 'recordUsageEvent', 'usage.metrics.recordUsageEvent', 'Function', 13);
    insertNode(db, 3, 'caller', 'src.caller', 'Function');
    for (let i = 0; i < 20; i++) {
      db.db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 3, ?, 'CALLS', '{}')`)
        .run(PROJECT, i % 2 === 0 ? 1 : 2);
    }
    db.db.prepare(`INSERT INTO findings (project, target_qn, target_file, category, severity, title, created_at) VALUES (?, 'usage.metrics.recordUsageEvent', 'src/recordUsageEvent.ts', 'review', 'low', 'generic finding', datetime('now'))`)
      .run(PROJECT);
    setDb(PROJECT, db);

    const result = await handleSemanticSearch({
      project: PROJECT,
      query: 'recover from database locks',
      limit: 2,
    }) as { relevance: { directly_covered_tokens: string[] }; results: Array<{ name: string }> };

    expect(result.relevance.directly_covered_tokens).toContain('locks');
    expect(result.results[0]?.name).toBe('releaseProjectLock');
    db.close();
  });
});
