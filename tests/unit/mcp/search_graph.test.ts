/*
 * search_graph.test.ts — Unit tests for strict AND filter semantics.
 *
 * Tests that file_pattern, label, textSearchTokens, min_degree,
 * exclude_entry_points, and their combinations are joined with AND.
 * Uses the search() function directly with an in-memory DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { search } from '../../../src/store/search.js';
import type { LynxNodeKind } from '../../../src/types.js';

function seedDb(db: LynxDatabase, project: string) {
  const nodes: Array<{
    kind: string; name: string; file_path: string; is_entry_point: number; is_exported: number;
  }> = [
    // src/mcp/handlers/
    { kind: 'Function', name: 'handleSearchGraph', file_path: 'src/mcp/handlers/search_graph.ts', is_entry_point: 0, is_exported: 1 },
    { kind: 'Function', name: 'handleDetectChanges', file_path: 'src/mcp/handlers/detect_changes.ts', is_entry_point: 0, is_exported: 1 },
    { kind: 'Function', name: 'handleIndexRepo', file_path: 'src/mcp/handlers/index_repository.ts', is_entry_point: 0, is_exported: 1 },
    // src/cli/
    { kind: 'Function', name: 'main', file_path: 'src/cli/index.ts', is_entry_point: 1, is_exported: 0 },
    { kind: 'Function', name: 'searchCommand', file_path: 'src/cli/commands/search.ts', is_entry_point: 1, is_exported: 1 },
    // src/store/
    { kind: 'Function', name: 'search', file_path: 'src/store/search.ts', is_entry_point: 0, is_exported: 1 },
    { kind: 'Function', name: 'expandQuery', file_path: 'src/store/search.ts', is_entry_point: 0, is_exported: 1 },
    // src/pipeline/
    { kind: 'Class', name: 'Pipeline', file_path: 'src/pipeline/orchestrator.ts', is_entry_point: 0, is_exported: 1 },
    { kind: 'Function', name: 'runPipeline', file_path: 'src/pipeline/orchestrator.ts', is_entry_point: 0, is_exported: 1 },
    // Route kind
    { kind: 'Route', name: 'GET /api/search', file_path: 'src/server/routes.ts', is_entry_point: 0, is_exported: 1 },
    { kind: 'Route', name: 'POST /api/index', file_path: 'src/server/routes.ts', is_entry_point: 0, is_exported: 1 },
  ];

  // Dummy source node for edge FK references
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (999, ?, 'Function', 'caller', 'caller', 'src/caller.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(project);

  let id = 1;
  for (const n of nodes) {
    const qn = `${n.file_path.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, 1, 10, ?, 0, ?, '{}')`
    ).run(id, project, n.kind, n.name, qn, n.file_path, n.is_exported, n.is_entry_point);

    // Add edges for degree filtering tests
    if (n.name === 'search' || n.name === 'runPipeline') {
      // These get 5 CALLS edges → in_degree=5
      for (let e = 0; e < 5; e++) {
        db.db.prepare(
          'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 999, ?, \'CALLS\', \'{}\')'
        ).run(project, id);
      }
    }

    id++;
  }
}

const PROJECT = 'test-search-and';

describe('search_graph AND filter semantics', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db, PROJECT);
  });

  function searchResults(params: Record<string, unknown>) {
    return search(db, {
      project: PROJECT,
      limit: 50,
      offset: 0,
      excludeEntryPoints: false,
      sortBy: 'relevance',
      ...params,
    } as Parameters<typeof search>[1]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Single filter tests (baseline)
  // ═══════════════════════════════════════════════════════════════

  it('file_pattern alone returns only matching files', () => {
    const r = searchResults({ filePattern: 'src/mcp/**' });
    const files = new Set(r.results.map(x => x.node.filePath));
    expect(files.size).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/^src\/mcp\//);
    }
  });

  it('label alone returns only matching kind', () => {
    const r = searchResults({ label: 'Route' as LynxNodeKind });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      expect(x.node.kind).toBe('Route');
    }
  });

  it('textSearchTokens alone matches name or qualified_name', () => {
    const r = searchResults({ textSearchTokens: ['search'] });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      const matches = x.node.name.toLowerCase().includes('search') ||
        x.node.qualifiedName.toLowerCase().includes('search');
      expect(matches).toBe(true);
    }
  });

  it('exclude_entry_points filters out entry points', () => {
    const r = searchResults({ excludeEntryPoints: true });
    for (const x of r.results) {
      expect(x.node.isEntryPoint).toBe(false);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // AND combination tests (the core of WS5.1)
  // ═══════════════════════════════════════════════════════════════

  it('file_pattern AND textSearchTokens — must satisfy BOTH', () => {
    // "search" matches: handleSearchGraph, searchCommand, search (in store/search.ts)
    // file_pattern src/mcp/** filters out searchCommand (src/cli/) and search (src/store/)
    const r = searchResults({
      filePattern: 'src/mcp/**',
      textSearchTokens: ['search'],
    });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      expect(x.node.filePath).toMatch(/^src\/mcp\//);
      const matches = x.node.name.toLowerCase().includes('search') ||
        x.node.qualifiedName.toLowerCase().includes('search');
      expect(matches).toBe(true);
    }
    // handleDetectChanges and handleIndexRepo should NOT appear (don't match "search")
    const names = r.results.map(x => x.node.name);
    expect(names).not.toContain('handleDetectChanges');
    expect(names).not.toContain('handleIndexRepo');
  });

  it('label AND file_pattern — must satisfy BOTH', () => {
    // Route in src/mcp/ — there are Routes only in src/server/routes.ts
    const r = searchResults({
      label: 'Route' as LynxNodeKind,
      filePattern: 'src/mcp/**',
    });
    // No routes in src/mcp/ → should be empty
    expect(r.results.length).toBe(0);
  });

  it('label AND textSearchTokens — must satisfy BOTH', () => {
    // Route kind + "search" token — GET /api/search is a Route with "search" in name
    const r = searchResults({
      label: 'Route' as LynxNodeKind,
      textSearchTokens: ['search'],
    });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      expect(x.node.kind).toBe('Route');
      expect(x.node.name.toLowerCase()).toContain('search');
    }
  });

  it('exclude_entry_points AND textSearchTokens', () => {
    const r = searchResults({
      excludeEntryPoints: true,
      textSearchTokens: ['search'],
    });
    for (const x of r.results) {
      expect(x.node.isEntryPoint).toBe(false);
      const matches = x.node.name.toLowerCase().includes('search') ||
        x.node.qualifiedName.toLowerCase().includes('search');
      expect(matches).toBe(true);
    }
  });

  it('min_degree filters by total degree (in + out)', () => {
    // search() and runPipeline() have 5 inbound CALLS edges
    const r = searchResults({ minDegree: 3 });
    const names = r.results.map(x => x.node.name);
    expect(names).toContain('search');
    expect(names).toContain('runPipeline');
  });

  it('min_degree AND label — both must hold', () => {
    // Only Function with minDegree=3
    const r = searchResults({
      minDegree: 3,
      label: 'Class' as LynxNodeKind,
    });
    // Pipeline is a Class but has 0 edges
    expect(r.results.length).toBe(0);
  });

  it('all filters combined — file_pattern + label + textSearchTokens + exclude_entry_points', () => {
    const r = searchResults({
      filePattern: 'src/mcp/**',
      label: 'Function' as LynxNodeKind,
      textSearchTokens: ['handle'],
      excludeEntryPoints: true,
    });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      expect(x.node.filePath).toMatch(/^src\/mcp\//);
      expect(x.node.kind).toBe('Function');
      expect(x.node.name.toLowerCase()).toContain('handle');
      expect(x.node.isEntryPoint).toBe(false);
    }
  });

  it('mutually exclusive filters return zero results', () => {
    // No Routes in src/mcp/ named "handle"
    const r = searchResults({
      filePattern: 'src/mcp/**',
      label: 'Route' as LynxNodeKind,
      textSearchTokens: ['handle'],
    });
    expect(r.results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM boundary tests (enable_llm, LlmUsage contract)
// ═══════════════════════════════════════════════════════════════

import { handleSearchGraph } from '../../../src/mcp/handlers/search_graph.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const LLM_PROJECT = 'test-llm-boundary';

function seedLlmDb(db: LynxDatabase) {
  const nodes = [
    { kind: 'Function', name: 'authenticateUser', file: 'src/auth/login.ts', exported: 1, entry: 0, test: 0, lines: '1,30' },
    { kind: 'Function', name: 'validatePassword', file: 'src/auth/login.ts', exported: 0, entry: 0, test: 0, lines: '32,50' },
    { kind: 'Function', name: 'hashPassword', file: 'src/auth/crypto.ts', exported: 1, entry: 0, test: 0, lines: '1,20' },
    { kind: 'Class', name: 'User', file: 'src/models/user.ts', exported: 1, entry: 0, test: 0, lines: '1,50' },
    { kind: 'Function', name: 'main', file: 'src/cli.ts', exported: 0, entry: 1, test: 0, lines: '1,10' },
  ];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const qn = `${n.file.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    const [startLine, endLine] = n.lines.split(',').map(Number);
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
    ).run(i + 1, LLM_PROJECT, n.kind, n.name, qn, n.file, startLine, endLine, n.exported, n.test, n.entry);
  }
  db.upsertProject(LLM_PROJECT, '/tmp/test-llm-boundary');
}

describe('search_graph LLM boundary', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedLlmDb(db);
    setDb(LLM_PROJECT, db);
  });

  afterEach(() => {
    unsetDb(LLM_PROJECT, { close: false });
    db.close();
  });

  it('enable_llm=false skips LLM entirely', async () => {
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'auth', enable_llm: false }) as Record<string, unknown>;
    const usage = result.llm_usage as { enabled: boolean; used: boolean; calls: number; provider: string | null };
    expect(usage.enabled).toBe(false);
    expect(usage.used).toBe(false);
    expect(usage.calls).toBe(0);
    expect(usage.provider).toBeNull();
  });

  it('enable_llm=true defaults to enabled', async () => {
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'auth' }) as Record<string, unknown>;
    const usage = result.llm_usage as { enabled: boolean };
    expect(usage.enabled).toBe(true);
  });

  it('no query skips rerank (llm_usage.used=false)', async () => {
    const result = await handleSearchGraph({ project: LLM_PROJECT, name_pattern: 'auth' }) as Record<string, unknown>;
    const usage = result.llm_usage as { enabled: boolean; used: boolean; calls: number };
    expect(usage.enabled).toBe(true);
    expect(usage.used).toBe(false);
    expect(usage.calls).toBe(0);
  });

  it('fewer than 3 candidates skips rerank', async () => {
    // "User" only matches the Class node (1 result), < 3
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'User' }) as Record<string, unknown>;
    const usage = result.llm_usage as { enabled: boolean; used: boolean; calls: number };
    expect(usage.enabled).toBe(true);
    expect(usage.used).toBe(false);
  });

  it('3+ candidates with query triggers LLM call', async () => {
    // "auth" matches 3 functions (authenticateUser, validatePassword, hashPassword)
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'auth' }) as Record<string, unknown>;
    const usage = result.llm_usage as { enabled: boolean; used: boolean; calls: number; provider: string | null; latency_ms: number };
    expect(usage.enabled).toBe(true);
    expect(usage.used).toBe(true);
    expect(usage.calls).toBe(1);
    expect(usage.provider).toBeDefined();
    expect(usage.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('llm_usage present even when no LLM runs', async () => {
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'auth', enable_llm: false }) as Record<string, unknown>;
    expect(result.llm_usage).toBeDefined();
    const usage = result.llm_usage as Record<string, unknown>;
    expect(typeof usage.enabled).toBe('boolean');
    expect(typeof usage.used).toBe('boolean');
    expect(typeof usage.calls).toBe('number');
    expect(typeof usage.latency_ms).toBe('number');
    expect(typeof usage.fallback_used).toBe('boolean');
  });

  it('result semantics unchanged with enable_llm=false', async () => {
    const result = await handleSearchGraph({ project: LLM_PROJECT, query: 'auth', enable_llm: false }) as Record<string, unknown>;
    const results = result.results as Array<{ qualified_name: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
    // "auth" should match all 3 auth functions even without re-rank
    const names = results.map(r => r.qualified_name);
    expect(names.some(n => n.includes('authenticateUser'))).toBe(true);
    expect(names.some(n => n.includes('validatePassword'))).toBe(true);
    expect(names.some(n => n.includes('hashPassword'))).toBe(true);
  });
});
