/*
 * gateway.test.ts — Federated gateway tests.
 *
 * Coverage:
 *   - Local-only (no shared config)
 *   - Shared-only results
 *   - Mixed: local + shared with merge/dedup
 *   - Auth denied: no shared, no local_fallback
 *   - Timeout: shared times out → local_fallback=true
 *   - Error: shared throws → shared_error, local_fallback=true
 *   - Dedup determinism: stable order
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { LocalIndexProvider, InMemorySharedIndexProvider } from '../../../src/federation/providers.js';
import { NoopAuthorizer, DenyAllAuthorizer } from '../../../src/federation/auth.js';
import { federatedSearchGraph, federatedTracePath } from '../../../src/federation/gateway.js';
import type { FederatedGatewayConfig, SearchNode, TraceEntry, TraceEdge, TraceRoot } from '../../../src/federation/types.js';

const PROJECT = 'test-gateway';

function seedDb(db: LynxDatabase) {
  const nodes: Array<{
    id: number; kind: string; name: string; file_path: string;
  }> = [
    { id: 1, kind: 'Function', name: 'handleSearch', file_path: 'src/handler.ts' },
    { id: 2, kind: 'Function', name: 'getDb', file_path: 'src/store/db.ts' },
    { id: 3, kind: 'Function', name: 'render', file_path: 'src/ui/render.ts' },
    { id: 4, kind: 'Class', name: 'Pipeline', file_path: 'src/pipeline.ts' },
    { id: 5, kind: 'Function', name: 'helper', file_path: 'src/utils/helpers.ts' },
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
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 2, 5, \'CALLS\', \'{}\')'
  ).run(PROJECT);

  db.upsertProject(PROJECT, '/tmp/test-gateway');
}

function makeConfig(overrides: Partial<FederatedGatewayConfig> & {
  localProvider: FederatedGatewayConfig['localProvider'];
  sharedProvider: FederatedGatewayConfig['sharedProvider'];
  authorizer: FederatedGatewayConfig['authorizer'];
}): FederatedGatewayConfig {
  return {
    teamName: 'test-team',
    sharedTimeoutMs: 3000,
    ...overrides,
  };
}

const baseParams = {
  project: PROJECT,
  label: undefined as string | undefined,
  namePattern: undefined as string | undefined,
  qnPattern: undefined as string | undefined,
  filePattern: undefined as string | undefined,
  limit: 50,
  offset: 0,
  minDegree: undefined as number | undefined,
  maxDegree: undefined as number | undefined,
  excludeEntryPoints: false,
};

describe('FederatedGateway — search_graph', () => {
  let db: LynxDatabase;
  let local: LocalIndexProvider;
  let shared: InMemorySharedIndexProvider;
  let authorizer: NoopAuthorizer;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db);
    local = new LocalIndexProvider();
    shared = new InMemorySharedIndexProvider();
    authorizer = new NoopAuthorizer();
  });

  afterEach(() => {
    db.close();
  });

  // ── Local-only (shared returns empty) ──

  it('local-only: no shared fixtures → all results come from local', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedSearchGraph(db, { ...baseParams }, config);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(r => r.provenance === 'local')).toBe(true);
    expect(result.provenance_summary.local_count).toBe(result.results.length);
    expect(result.provenance_summary.shared_count).toBe(0);
    expect(result.provenance_summary.mixed_count).toBe(0);
    expect(result.provenance_summary.local_fallback).toBe(false);
    // sharedAvailable=true because shared responded (just with empty results)
    expect(result.provenance_summary.shared_available).toBe(true);
    expect(result.provenance_summary.shared_authorized).toBe(true);
  });

  // ── Shared-only ──

  it('shared-only: shared fixtures, local has none of those', async () => {
    const sn: SearchNode = {
      name: 'remoteFunc',
      qualified_name: 'remote.file.remoteFunc',
      file_path: 'remote/file.ts',
      start_line: 1,
      end_line: 5,
      kind: 'Function',
      in_degree: 0,
      out_degree: 0,
      is_entry_point: false,
      is_test: false,
      provenance: 'shared',
      provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);

    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedSearchGraph(db, { ...baseParams, query: 'nomatchxyz' }, config);

    // Local results should be empty (query doesn't match)
    const localOnly = result.results.filter(r => r.provenance === 'local');
    const sharedOnly = result.results.filter(r => r.provenance === 'shared');
    expect(sharedOnly.length).toBeGreaterThanOrEqual(1);
    expect(result.provenance_summary.shared_count).toBeGreaterThanOrEqual(1);
    expect(result.provenance_summary.shared_available).toBe(true);
  });

  // ── Mixed (local + shared overlap) ──

  it('mixed: same qualified_name in both → local wins, tagged mixed', async () => {
    // Add a shared fixture that overlaps with a local node
    const localFirst = local.searchGraph(db, { ...baseParams, query: 'handleSearch' });
    expect(localFirst.results.length).toBeGreaterThan(0);
    const overlappingQn = localFirst.results[0].qualified_name;

    const sn: SearchNode = {
      name: localFirst.results[0].name,
      qualified_name: overlappingQn,
      file_path: localFirst.results[0].file_path,
      start_line: 99,
      end_line: 110,
      kind: localFirst.results[0].kind,
      in_degree: 10,
      out_degree: 5,
      is_entry_point: false,
      is_test: false,
      provenance: 'shared',
      provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);

    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedSearchGraph(db, { ...baseParams, query: 'handleSearch' }, config);

    // Conflict node should be tagged mixed
    const conflictNode = result.results.find(r => r.qualified_name === overlappingQn);
    expect(conflictNode).toBeDefined();
    expect(conflictNode!.provenance).toBe('mixed');
    expect(conflictNode!.provider_count).toBe(2);
    // Local data wins — start_line should be the local value, not shared's 99
    expect(conflictNode!.start_line).toBe(localFirst.results[0].start_line);
    expect(result.provenance_summary.mixed_count).toBeGreaterThanOrEqual(1);
  });

  // ── Auth denied ──

  it('auth denied: no shared results, no local_fallback', async () => {
    const denyAuth = new DenyAllAuthorizer('test denial');
    const sn: SearchNode = {
      name: 'secretFunc', qualified_name: 'secret.secretFunc',
      file_path: 'secret.ts', start_line: 1, end_line: 5, kind: 'Function',
      in_degree: 0, out_degree: 0, is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    shared.setSearchResults(PROJECT, [sn]);

    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer: denyAuth });
    const result = await federatedSearchGraph(db, { ...baseParams }, config);

    // No shared results
    expect(result.results.every(r => r.provenance === 'local')).toBe(true);
    expect(result.provenance_summary.shared_authorized).toBe(false);
    expect(result.provenance_summary.shared_available).toBe(false);
    // local_fallback must be false when not authorized
    expect(result.provenance_summary.local_fallback).toBe(false);
  });

  // ── Timeout ──

  it('timeout: shared takes too long → local_fallback=true', async () => {
    const slowShared = new InMemorySharedIndexProvider({ delayMs: 5000 });
    const sn: SearchNode = {
      name: 'slowFunc', qualified_name: 'slow.slowFunc',
      file_path: 'slow.ts', start_line: 1, end_line: 5, kind: 'Function',
      in_degree: 0, out_degree: 0, is_entry_point: false, is_test: false,
      provenance: 'shared', provider_count: 1,
    };
    slowShared.setSearchResults(PROJECT, [sn]);

    const config = makeConfig({
      localProvider: local,
      sharedProvider: slowShared,
      authorizer,
      sharedTimeoutMs: 100,
    });
    const result = await federatedSearchGraph(db, { ...baseParams }, config);

    // All results from local
    expect(result.results.every(r => r.provenance === 'local')).toBe(true);
    expect(result.provenance_summary.local_fallback).toBe(true);
    expect(result.provenance_summary.shared_available).toBe(false);
    expect(result.provenance_summary.shared_error).toBeDefined();
  });

  // ── Error ──

  it('shared error: results from local, shared_error set, local_fallback=true', async () => {
    const brokenShared = new InMemorySharedIndexProvider();
    // Override to throw
    brokenShared.searchGraph = () => { throw new Error('simulated shared failure'); };

    const config = makeConfig({ localProvider: local, sharedProvider: brokenShared, authorizer });
    const result = await federatedSearchGraph(db, { ...baseParams }, config);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(r => r.provenance === 'local')).toBe(true);
    expect(result.provenance_summary.shared_error).toBeDefined();
    expect(result.provenance_summary.shared_error).toContain('simulated shared failure');
    expect(result.provenance_summary.local_fallback).toBe(true);
    expect(result.provenance_summary.shared_available).toBe(false);
  });

  // ── Stable order ──

  it('stable deterministic order across calls', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });

    const r1 = await federatedSearchGraph(db, { ...baseParams }, config);
    const r2 = await federatedSearchGraph(db, { ...baseParams }, config);

    expect(r1.results.length).toBe(r2.results.length);
    for (let i = 0; i < r1.results.length; i++) {
      expect(r1.results[i].qualified_name).toBe(r2.results[i].qualified_name);
      expect(r1.results[i].provenance).toBe(r2.results[i].provenance);
    }
  });

  // ── Dedup prevents duplicates ──

  it('no duplicate qualified_names in merged results', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedSearchGraph(db, { ...baseParams }, config);

    const qnames = result.results.map(r => r.qualified_name);
    const unique = new Set(qnames);
    expect(unique.size).toBe(qnames.length);
  });
});

describe('FederatedGateway — trace_path', () => {
  let db: LynxDatabase;
  let local: LocalIndexProvider;
  let shared: InMemorySharedIndexProvider;
  let authorizer: NoopAuthorizer;

  const traceParams = {
    functionName: 'handleSearch',
    project: PROJECT,
    direction: 'both' as const,
    depth: 3,
    mode: 'calls',
    riskLabels: false,
    includeTests: false,
    maxResults: 30,
    page: 0,
    pageSize: 12,
  };

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db);
    local = new LocalIndexProvider();
    shared = new InMemorySharedIndexProvider();
    authorizer = new NoopAuthorizer();
  });

  afterEach(() => {
    db.close();
  });

  it('local-only trace: shared has no matching fixture', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedTracePath(db, traceParams, config);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.callers.every(c => c.provenance === 'local')).toBe(true);
    expect(result.callees.every(c => c.provenance === 'local')).toBe(true);
    expect(result.provenance_summary.shared_available).toBe(true); // shared responded (empty)
  });

  it('mixed trace: shared has extra callers', async () => {
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

    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedTracePath(db, traceParams, config);

    expect(result).not.toBeNull();
    if (!result) return;

    // Remote caller should appear
    const remoteCaller = result.callers.find(c => c.qualified_name === 'remote.remoteCaller');
    expect(remoteCaller).toBeDefined();
    expect(remoteCaller!.provenance).toBe('shared');
  });

  it('returns shared edges only when both endpoints are visible', async () => {
    const sharedCaller: TraceEntry = {
      name: 'remoteCaller', qualified_name: 'remote.remoteCaller',
      file_path: 'remote/caller.ts', hop: 1, provenance: 'shared',
    };
    shared.setTraceResult(PROJECT, 'handleSearch', {
      root: { name: 'handleSearch', qualified_name: 'src.handler.handleSearch', file_path: 'src/handler.ts', kind: 'Function' },
      callers: [sharedCaller],
      callees: [],
      edges: [
        { fromName: 'src.handler.handleSearch', toName: 'remote.remoteCaller', type: 'CALLS' },
        { fromName: 'secret.internal', toName: 'secret.database', type: 'CALLS' },
      ],
    });

    const result = await federatedTracePath(db, traceParams, makeConfig({ localProvider: local, sharedProvider: shared, authorizer }));
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.edges).toContainEqual({ fromName: 'src.handler.handleSearch', toName: 'remote.remoteCaller', type: 'CALLS' });
    expect(result.edges.some(edge => edge.fromName === 'secret.internal' || edge.toName === 'secret.database')).toBe(false);
  });

  it('auth denied trace: no shared results, no local_fallback', async () => {
    const denyAuth = new DenyAllAuthorizer('test');
    shared.setTraceResult(PROJECT, 'handleSearch', {
      root: { name: 'handleSearch', qualified_name: 'src.handler.handleSearch', file_path: 'src/handler.ts', kind: 'Function' },
      callers: [{ name: 'blocked', qualified_name: 'blocked.func', file_path: 'blocked.ts', hop: 1, provenance: 'shared' }],
      callees: [],
    });

    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer: denyAuth });
    const result = await federatedTracePath(db, traceParams, config);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.provenance_summary.shared_authorized).toBe(false);
    expect(result.provenance_summary.shared_available).toBe(false);
    expect(result.provenance_summary.local_fallback).toBe(false);
    // No shared caller should appear
    const blockedCaller = result.callers.find(c => c.qualified_name === 'blocked.func');
    expect(blockedCaller).toBeUndefined();
  });

  it('null when local returns null (project not found)', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });
    const result = await federatedTracePath(db, {
      ...traceParams,
      project: 'nonexistent',
    }, config);

    expect(result).toBeNull();
  });

  it('stable order across calls', async () => {
    const config = makeConfig({ localProvider: local, sharedProvider: shared, authorizer });

    const r1 = await federatedTracePath(db, traceParams, config);
    const r2 = await federatedTracePath(db, traceParams, config);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    if (!r1 || !r2) return;

    for (let i = 0; i < r1.callers.length; i++) {
      expect(r1.callers[i].qualified_name).toBe(r2.callers[i].qualified_name);
    }
    for (let i = 0; i < r1.callees.length; i++) {
      expect(r1.callees[i].qualified_name).toBe(r2.callees[i].qualified_name);
    }
  });
});
