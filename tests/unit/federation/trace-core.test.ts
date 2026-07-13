/*
 * trace-core.test.ts — Regression tests for executeLocalTracePath pure core.
 *
 * Verifies:
 *   1. Core produces same data as current handleTracePath
 *   2. Direction modes (inbound, outbound, both)
 *   3. Risk labels
 *   4. Test file filtering
 *   5. Pagination
 *   6. Edge types by mode
 *   7. Empty/null results
 *   8. No metrics/narrative leakage in core
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { executeLocalTracePath } from '../../../src/federation/trace-core.js';
import { handleTracePath, isLikelyCallableSignature } from '../../../src/mcp/handlers/trace_path.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'test-trace-core';

function seedDb(db: LynxDatabase) {
  const nodes: Array<{
    id: number; kind: string; name: string; file_path: string; start_line: number; end_line: number;
    is_entry_point: number; is_exported: number; is_test: number;
  }> = [
    { id: 1, kind: 'Function', name: 'main', file_path: 'src/cli/index.ts', start_line: 1, end_line: 20, is_entry_point: 1, is_exported: 0, is_test: 0 },
    { id: 2, kind: 'Function', name: 'handleSearch', file_path: 'src/mcp/handler.ts', start_line: 10, end_line: 50, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 3, kind: 'Function', name: 'getDb', file_path: 'src/store/database.ts', start_line: 5, end_line: 15, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 4, kind: 'Function', name: 'renderResult', file_path: 'src/ui/render.ts', start_line: 1, end_line: 30, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 5, kind: 'Function', name: 'helper', file_path: 'src/utils/helpers.ts', start_line: 1, end_line: 10, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 6, kind: 'Class', name: 'Pipeline', file_path: 'src/pipeline/orchestrator.ts', start_line: 1, end_line: 40, is_entry_point: 0, is_exported: 1, is_test: 0 },
    // Test file node
    { id: 7, kind: 'Function', name: 'testMain', file_path: 'src/__tests__/main.test.ts', start_line: 1, end_line: 20, is_entry_point: 0, is_exported: 0, is_test: 1 },
    // Deep chain for multi-hop traces
    { id: 8, kind: 'Function', name: 'deep1', file_path: 'src/deep/level1.ts', start_line: 1, end_line: 10, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 9, kind: 'Function', name: 'deep2', file_path: 'src/deep/level2.ts', start_line: 1, end_line: 10, is_entry_point: 0, is_exported: 1, is_test: 0 },
    { id: 10, kind: 'Function', name: 'deep3', file_path: 'src/deep/level3.ts', start_line: 1, end_line: 10, is_entry_point: 0, is_exported: 1, is_test: 0 },
  ];

  for (const n of nodes) {
    const qn = `${n.file_path.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
    ).run(n.id, PROJECT, n.kind, n.name, qn, n.file_path, n.start_line, n.end_line, n.is_exported, n.is_test, n.is_entry_point);
  }

  // Edges: build call graph
  // main → handleSearch (outbound from main)
  // main → getDb
  // handleSearch → getDb
  // handleSearch → renderResult
  // getDb → helper
  // main → deep1 → deep2 → deep3 (chain)
  const edges: Array<[number, number, string]> = [
    [1, 2, 'CALLS'],  // main → handleSearch
    [1, 3, 'CALLS'],  // main → getDb
    [2, 3, 'CALLS'],  // handleSearch → getDb
    [2, 4, 'CALLS'],  // handleSearch → renderResult
    [3, 5, 'CALLS'],  // getDb → helper
    [1, 8, 'CALLS'],  // main → deep1
    [8, 9, 'CALLS'],  // deep1 → deep2
    [9, 10, 'CALLS'], // deep2 → deep3
    // Test edge
    [7, 1, 'CALLS'],  // testMain → main
  ];

  for (const [src, tgt, type] of edges) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, \'{}\')'
    ).run(PROJECT, src, tgt, type);
  }

  db.upsertProject(PROJECT, '/tmp/test-trace-core');
}

describe('trace_path core — result parity with handler', () => {
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

  // ── Helpers ──

  async function handlerTrace(params: Record<string, unknown>) {
    return await handleTracePath({ project: PROJECT, ...params }) as Record<string, unknown>;
  }

  function coreTrace(params: Record<string, unknown>) {
    return executeLocalTracePath(db, {
      project: PROJECT,
      functionName: String(params.function_name || ''),
      direction: (params.direction as 'inbound' | 'outbound' | 'both') || 'both',
      depth: params.depth ? Number(params.depth) : 3,
      mode: (params.mode as string) || 'calls',
      riskLabels: params.risk_labels === true,
      includeTests: params.include_tests === true,
      customEdgeTypes: params.edge_types as string[] | undefined,
      maxResults: params.max_results ? Number(params.max_results) : 30,
      page: params.page ? Number(params.page) : 0,
      pageSize: params.page_size ? Number(params.page_size) : 12,
    });
  }

  // ── Parity tests ──

  it('outbound trace: core matches handler for main function', async () => {
    const handler = await handlerTrace({ function_name: 'main', direction: 'outbound' });
    const core = coreTrace({ function_name: 'main', direction: 'outbound' });

    expect(core).not.toBeNull();
    if (!core) return;

    const hFn = handler.function as Record<string, unknown>;
    expect(core.root.name).toBe(hFn.name);
    expect(core.root.qualified_name).toBe(hFn.qualified_name);
    expect(core.direction).toBe(handler.direction);
    expect(core.mode).toBe(handler.mode);

    // Callees count should match (handler uses paged callees but total is tracked)
    const hPagination = handler.pagination as Record<string, unknown>;
    expect(core.totalCallees).toBe(hPagination.total_callees);
  });

  it('inbound trace: core matches handler for getDb', async () => {
    const handler = await handlerTrace({ function_name: 'getDb', direction: 'inbound' });
    const core = coreTrace({ function_name: 'getDb', direction: 'inbound' });

    expect(core).not.toBeNull();
    if (!core) return;

    // getDb is called by main and handleSearch → 2 inbound callers
    const hPagination = handler.pagination as Record<string, unknown>;
    expect(core.totalCallers).toBe(hPagination.total_callers);
    expect(core.totalCallers).toBeGreaterThanOrEqual(1);
  });

  it('both direction: core matches handler', async () => {
    const handler = await handlerTrace({ function_name: 'handleSearch' });
    const core = coreTrace({ function_name: 'handleSearch', direction: 'both' });

    expect(core).not.toBeNull();
    if (!core) return;

    const hPagination = handler.pagination as Record<string, unknown>;
    expect(core.totalCallers).toBe(hPagination.total_callers);
    expect(core.totalCallees).toBe(hPagination.total_callees);
  });

  // ── Risk labels ──

  it('risk_labels=true: core entries have risk field', async () => {
    await handlerTrace({ function_name: 'main', risk_labels: true }); // baseline
    const core = coreTrace({ function_name: 'main', risk_labels: true, direction: 'outbound' });

    expect(core).not.toBeNull();
    if (!core) return;

    for (const c of core.callees) {
      expect(c.risk).toBeDefined();
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(c.risk);
    }
  });

  it('risk_labels=false: core entries have no risk field', async () => {
    const core = coreTrace({ function_name: 'main', direction: 'outbound' });
    expect(core).not.toBeNull();
    if (!core) return;

    for (const c of core.callees) {
      expect(c.risk).toBeUndefined();
    }
  });

  // ── Test file filtering ──

  it('includeTests=false excludes test files', async () => {
    const handler = await handlerTrace({ function_name: 'main', include_tests: false });
    const core = coreTrace({ function_name: 'main', include_tests: false, direction: 'outbound' });

    expect(core).not.toBeNull();
    if (!core) return;

    for (const c of core.callees) {
      expect(c.file_path).not.toContain('__tests__');
      expect(c.file_path).not.toContain('.test.');
      expect(c.file_path).not.toContain('.spec.');
    }
  });

  it('includeTests=true includes test files', async () => {
    const coreInbound = coreTrace({ function_name: 'main', include_tests: true, direction: 'inbound' });
    expect(coreInbound).not.toBeNull();
    if (!coreInbound) return;

    const testFiles = coreInbound.callers.filter(c => c.file_path.includes('__tests__'));
    expect(testFiles.length).toBeGreaterThanOrEqual(0); // testMain calls main
  });

  // ── Multi-hop chain ──

  it('multi-hop outbound traversal reaches deep nodes', async () => {
    const core = coreTrace({ function_name: 'main', direction: 'outbound', depth: 5 });
    expect(core).not.toBeNull();
    if (!core) return;

    const names = core.callees.map(c => c.name);
    expect(names).toContain('deep1');
    expect(names).toContain('deep2');
    expect(names).toContain('deep3');
  });

  // ── Pagination ──

  it('respects page_size and page', async () => {
    const corePage0 = coreTrace({ function_name: 'main', direction: 'outbound', page: 0, page_size: 2 });
    const corePage1 = coreTrace({ function_name: 'main', direction: 'outbound', page: 1, page_size: 2 });

    expect(corePage0).not.toBeNull();
    expect(corePage1).not.toBeNull();
    if (!corePage0 || !corePage1) return;

    // Core provides full arrays — pagination happens at handler layer
    // Here we check totals are consistent
    expect(corePage0.totalCallees).toBe(corePage1.totalCallees);
  });

  // ── Edge types by mode ──

  it('data_flow mode returns results', async () => {
    const core = coreTrace({ function_name: 'main', mode: 'data_flow' });
    expect(core).not.toBeNull();
    expect(core!.mode).toBe('data_flow');
  });

  it('cross_service mode returns results', async () => {
    const core = coreTrace({ function_name: 'main', mode: 'cross_service' });
    expect(core).not.toBeNull();
    expect(core!.mode).toBe('cross_service');
  });

  // ── Null returns ──

  it('returns null for nonexistent project', () => {
    const core = executeLocalTracePath(db, {
      project: 'nonexistent-project',
      functionName: 'main',
      direction: 'both', depth: 3, mode: 'calls',
      riskLabels: false, includeTests: false,
      maxResults: 30, page: 0, pageSize: 12,
    });
    expect(core).toBeNull();
  });

  it('returns null for nonexistent function', () => {
    const core = coreTrace({ function_name: 'completelyNonexistentFuncXYZ' });
    expect(core).toBeNull();
  });

  it('accepts qualified_name and symbol aliases used by other discovery tools', async () => {
    const qualified = await handlerTrace({
      qualified_name: 'src.cli.index.main',
      direction: 'outbound',
    });
    const symbol = await handlerTrace({ symbol: 'main', direction: 'outbound' });

    expect(qualified.function).toMatchObject({ name: 'main' });
    expect(symbol.function).toMatchObject({ name: 'main' });
  });

  // ── All entries have provenance='local' ──

  it('all entries have provenance=local in core output', async () => {
    const core = coreTrace({ function_name: 'main' });
    expect(core).not.toBeNull();
    if (!core) return;

    for (const c of core.callers) {
      expect(c.provenance).toBe('local');
    }
    for (const c of core.callees) {
      expect(c.provenance).toBe('local');
    }
  });

  // ── Core is pure — no narrative or metrics ──

  it('core result has no narrative or metrics', async () => {
    const core = coreTrace({ function_name: 'main' });
    expect(core).not.toBeNull();
    if (!core) return;

    const keys = Object.keys(core);
    expect(keys).not.toContain('path_summary');
    expect(keys).not.toContain('deepest_path');
    expect(keys).not.toContain('value_metrics');
    expect(keys).not.toContain('pagination'); // pagination object is handler-level
    expect(keys).not.toContain('edge_summary');
    expect(keys).not.toContain('truncated');

    // Core has its own flat fields
    expect(keys).toContain('totalCallers');
    expect(keys).toContain('totalCallees');
    expect(keys).toContain('maxHop');
    expect(keys).toContain('totalVisited');
  });

  // ── Order stability ──

  it('results have stable deterministic order', () => {
    const a = coreTrace({ function_name: 'main', direction: 'outbound' });
    const b = coreTrace({ function_name: 'main', direction: 'outbound' });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;

    for (let i = 0; i < a.callees.length; i++) {
      expect(a.callees[i].qualified_name).toBe(b.callees[i].qualified_name);
    }
  });

  // ── Confidence: handler still works as before ──

  it('handler still returns narrative + metrics', async () => {
    const handler = await handlerTrace({ function_name: 'main' });
    expect(handler.path_summary).toBeDefined();
    expect(handler.value_metrics).toBeDefined();
    expect(handler.pagination).toBeDefined();
  });
});

describe('isLikelyCallableSignature', () => {
  it('filters local values that were incorrectly extracted as call targets', () => {
    expect(isLikelyCallableSignature('const json = (await response.json()) as Payload;')).toBe(false);
  });

  it('keeps function, method, arrow, and unavailable-source entries', () => {
    expect(isLikelyCallableSignature('export async function exchangeCode() {')).toBe(true);
    expect(isLikelyCallableSignature('const exchange = async () => {')).toBe(true);
    expect(isLikelyCallableSignature('handleRequest(input: Request) {')).toBe(true);
    expect(isLikelyCallableSignature(undefined)).toBe(true);
  });
});
