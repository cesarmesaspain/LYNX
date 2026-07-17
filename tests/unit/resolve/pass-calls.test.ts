/*
 * pass-calls.test.ts — Unit tests for passCalls.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passCalls } from '../../../src/pipeline/phases/resolve/pass-calls.js';
import { resolveCallee } from '../../../src/pipeline/phases/resolve/utils.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import type { ResolverState } from '../../../src/pipeline/phases/resolve/indexes.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeCallResult(calleeName: string, enclosingFuncQn: string, args: string[] = []): ExtractionResult {
  return {
    ...makeEmptyResult(),
    calls: [{ calleeName, enclosingFuncQn, args, startLine: 3, loopDepth: 0 }],
  };
}

function makeResolverState(): ResolverState {
  return { totalCalls: 0, unresolvedCalls: 0, unresolvedCallReasons: {}, fileCoverage: new Map() };
}

describe('passCalls', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates CALLS edge between two functions in same file', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'main', 'src/app.ts');
    const callee = makeFuncNode(3, 'helper', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, callee]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeCallResult('helper', 'app.main', ['arg1']));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    const callEdges = getEdgesByType(edges, 'CALLS');
    expect(callEdges.length).toBe(1);
    expect(callEdges[0].sourceId).toBe(2);
    expect(callEdges[0].targetId).toBe(3);
    expect(callEdges[0].properties.callee).toBe('helper');
    expect(state.totalCalls).toBe(1);
    expect(state.unresolvedCalls).toBe(0);
  });

  it('creates HTTP_CALLS edge for fetch/axios calls with URL', () => {
    const fileNode = makeFileNode(1, 'src/api.ts');
    const caller = makeFuncNode(2, 'fetchData', 'src/api.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);

    const batch = makeBatch('src/api.ts', '/fake/src/api.ts',
      makeCallResult('axios.get', 'api.fetchData', ["'/api/users'"]));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    const httpEdges = getEdgesByType(edges, 'HTTP_CALLS');
    expect(httpEdges.length).toBe(1);
    expect(httpEdges[0].sourceId).toBe(2);
    expect(httpEdges[0].properties.method).toBe('GET');
    expect(httpEdges[0].properties.url_path).toBe('/api/users');
    expect(httpEdges[0].properties.resolution).toBe('http-pattern');
    const route = db.db.prepare(
      "SELECT is_entry_point, properties FROM nodes WHERE kind = 'Route'",
    ).get() as { is_entry_point: number; properties: string };
    expect(route.is_entry_point).toBe(0);
    expect(JSON.parse(route.properties).external).toBe(true);
  });

  it('increments unresolvedCalls when caller not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts',
      makeCallResult('foo', 'ghost.main'));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    expect(edges.length).toBe(0);
    expect(state.totalCalls).toBe(1);
    expect(state.unresolvedCalls).toBe(1);
    expect(state.unresolvedCallReasons).toEqual({ caller_not_found: 1 });
  });

  it('increments unresolvedCalls when callee not resolved', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'main', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeCallResult('unknownFunction', 'app.main'));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    expect(state.totalCalls).toBe(1);
    expect(state.unresolvedCalls).toBe(1);
    expect(state.unresolvedCallReasons).toEqual({ target_absent: 1 });
  });

  it('separates unresolved external imports from missing internal imports', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'main', 'src/app.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);
    const external = makeCallResult('client.send', 'app.main');
    external.imports = [{ localName: 'client', modulePath: 'remote-sdk', startLine: 1 }];
    const internal = makeCallResult('missingHelper', 'app.main');
    internal.imports = [{ localName: 'missingHelper', modulePath: './helpers', startLine: 1 }];
    const state = makeResolverState();

    passCalls(db, [
      makeBatch('src/app.ts', '/fake/src/app.ts', external),
      makeBatch('src/app.ts', '/fake/src/app.ts', internal),
    ], idx, [], state);

    expect(state.totalCalls).toBe(2);
    expect(state.unresolvedCallReasons).toEqual({
      external_dependency_target: 1,
      imported_internal_target_missing: 1,
    });
  });

  it('skips HTTP_CALLS for non-HTTP client without URL', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'main', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);

    // Regular function named 'get' with no URL — should not create HTTP_CALLS
    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeCallResult('db.get', 'app.main'));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    const httpEdges = getEdgesByType(edges, 'HTTP_CALLS');
    expect(httpEdges.length).toBe(0);
    expect(state.unresolvedCallReasons).toEqual({ receiver_target_unknown: 1 });
  });

  it('resolves callee to imported symbol when name collides across files', () => {
    // Regression: two functions named "helper" — one in a.ts (imported),
    // one in b.ts (not imported). The caller in caller.ts imports from a.ts.
    const fileA = makeFileNode(1, 'src/a.ts');
    const fileB = makeFileNode(2, 'src/b.ts');
    const fileCaller = makeFileNode(3, 'src/caller.ts');
    const importedHelper = makeFuncNode(4, 'helper', 'src/a.ts');
    const unrelatedHelper = makeFuncNode(5, 'helper', 'src/b.ts');
    const caller = makeFuncNode(6, 'main', 'src/caller.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileA, fileB, fileCaller, importedHelper, unrelatedHelper, caller]);

    // caller.ts imports helper from a.ts — NOT from b.ts
    idx.importedQnByFile.set('src/caller.ts', new Set([importedHelper.qualified_name]));

    const result = resolveCallee(idx, 'src/caller.ts', 'helper');
    expect(result).toBeDefined();
    expect(result!.node.id).toBe(importedHelper.id);
    expect(result!.node.file_path).toBe('src/a.ts');
    expect(result!.reason).toBe('imported-name');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('prefers a unique C implementation over its imported header prototype', () => {
    const callerFile = makeFileNode(1, 'tests/test_store.c');
    const headerFile = makeFileNode(2, 'src/store/store.h');
    const sourceFile = makeFileNode(3, 'src/store/store.c');
    const prototype = makeFuncNode(4, 'store_open', 'src/store/store.h');
    const implementation = makeFuncNode(5, 'store_open', 'src/store/store.c');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [callerFile, headerFile, sourceFile, prototype, implementation]);
    idx.importedQnByFile.set('tests/test_store.c', new Set([
      prototype.qualified_name,
      implementation.qualified_name,
    ]));

    const result = resolveCallee(idx, 'tests/test_store.c', 'store_open');
    expect(result?.node.id).toBe(implementation.id);
    expect(result?.reason).toBe('imported-implementation');
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to unique-name when no import info available', () => {
    // Without import context, a globally unique name should still resolve.
    const fileNode = makeFileNode(1, 'src/lib.ts');
    const onlyMatch = makeFuncNode(2, 'uniqueHelper', 'src/lib.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, onlyMatch]);

    const result = resolveCallee(idx, 'src/app.ts', 'uniqueHelper');
    expect(result).toBeDefined();
    expect(result!.node.id).toBe(onlyMatch.id);
    expect(result!.reason).toBe('unique-name');
  });

  it('does not resolve receiver-qualified calls by global method name alone', () => {
    const fileNode = makeFileNode(1, 'src/cache.ts');
    const globalGet = { ...makeFuncNode(2, 'get', 'src/cache.ts'), kind: 'Method', is_exported: 1 };

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, globalGet]);

    expect(resolveCallee(idx, 'src/database.ts', 'database.get')).toBeUndefined();
    expect(resolveCallee(idx, 'src/registry.ts', 'commands.get')).toBeUndefined();
  });

  it('does not resolve an extracted bare method name globally without receiver evidence', () => {
    const fileNode = makeFileNode(1, 'src/cache.ts');
    const globalGet = { ...makeFuncNode(2, 'get', 'src/cache.ts'), kind: 'Method', is_exported: 1 };
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, globalGet]);

    expect(resolveCallee(idx, 'src/database.ts', 'get')).toBeUndefined();
  });

  it('resolves callee through passCalls using imported name', () => {
    // Full pipeline: caller imports helper from a.ts, not b.ts.
    // passCalls → resolveCallee should pick a.ts.helper.
    const fileA = makeFileNode(1, 'src/a.ts');
    const fileB = makeFileNode(2, 'src/b.ts');
    const fileCaller = makeFileNode(3, 'src/caller.ts');
    const importedHelper = makeFuncNode(4, 'helper', 'src/a.ts');
    const unrelatedHelper = makeFuncNode(5, 'helper', 'src/b.ts');
    const callerFunc = makeFuncNode(6, 'main', 'src/caller.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileA, fileB, fileCaller, importedHelper, unrelatedHelper, callerFunc]);

    // Simulate passImports having run: caller.ts imports helper from a.ts
    idx.importedQnByFile.set('src/caller.ts', new Set([importedHelper.qualified_name]));

    const batch = makeBatch('src/caller.ts', '/fake/src/caller.ts',
      makeCallResult('helper', 'caller.main', []));
    const edges: LynxEdge[] = [];
    const state = makeResolverState();
    passCalls(db, [batch], idx, edges, state);

    const callEdges = getEdgesByType(edges, 'CALLS');
    expect(callEdges.length).toBe(1);
    expect(callEdges[0].targetId).toBe(importedHelper.id);
    expect(callEdges[0].properties.resolution).toBe('imported-name');
    expect(state.unresolvedCalls).toBe(0);
  });
});
