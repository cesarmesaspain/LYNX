/*
 * pack_context.test.ts — Tests for pack_context decision-ready mode.
 *
 * Tests that mode='decision' returns a decision_summary,
 * handles unindexed projects gracefully, and interacts
 * correctly with the search path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handlePackContext, hasAmbiguousCandidatePool } from '../../../src/mcp/handlers/pack_context.js';
import { setDb } from '../../../src/mcp/server.js';
import { TOOLS } from '../../../src/mcp/tools.js';

const PROJECT = 'test-pack-decision';

function seedDb(db: LynxDatabase, project: string, rootPath: string) {
  db.db.prepare(
    `INSERT INTO projects (name, root_path, indexed_at) VALUES (?, ?, ?)`
  ).run(project, rootPath, new Date().toISOString());

  const nodes: Array<{ kind: string; name: string; file_path: string; is_entry_point: number; is_exported: number; is_test: number }> = [
    { kind: 'Function', name: 'handleAuth', file_path: 'src/auth/handler.ts', is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'validateToken', file_path: 'src/auth/handler.ts', is_entry_point: 0, is_exported: 0, is_test: 0 },
    { kind: 'Function', name: 'loginRoute', file_path: 'src/routes/login.ts', is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'testAuth', file_path: 'tests/auth.test.ts', is_entry_point: 0, is_exported: 0, is_test: 1 },
  ];

  const nodeIds: Record<string, number> = {};
  let id = 1;
  for (const n of nodes) {
    const qn = `${n.file_path.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, 1, 10, ?, ?, ?, '{}')`
    ).run(id, project, n.kind, n.name, qn, n.file_path, n.is_exported, n.is_test, n.is_entry_point);
    nodeIds[qn] = id;
    id++;
  }

  // TESTS_FILE: tests/auth.test.ts → src/auth/handler.ts
  const testFileId = db.db.prepare(
    'SELECT id FROM nodes WHERE project = ? AND kind = \'File\' AND file_path = \'tests/auth.test.ts\''
  ).get(project) as { id: number } | undefined;
  const srcFileId = db.db.prepare(
    'SELECT id FROM nodes WHERE project = ? AND kind = \'File\' AND file_path = \'src/auth/handler.ts\''
  ).get(project) as { id: number } | undefined;

  if (testFileId && srcFileId) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'TESTS_FILE\', \'{}\')'
    ).run(project, testFileId.id, srcFileId.id);
  }

  // CALLS: loginRoute → handleAuth
  if (nodeIds['src.routes.login.loginRoute'] && nodeIds['src.auth.handler.handleAuth']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'CALLS\', \'{}\')'
    ).run(project, nodeIds['src.routes.login.loginRoute'], nodeIds['src.auth.handler.handleAuth']);
  }

  return nodeIds;
}

describe('pack_context decision mode', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  it('returns decision_summary when mode=decision and project is indexed', async () => {
    seedDb(db, PROJECT, process.cwd());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'review auth changes',
      mode: 'decision',
    });

    expect(result.mode).toBe('decision');
    expect(result.decision_summary).toBeDefined();
    expect(typeof result.decision_summary).toBe('string');
    expect(result.decision_summary!.length).toBeGreaterThan(0);
  });

  it('publishes decision mode in the MCP schema', () => {
    const tool = TOOLS.find(candidate => candidate.name === 'pack_context');
    const mode = tool?.inputSchema.properties.mode as { enum?: string[] } | undefined;

    expect(mode?.enum).toContain('decision');
  });

  it('reports no changes when git diff is empty (no repo)', async () => {
    // Use a path that definitely isn't a git repo
    seedDb(db, PROJECT, '/tmp/nonexistent-git-repo-' + Date.now());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'review auth changes',
      mode: 'decision',
    });

    expect(result.decision_summary).toBeDefined();
    // Without a git repo, collectGitDiffFiles returns [] → "no changes" message
    expect(result.decision_summary).toContain('No uncommitted changes');
  });

  it('returns guidance when project is not indexed', async () => {
    const result = await handlePackContext({
      project: 'nonexistent-project',
      task: 'review changes',
      mode: 'decision',
    });

    expect(result.decision_summary).toBeDefined();
    expect(result.decision_summary).toContain('not indexed');
  });

  it('directs callers to select a project when it was intentionally omitted', async () => {
    const result = await handlePackContext({ task: 'review changes' });

    expect(result.project).toBe('');
    expect(result.recommended_next_calls).toEqual([
      expect.objectContaining({ tool: 'list_projects' }),
    ]);
    expect(result.token_budget.confidence).toBe('low_no_project');
  });

  it('does not present an empty index as fresh', async () => {
    db.db.prepare(
      `INSERT INTO projects (name, root_path, indexed_at) VALUES (?, ?, ?)`
    ).run(PROJECT, process.cwd(), new Date().toISOString());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'inspect the architecture',
      mode: 'compact',
    });

    expect(result.index_health.total_nodes).toBe(0);
    expect(result.index_health.is_fresh).toBe(false);
    expect(result.recommended_next_calls.some(call => call.tool === 'index_repository')).toBe(true);
  });

  it('treats SQLite timestamps without a timezone as UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T13:10:48.000Z'));
    try {
      db.db.prepare(
        `INSERT INTO projects (name, root_path, indexed_at) VALUES (?, ?, ?)`
      ).run(PROJECT, process.cwd(), '2026-07-12 13:10:48');
      setDb(PROJECT, db);

      const result = await handlePackContext({
        project: PROJECT,
        task: 'inspect the architecture',
      });

      expect(result.index_health?.hours_since_index).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decision mode includes constraints', async () => {
    seedDb(db, PROJECT, process.cwd());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'analyze the auth module for vulnerabilities',
      mode: 'decision',
    });

    expect(result.critical_constraints).toContain('READ_TARGET_FILES_BEFORE_EDITING');
    expect(result.critical_constraints).toContain('VALIDATE_BEFORE_FINAL');
  });

  it('non-decision modes do not include decision_summary', async () => {
    seedDb(db, PROJECT, process.cwd());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'review auth changes',
      mode: 'compact',
    });

    expect(result.decision_summary).toBeUndefined();
    expect(result.graph_candidates.length).toBeGreaterThan(0);
  });

  it('decision mode recommends trace_path for high-fan-in symbols', async () => {
    seedDb(db, PROJECT, process.cwd());
    setDb(PROJECT, db);

    const result = await handlePackContext({
      project: PROJECT,
      task: 'review auth changes',
      mode: 'decision',
    });

    const tools = result.recommended_next_calls.map(c => c.tool);
    expect(tools).toContain('trace_path');
    expect(tools).toContain('assess_impact');
  });
});

describe('pack_context context selection', () => {
  it('detects only close deterministic candidate scores as ambiguous', () => {
    expect(hasAmbiguousCandidatePool([{ score: 10 }, { score: 9 }, { score: 2 }])).toBe(true);
    expect(hasAmbiguousCandidatePool([{ score: 10 }, { score: 7 }, { score: 2 }])).toBe(false);
  });
});
