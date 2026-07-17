/*
 * pass-usages.test.ts — Unit tests for passUsages.
 *
 * Contract:
 *  - Hard-skip names (usageSkip) never create edges.
 *  - Low-signal names (lowSignalGlobalUsage) DO create edges when there's
 *    structural evidence (import-map or same-file), at full confidence (0.85).
 *  - Low-signal names do NOT resolve via unique-name or same-package heuristics.
 *  - Non-generic names resolve through all 4 strategies with strategy-based confidence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passUsages } from '../../../src/pipeline/phases/resolve/pass-usages.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode, makeVariableNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeUsageResult(refName: string, enclosingFuncQn: string, isWrite: boolean = false): ExtractionResult {
  return {
    ...makeEmptyResult(),
    usages: [{ refName, enclosingFuncQn, isWrite }],
  };
}

function makeUsageResultWithImport(refName: string, enclosingFuncQn: string, importLocal: string, importPath: string): ExtractionResult {
  return {
    ...makeEmptyResult(),
    imports: [{ localName: importLocal, modulePath: importPath }],
    usages: [{ refName, enclosingFuncQn }],
  };
}

describe('passUsages', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  // ── Basic resolution strategies ──────────────────────────────

  it('creates USAGE edge from caller to referenced function in same file (same-file strategy)', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const caller = makeFuncNode(2, 'main', 'src/index.ts');
    const target = makeFuncNode(3, 'helper', 'src/index.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, target]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts',
      makeUsageResult('helper', 'index.main'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const usageEdges = getEdgesByType(edges, 'USAGE');
    expect(usageEdges.length).toBe(1);
    expect(usageEdges[0].sourceId).toBe(2);
    expect(usageEdges[0].targetId).toBe(3);
    expect(usageEdges[0].properties.confidence).toBe(0.85);
    expect(usageEdges[0].properties.resolution).toBe('same-file');
  });

  it('creates WRITES edge when isWrite is true', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const caller = makeFuncNode(2, 'setter', 'src/index.ts');
    const target = makeVariableNode(3, 'state', 'src/index.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, target]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts',
      makeUsageResult('state', 'index.setter', true));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const writeEdges = getEdgesByType(edges, 'WRITES');
    expect(writeEdges.length).toBe(1);
    expect(writeEdges[0].sourceId).toBe(2);
    expect(writeEdges[0].targetId).toBe(3);
  });

  it('skips hard-skip names like console (usageSkip)', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const caller = makeFuncNode(2, 'main', 'src/index.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts',
      makeUsageResult('console', 'index.main'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('resolves usage via import-map with confidence 0.85', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const importedFile = makeFileNode(2, 'src/utils/calc.ts');
    const caller = makeFuncNode(3, 'main', 'src/index.ts');
    const exported = makeFuncNode(4, 'summarize', 'src/utils/calc.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, importedFile, caller, exported]);

    const result = makeUsageResultWithImport('summarize', 'index.main', 'summarize', './utils/calc');
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', result);
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const usageEdges = getEdgesByType(edges, 'USAGE');
    expect(usageEdges.length).toBe(1);
    expect(usageEdges[0].sourceId).toBe(3);
    expect(usageEdges[0].targetId).toBe(4);
    expect(usageEdges[0].properties.confidence).toBe(0.85);
    expect(usageEdges[0].properties.resolution).toBe('import-map');
  });

  it('skip if source not found (ghost enclosing function)', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts',
      makeUsageResult('x', 'ghost.fn'));
    const edges: LynxEdge[] = [];
    expect(() => passUsages([batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });

  // ── Generic / low-signal name behavior ───────────────────────

  it('generic name resolves via import-map at full confidence 0.85', () => {
    // 'add' is in lowSignalGlobalUsage but is explicitly imported → strong evidence.
    const fileNode = makeFileNode(1, 'src/index.ts');
    const libFile = makeFileNode(2, 'src/lib/math.ts');
    const caller = makeFuncNode(3, 'compute', 'src/index.ts');
    const exported = makeFuncNode(4, 'add', 'src/lib/math.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, libFile, caller, exported]);

    const result = makeUsageResultWithImport('add', 'index.compute', 'add', './lib/math');
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', result);
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const usageEdges = getEdgesByType(edges, 'USAGE');
    expect(usageEdges.length).toBe(1);
    expect(usageEdges[0].sourceId).toBe(3);
    expect(usageEdges[0].targetId).toBe(4);
    expect(usageEdges[0].properties.confidence).toBe(0.85);
    expect(usageEdges[0].properties.resolution).toBe('import-map');
  });

  it('generic name resolves via same-file at full confidence 0.85', () => {
    // 'load' is in lowSignalGlobalUsage but is in the same file → strong evidence.
    const fileNode = makeFileNode(1, 'src/init.ts');
    const caller = makeFuncNode(2, 'startup', 'src/init.ts');
    const target = makeFuncNode(3, 'load', 'src/init.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, target]);

    const batch = makeBatch('src/init.ts', '/fake/src/init.ts',
      makeUsageResult('load', 'init.startup'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const usageEdges = getEdgesByType(edges, 'USAGE');
    expect(usageEdges.length).toBe(1);
    expect(usageEdges[0].sourceId).toBe(2);
    expect(usageEdges[0].targetId).toBe(3);
    expect(usageEdges[0].properties.confidence).toBe(0.85);
    expect(usageEdges[0].properties.resolution).toBe('same-file');
  });

  it('generic name without import or same-file creates NO edge', () => {
    // 'get' is in lowSignalGlobalUsage. No import, different file.
    // Strategies 3 (unique-name) and 4 (same-package) are skipped for generic names.
    const fileA = makeFileNode(1, 'src/moduleA.ts');
    const fileB = makeFileNode(2, 'src/moduleB.ts');
    const fnA = makeFuncNode(3, 'get', 'src/moduleA.ts');
    const callerB = makeFuncNode(4, 'fetchData', 'src/moduleB.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileA, fileB, fnA, callerB]);

    // Usage of 'get' in moduleB, no import → should not resolve
    const batch = makeBatch('src/moduleB.ts', '/fake/src/moduleB.ts',
      makeUsageResult('get', 'moduleB.fetchData'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('generic name with collision in two modules creates NO edge without import', () => {
    // 'format' exists in two modules. Without import, the generic name has
    // candidates.length > 1, so even unique-name would fail. But with generic
    // names we skip strategies 3 and 4 anyway.
    const fileA = makeFileNode(1, 'src/dates.ts');
    const fileB = makeFileNode(2, 'src/strings.ts');
    const fileC = makeFileNode(3, 'src/consumer.ts');
    const formatA = makeFuncNode(4, 'format', 'src/dates.ts');
    const formatB = makeFuncNode(5, 'format', 'src/strings.ts');
    const caller = makeFuncNode(6, 'display', 'src/consumer.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileA, fileB, fileC, formatA, formatB, caller]);

    const batch = makeBatch('src/consumer.ts', '/fake/src/consumer.ts',
      makeUsageResult('format', 'consumer.display'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    // No edge: generic name with multiple candidates → no resolution.
    expect(edges.length).toBe(0);
  });

  it('non-generic unique name resolves with confidence 0.70', () => {
    // A distinctive name like 'calculateWarpVector' in one module only →
    // unique-name strategy with moderate confidence.
    const fileA = makeFileNode(1, 'src/physics.ts');
    const fileB = makeFileNode(2, 'src/game.ts');
    const target = makeFuncNode(3, 'calculateWarpVector', 'src/physics.ts');
    const caller = makeFuncNode(4, 'tick', 'src/game.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileA, fileB, target, caller]);

    const batch = makeBatch('src/game.ts', '/fake/src/game.ts',
      makeUsageResult('calculateWarpVector', 'game.tick'));
    const edges: LynxEdge[] = [];
    passUsages([batch], idx, edges);

    const usageEdges = getEdgesByType(edges, 'USAGE');
    expect(usageEdges.length).toBe(1);
    expect(usageEdges[0].sourceId).toBe(4);
    expect(usageEdges[0].targetId).toBe(3);
    expect(usageEdges[0].properties.confidence).toBe(0.70);
    expect(usageEdges[0].properties.resolution).toBe('unique-name');
  });

  it('does not resolve a weak TypeScript usage to a same-named C symbol', () => {
    const tsFile = makeFileNode(1, 'ui/example.test.ts');
    const cFile = makeFileNode(2, 'src/assertions.c');
    const caller = makeFuncNode(3, 'run', 'ui/example.test.ts');
    const cTarget = makeFuncNode(4, 'expectUniqueResult', 'src/assertions.c');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [tsFile, cFile, caller, cTarget]);

    const edges: LynxEdge[] = [];
    passUsages([
      makeBatch('ui/example.test.ts', '/fake/ui/example.test.ts',
        makeUsageResult('expectUniqueResult', 'example.test.run')),
    ], idx, edges);

    expect(edges).toEqual([]);
  });

  it('treats C source and header files as one language ecosystem', () => {
    const sourceFile = makeFileNode(1, 'tests/check.c');
    const headerFile = makeFileNode(2, 'include/api.h');
    const caller = makeFuncNode(3, 'test_api', 'tests/check.c');
    const target = makeFuncNode(4, 'cbm_distinctive_api', 'include/api.h');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, headerFile, caller, target]);

    const edges: LynxEdge[] = [];
    passUsages([
      makeBatch('tests/check.c', '/fake/tests/check.c',
        makeUsageResult('cbm_distinctive_api', 'check.test_api')),
    ], idx, edges);

    expect(getEdgesByType(edges, 'USAGE')).toHaveLength(1);
  });
});
