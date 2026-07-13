/*
 * search-core.test.ts — Regression tests for executeLocalSearchGraph pure core.
 *
 * Verifies:
 *   1. Core produces same data as current handleSearchGraph
 *   2. Order stability
 *   3. Dedup by qualified_name
 *   4. Pagination (limit/offset)
 *   5. Empty results
 *   6. Structured filters (label, file_pattern, name_pattern, qn_pattern)
 *   7. Degree filters
 *   8. exclude_entry_points
 *   9. No metrics/narrative leakage in core
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { executeLocalSearchGraph } from '../../../src/federation/search-core.js';
import { handleSearchGraph } from '../../../src/mcp/handlers/search_graph.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'test-search-core';

function seedDb(db: LynxDatabase) {
  const nodes: Array<{
    kind: string; name: string; file_path: string; start_line: number; end_line: number;
    is_entry_point: number; is_exported: number; is_test: number;
  }> = [
    { kind: 'Function', name: 'handleSearchGraph', file_path: 'src/mcp/handlers/search_graph.ts', start_line: 1, end_line: 30, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'handleDetectChanges', file_path: 'src/mcp/handlers/detect_changes.ts', start_line: 1, end_line: 25, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'handleIndexRepo', file_path: 'src/mcp/handlers/index_repository.ts', start_line: 1, end_line: 20, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'main', file_path: 'src/cli/index.ts', start_line: 1, end_line: 10, is_entry_point: 1, is_exported: 0, is_test: 0 },
    { kind: 'Function', name: 'searchCommand', file_path: 'src/cli/commands/search.ts', start_line: 1, end_line: 15, is_entry_point: 1, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'search', file_path: 'src/store/search.ts', start_line: 1, end_line: 50, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'expandQuery', file_path: 'src/store/search.ts', start_line: 52, end_line: 70, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Class', name: 'Pipeline', file_path: 'src/pipeline/orchestrator.ts', start_line: 1, end_line: 40, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Function', name: 'runPipeline', file_path: 'src/pipeline/orchestrator.ts', start_line: 42, end_line: 60, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Route', name: 'GET /api/search', file_path: 'src/server/routes.ts', start_line: 1, end_line: 5, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { kind: 'Route', name: 'POST /api/index', file_path: 'src/server/routes.ts', start_line: 6, end_line: 10, is_entry_point: 0, is_exported: 1, is_test: 0 },
    // Test files — should appear when includeTests would be set (not relevant for search)
    { kind: 'Function', name: 'testHelper', file_path: 'src/__tests__/helpers.ts', start_line: 1, end_line: 10, is_entry_point: 0, is_exported: 0, is_test: 1 },
  ];

  // Dummy source node for edge FK references
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (999, ?, 'Function', 'caller', 'caller', 'src/caller.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(PROJECT);

  let id = 1;
  for (const n of nodes) {
    const qn = `${n.file_path.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
    ).run(id, PROJECT, n.kind, n.name, qn, n.file_path, n.start_line, n.end_line, n.is_exported, n.is_test, n.is_entry_point);

    // Add edges for degree filtering
    if (n.name === 'search' || n.name === 'runPipeline') {
      for (let e = 0; e < 5; e++) {
        db.db.prepare(
          'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 999, ?, \'CALLS\', \'{}\')'
        ).run(PROJECT, id);
      }
    }
    id++;
  }
  db.upsertProject(PROJECT, '/tmp/test-search-core');
}

describe('search_graph core — result parity with handler', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db);
    setDb(PROJECT, db);
  });

  afterEach(() => {
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  // ── Helper: extract core-relevant data from handler output ──

  async function handlerSearch(params: Record<string, unknown>) {
    const result = await handleSearchGraph({ project: PROJECT, enable_llm: false, ...params }) as Record<string, unknown>;
    return result;
  }

  function coreSearch(query?: string, overrides?: Record<string, unknown>) {
    const params = {
      project: PROJECT,
      query,
      label: undefined as string | undefined,
      namePattern: undefined as string | undefined,
      qnPattern: undefined as string | undefined,
      nameLike: undefined as string | undefined,
      qnLike: undefined as string | undefined,
      filePattern: undefined as string | undefined,
      limit: 10,
      offset: 0,
      minDegree: undefined as number | undefined,
      maxDegree: undefined as number | undefined,
      excludeEntryPoints: false,
      ...overrides,
    };
    return executeLocalSearchGraph(db, params);
  }

  // ── Parity tests: core results match handler results (data layer) ──

  it('full-text query: core results match handler results', async () => {
    // Use a high limit so handler doesn't slice
    const handler = await handlerSearch({ query: 'search', limit: 50 });
    const core = coreSearch('search', { limit: 50 });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    expect(core.total).toBe(hResults.length);

    for (let i = 0; i < core.results.length; i++) {
      expect(core.results[i].qualified_name).toBe(hResults[i].qualified_name);
      expect(core.results[i].name).toBe(hResults[i].name);
      expect(core.results[i].kind).toBe(hResults[i].kind);
      expect(core.results[i].file_path).toBe(hResults[i].file);
      expect(core.results[i].in_degree).toBe(hResults[i].in_degree);
      expect(core.results[i].out_degree).toBe(hResults[i].out_degree);
    }
  });

  it('label filter: core matches handler', async () => {
    const handler = await handlerSearch({ label: 'Route' });
    const core = coreSearch(undefined, { label: 'Route' });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    for (let i = 0; i < core.results.length; i++) {
      expect(core.results[i].kind).toBe('Route');
      expect(core.results[i].qualified_name).toBe(hResults[i].qualified_name);
    }
  });

  it('file_pattern filter: core matches handler', async () => {
    const handler = await handlerSearch({ file_pattern: 'src/mcp/**' });
    const core = coreSearch(undefined, { filePattern: 'src/mcp/**', limit: 50 });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    for (const r of core.results) {
      expect(r.file_path).toMatch(/^src\/mcp\//);
    }
  });

  it('name_pattern filter: core matches handler', async () => {
    // SQL LIKE pattern, not regex
    const handler = await handlerSearch({ name_pattern: 'handle%' });
    const core = coreSearch(undefined, { namePattern: 'handle%', limit: 50 });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    expect(core.results.length).toBeGreaterThan(0);
    for (const r of core.results) {
      expect(r.name).toMatch(/^handle/);
    }
  });

  it('name_like filter is forwarded to the local store instead of returning the whole graph', async () => {
    const handler = await handlerSearch({ name_like: 'handle%' });
    const core = coreSearch(undefined, { nameLike: 'handle%', limit: 50 });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    expect(core.results.length).toBeGreaterThan(0);
    for (const result of core.results) expect(result.name).toMatch(/^handle/i);
  });

  it('min_degree filter: core matches handler', async () => {
    const handler = await handlerSearch({ min_degree: 3 });
    const core = coreSearch(undefined, { minDegree: 3, limit: 50 });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    // search() and runPipeline() have 5 edges each
    expect(core.results.length).toBeGreaterThanOrEqual(2);
    for (const r of core.results) {
      expect(r.in_degree + r.out_degree).toBeGreaterThanOrEqual(3);
    }
  });

  it('exclude_entry_points: core total matches handler total', async () => {
    const handler = await handlerSearch({ exclude_entry_points: true, limit: 50 });
    const core = coreSearch(undefined, { excludeEntryPoints: true, limit: 50 });

    // Core returns all deduped results; handler slices to limit.
    // Compare totals (both from search internal counts).
    expect(core.total).toBe(handler.total);
    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBeGreaterThanOrEqual(hResults.length);
    for (const r of core.results) {
      expect(r.is_entry_point).toBe(false);
    }
  });

  it('combined filters: core matches handler', async () => {
    const handler = await handlerSearch({
      file_pattern: 'src/mcp/**',
      label: 'Function',
      query: 'handle',
      exclude_entry_points: true,
    });
    const core = coreSearch('handle', {
      filePattern: 'src/mcp/**',
      label: 'Function',
      excludeEntryPoints: true,
      limit: 50,
    });

    const hResults = handler.results as Array<Record<string, unknown>>;
    expect(core.results.length).toBe(hResults.length);
    for (const r of core.results) {
      expect(r.file_path).toMatch(/^src\/mcp\//);
      expect(r.kind).toBe('Function');
      expect(r.name.toLowerCase()).toContain('handle');
      expect(r.is_entry_point).toBe(false);
    }
  });

  // ── Order stability ──

  it('results have stable deterministic order', () => {
    const a = coreSearch('search', { limit: 50 });
    const b = coreSearch('search', { limit: 50 });

    expect(a.results.length).toBe(b.results.length);
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i].qualified_name).toBe(b.results[i].qualified_name);
    }
  });

  // ── Dedup ──

  it('deduplicates by qualified_name', () => {
    const result = coreSearch('search', { limit: 50 });
    const qnames = result.results.map(r => r.qualified_name);
    const unique = new Set(qnames);
    expect(unique.size).toBe(qnames.length);
  });

  // ── Limit/offset ──

  it('respects limit', () => {
    const r = coreSearch(undefined, { limit: 3 });
    expect(r.results.length).toBeLessThanOrEqual(3);
  });

  it('respects offset', () => {
    const all = coreSearch(undefined, { limit: 3, offset: 0 });
    const paged = coreSearch(undefined, { limit: 3, offset: 3 });
    // Second page should have different results
    if (paged.results.length > 0 && all.results.length > 0) {
      const allNames = new Set(all.results.map(r => r.qualified_name));
      const pagedNames = paged.results.map(r => r.qualified_name);
      for (const n of pagedNames) {
        expect(allNames.has(n)).toBe(false);
      }
    }
  });

  // ── Empty results ──

  it('returns empty results for nonsense query', () => {
    const r = coreSearch('xyznonexistent123');
    expect(r.results.length).toBe(0);
    expect(r.total).toBe(0);
  });

  // ── All nodes have provenance='local' ──

  it('all results have provenance=local in core output', () => {
    const r = coreSearch('search', { limit: 50 });
    for (const n of r.results) {
      expect(n.provenance).toBe('local');
      expect(n.provider_count).toBe(1);
    }
  });

  // ── Confidence: core has NO metrics/narrative fields ──

  it('core result is pure data — no narrative or metrics', () => {
    const r = coreSearch('search', { limit: 50 });
    // Core returns LocalSearchResult: { results, total }
    const keys = Object.keys(r);
    expect(keys).toContain('results');
    expect(keys).toContain('total');
    expect(keys).not.toContain('value_metrics');
    expect(keys).not.toContain('narrative');
    expect(keys).not.toContain('llm_usage');
    expect(keys).not.toContain('llm_reranked');
    expect(keys).not.toContain('diagnostic');
  });

  // ── Confidence: handler still returns all expected fields ──

  it('handler still returns narrative + metrics + llm_usage', async () => {
    const handler = await handlerSearch({ query: 'search' });
    expect(handler.narrative).toBeDefined();
    expect(handler.value_metrics).toBeDefined();
    expect(handler.llm_usage).toBeDefined();
    expect((handler.value_metrics as Record<string, unknown>).latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('handler returns diagnostic when project not indexed', async () => {
    const result = await handleSearchGraph({
      project: 'nonexistent-project-xyz',
      query: 'test',
      enable_llm: false,
    }) as Record<string, unknown>;
    // Should still return results (empty) but with diagnostic
    expect(result.diagnostic).toBeDefined();
  });
});
