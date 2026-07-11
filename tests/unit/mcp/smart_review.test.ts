import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleSmartReview } from '../../../src/mcp/handlers/smart_review.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'test-smart-review-loop-depth';

describe('smart_review loop-depth evidence', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, '/tmp/test-smart-review-loop-depth');
    db.db.prepare(
      `INSERT INTO nodes (
        id, project, kind, name, qualified_name, file_path,
        start_line, end_line, is_exported, is_test, is_entry_point, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      PROJECT,
      'Function',
      'nestedWork',
      'src.worker.nestedWork',
      'src/worker.ts',
      1,
      40,
      1,
      0,
      0,
      JSON.stringify({
        cyclomaticComplexity: 5,
        cognitiveComplexity: 7,
        loopDepth: 4,
      })
    );
    setDb(PROJECT, db);
  });

  afterEach(() => {
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  it('does not present loop nesting as proven Big-O complexity', async () => {
    const result = await handleSmartReview({
      project: PROJECT,
      qualified_name: 'src.worker.nestedWork',
    }) as {
      issues: Array<{ category: string; description: string; suggestion: string }>;
    };

    const performanceIssue = result.issues.find((issue) => issue.category === 'performance');
    expect(performanceIssue).toBeDefined();
    expect(performanceIssue?.description).toContain('does not establish O(n^4) runtime complexity');
    expect(performanceIssue?.description).not.toContain('possible O(n^4)');
    expect(performanceIssue?.suggestion).toContain('before claiming Big-O complexity');
  });
});
