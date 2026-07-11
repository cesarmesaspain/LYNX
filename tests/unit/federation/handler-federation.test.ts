/*
 * handler-federation.test.ts — Handler-level integration tests.
 *
 * Proves that federated config actually reaches the handler response.
 * Tests the FULL path: handler → gateway → providers → merge → response.
 *
 * Without config: handler output is identical to pre-federation baseline.
 * With config: provenance_summary present, results tagged with provenance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { LocalIndexProvider, InMemorySharedIndexProvider } from '../../../src/federation/providers.js';
import { NoopAuthorizer, DenyAllAuthorizer } from '../../../src/federation/auth.js';
import { setFederatedConfig, clearFederatedConfig } from '../../../src/federation/handler-bridge.js';
import type { FederatedGatewayConfig, SearchNode, TraceEntry, TraceRoot } from '../../../src/federation/types.js';
import { handleSearchGraph } from '../../../src/mcp/handlers/search_graph.js';
import { handleTracePath } from '../../../src/mcp/handlers/trace_path.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'test-handler-fed';

function seedDb(db: LynxDatabase) {
  const nodes: Array<{
    id: number; kind: string; name: string; file_path: string;
  }> = [
    { id: 1, kind: 'Function', name: 'handleSearch', file_path: 'src/handler.ts' },
    { id: 2, kind: 'Function', name: 'getDb', file_path: 'src/store/db.ts' },
    { id: 3, kind: 'Function', name: 'render', file_path: 'src/ui/render.ts' },
    { id: 4, kind: 'Class', name: 'Pipeline', file_path: 'src/pipeline.ts' },
  ];

  for (const n of nodes) {
    const qn = `${n.file_path.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${n.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, ?, ?, ?, ?, 1, 10, 1, 0, 0, '{}')`
    ).run(n.id, PROJECT, n.kind, n.name, qn, n.file_path);
  }

  // Edges for trace
  db.db.prepare(
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 1, 2, \'CALLS\', \'{}\')'
  ).run(PROJECT);
  db.db.prepare(
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 1, 3, \'CALLS\', \'{}\')'
  ).run(PROJECT);
  db.db.prepare(
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 2, 4, \'CALLS\', \'{}\')'
  ).run(PROJECT);

  // Also insert edges for degree calculation
  for (let e = 0; e < 3; e++) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 1, 2, \'CALLS\', \'{}\')'
    ).run(PROJECT);
  }

  db.upsertProject(PROJECT, '/tmp/test-handler-fed');
}

function makeConfig(local: LocalIndexProvider, shared: InMemorySharedIndexProvider, authorizer: FederatedGatewayConfig['authorizer'] = new NoopAuthorizer()): FederatedGatewayConfig {
  return {
    teamName: 'test-team',
    localProvider: local,
    sharedProvider: shared,
    authorizer,
    sharedTimeoutMs: 3000,
  };
}

describe('handler → gateway integration — search_graph', () => {
  let db: LynxDatabase;
  let local: LocalIndexProvider;
  let shared: InMemorySharedIndexProvider;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db);
    setDb(PROJECT, db);
    local = new LocalIndexProvider();
    shared = new InMemorySharedIndexProvider();
  });

  afterEach(() => {
    clearFederatedConfig();
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  // ── No config: identical to baseline ──

  it('without config: handler output matches pre-federation baseline', async () => {
    const result = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    expect(result.results).toBeDefined();
    expect(result.total).toBeGreaterThan(0);
    expect(result.narrative).toBeDefined();
    expect(result.value_metrics).toBeDefined();
    // No provenance_summary when no config
    expect(result.provenance_summary).toBeUndefined();
  });

  // ── With config: shared results appear ──

  it('with config: handler returns provenance_summary and shared results', async () => {
    const sn: SearchNode = {
      name: 'remoteFunc', qualified_name: 'remote.file.remoteFunc',
      file_path: 'remote/file.ts', start_line: 1, end_line: 5,
      kind: 'Function', in_degree: 0, out_degree: 0,
      is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);
    setFederatedConfig(makeConfig(local, shared));

    const result = await handleSearchGraph({
      project: PROJECT, query: 'nomatchxyz', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    expect(result.provenance_summary).toBeDefined();
    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.shared_authorized).toBe(true);
    expect(ps.shared_available).toBe(true);

    // Check that shared result appears
    const results = result.results as Array<Record<string, unknown>>;
    const remoteResult = results.find(r => r.qualified_name === 'remote.file.remoteFunc');
    expect(remoteResult).toBeDefined();
  });

  // ── Mixed provenance ──

  it('mixed: overlapping qualified_name tagged as mixed', async () => {
    // Get a local result to create overlap
    const baseline = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;
    const baselineResults = baseline.results as Array<Record<string, unknown>>;
    expect(baselineResults.length).toBeGreaterThan(0);

    // Create shared fixture with same qualified_name
    const overlapping = baselineResults[0];
    const sn: SearchNode = {
      name: overlapping.name as string,
      qualified_name: overlapping.qualified_name as string,
      file_path: overlapping.file as string,
      start_line: 99,
      end_line: 110,
      kind: overlapping.kind as string,
      in_degree: (overlapping.in_degree as number) + 100,
      out_degree: (overlapping.out_degree as number) + 100,
      is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);
    setFederatedConfig(makeConfig(local, shared));

    const result = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    // Mixed count should be >= 1
    expect(Number(ps.mixed_count)).toBeGreaterThanOrEqual(1);
    // local_fallback should be false — shared was available
    expect(ps.local_fallback).toBe(false);
  });

  // ── Auth denied ──

  it('auth denied: no shared results, local_fallback=false', async () => {
    const sn: SearchNode = {
      name: 'secretFunc', qualified_name: 'secret.secretFunc',
      file_path: 'secret.ts', start_line: 1, end_line: 5,
      kind: 'Function', in_degree: 0, out_degree: 0,
      is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);
    setFederatedConfig(makeConfig(local, shared, new DenyAllAuthorizer('test')));

    const result = await handleSearchGraph({
      project: PROJECT, query: 'nomatchxyz', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.shared_authorized).toBe(false);
    expect(ps.shared_available).toBe(false);
    expect(ps.local_fallback).toBe(false);
    expect(ps.shared_count).toBe(0);
  });

  // ── Timeout ──

  it('timeout: handler returns local_fallback=true', async () => {
    const slowShared = new InMemorySharedIndexProvider({ delayMs: 5000 });
    const sn: SearchNode = {
      name: 'slowFunc', qualified_name: 'slow.slowFunc',
      file_path: 'slow.ts', start_line: 1, end_line: 5,
      kind: 'Function', in_degree: 0, out_degree: 0,
      is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    slowShared.setSearchResults(PROJECT, [sn]);
    setFederatedConfig({
      teamName: 'test',
      localProvider: local,
      sharedProvider: slowShared,
      authorizer: new NoopAuthorizer(),
      sharedTimeoutMs: 100,
    });

    const result = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.local_fallback).toBe(true);
    expect(ps.shared_available).toBe(false);
    expect(ps.shared_error).toBeDefined();
  });

  // ── Error ──

  it('shared error: handler returns shared_error, local_fallback=true', async () => {
    const brokenShared = new InMemorySharedIndexProvider();
    brokenShared.searchGraph = () => { throw new Error('Boom!'); };
    setFederatedConfig(makeConfig(local, brokenShared));

    const result = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 50,
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.local_fallback).toBe(true);
    expect(ps.shared_available).toBe(false);
    expect(ps.shared_error).toContain('Boom!');

    // Local results still present
    const results = result.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
  });

  // ── Default limit still applied ──

  it('handler respects limit even with gateway', async () => {
    setFederatedConfig(makeConfig(local, shared));

    const result = await handleSearchGraph({
      project: PROJECT, query: 'handle', enable_llm: false, limit: 2,
    }) as Record<string, unknown>;

    const results = result.results as Array<Record<string, unknown>>;
    expect(results.length).toBeLessThanOrEqual(2);
    expect(result.provenance_summary).toBeDefined();
  });
});

describe('handler → gateway integration — trace_path', () => {
  let db: LynxDatabase;
  let local: LocalIndexProvider;
  let shared: InMemorySharedIndexProvider;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db);
    setDb(PROJECT, db);
    local = new LocalIndexProvider();
    shared = new InMemorySharedIndexProvider();
  });

  afterEach(() => {
    clearFederatedConfig();
    unsetDb(PROJECT, { close: false });
    db.close();
  });

  // ── No config: identical to baseline ──

  it('without config: trace handler output matches baseline', async () => {
    const result = await handleTracePath({
      project: PROJECT, function_name: 'handleSearch',
    }) as Record<string, unknown>;

    expect(result.function).toBeDefined();
    expect(result.callers).toBeDefined();
    expect(result.callees).toBeDefined();
    expect(result.path_summary).toBeDefined();
    expect(result.value_metrics).toBeDefined();
    expect(result.provenance_summary).toBeUndefined();
  });

  // ── With config: shared callers appear ──

  it('with config: trace returns shared callers and provenance_summary', async () => {
    const sharedCaller: TraceEntry = {
      name: 'remoteCaller',
      qualified_name: 'remote.remoteCaller',
      file_path: 'remote/caller.ts',
      hop: 1,
      provenance: 'shared',
    };
    shared.setTraceResult(PROJECT, 'handleSearch', {
      root: { name: 'handleSearch', qualified_name: 'src.handler.handleSearch', file_path: 'src/handler.ts', kind: 'Function' },
      callers: [sharedCaller],
      callees: [],
    });
    setFederatedConfig(makeConfig(local, shared));

    const result = await handleTracePath({
      project: PROJECT, function_name: 'handleSearch',
    }) as Record<string, unknown>;

    expect(result.provenance_summary).toBeDefined();
    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.shared_authorized).toBe(true);
    expect(ps.shared_available).toBe(true);

    // Remote caller should appear
    const callers = result.callers as Array<Record<string, unknown>>;
    const remote = callers.find(c => c.qualified_name === 'remote.remoteCaller');
    expect(remote).toBeDefined();
  });

  // ── Auth denied ──

  it('trace auth denied: no shared callers', async () => {
    shared.setTraceResult(PROJECT, 'handleSearch', {
      root: { name: 'handleSearch', qualified_name: 'src.handler.handleSearch', file_path: 'src/handler.ts', kind: 'Function' },
      callers: [{ name: 'blocked', qualified_name: 'blocked.func', file_path: 'blocked.ts', hop: 1, provenance: 'shared' }],
      callees: [],
    });
    setFederatedConfig(makeConfig(local, shared, new DenyAllAuthorizer('test')));

    const result = await handleTracePath({
      project: PROJECT, function_name: 'handleSearch',
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.shared_authorized).toBe(false);
    expect(ps.local_fallback).toBe(false);

    const callers = result.callers as Array<Record<string, unknown>>;
    const blocked = callers.find(c => c.qualified_name === 'blocked.func');
    expect(blocked).toBeUndefined();
  });

  // ── Error ──

  it('trace shared error: local_fallback=true', async () => {
    const brokenShared = new InMemorySharedIndexProvider();
    brokenShared.tracePath = () => { throw new Error('Trace boom!'); };
    setFederatedConfig(makeConfig(local, brokenShared));

    const result = await handleTracePath({
      project: PROJECT, function_name: 'handleSearch',
    }) as Record<string, unknown>;

    const ps = result.provenance_summary as Record<string, unknown>;
    expect(ps.local_fallback).toBe(true);
    expect(ps.shared_error).toContain('Trace boom!');

    // Local results still present
    expect(result.function).toBeDefined();
  });
});
