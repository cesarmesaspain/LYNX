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

  it('keeps LLM enrichment opt-in for a fast deterministic default', async () => {
    const started = Date.now();
    const result = await handleSmartReview({
      project: PROJECT,
      qualified_name: 'src.worker.nestedWork',
    }) as { issues: Array<{ category: string }> };

    expect(result.issues.some(issue => issue.category === 'smell-classification')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('accepts target as a file alias for review workflow handoffs', async () => {
    const result = await handleSmartReview({
      project: PROJECT,
      target: 'src/worker.ts',
    }) as { target: { file?: string }; issues: unknown[] };

    expect(result.target.file).toBe('src/worker.ts');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('uses graph-linked tests even when they live outside the source directory', async () => {
    db.db.prepare('UPDATE nodes SET properties = ? WHERE id = 1').run(JSON.stringify({
      cyclomaticComplexity: 12,
      cognitiveComplexity: 14,
      loopDepth: 0,
    }));
    db.db.prepare(
      `INSERT INTO nodes (
        id, project, kind, name, qualified_name, file_path,
        start_line, end_line, is_exported, is_test, is_entry_point, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(2, PROJECT, 'Function', 'testsNestedWork', 'tests.worker.testsNestedWork',
      'tests/unit/worker.test.ts', 1, 10, 0, 1, 0, '{}');
    db.db.prepare(
      `INSERT INTO edges (project, source_id, target_id, type, properties)
       VALUES (?, ?, ?, 'TESTS', '{}')`
    ).run(PROJECT, 2, 1);

    const result = await handleSmartReview({
      project: PROJECT,
      qualified_name: 'src.worker.nestedWork',
    }) as { issues: Array<{ category: string }> };

    expect(result.issues.some(issue => issue.category === 'test-coverage')).toBe(false);
  });
});
