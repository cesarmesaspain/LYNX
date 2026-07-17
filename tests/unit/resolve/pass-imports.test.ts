/*
 * pass-imports.test.ts — Unit tests for passImports.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passImports } from '../../../src/pipeline/phases/resolve/pass-imports.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeImportResult(localName: string, modulePath: string): ExtractionResult {
  return {
    ...makeEmptyResult(),
    imports: [{ localName, modulePath }],
  };
}

describe('passImports', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates IMPORTS edge from file to imported file via module key', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const importedFile = makeFileNode(2, 'src/utils/greet.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, importedFile]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeImportResult('greet', './utils/greet.js'));
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    const impEdges = getEdgesByType(edges, 'IMPORTS');
    expect(impEdges.length).toBeGreaterThanOrEqual(1);

    // Should have at least a module-level import edge
    const moduleEdge = impEdges.find(e => e.properties.resolution === 'module');
    expect(moduleEdge).toBeDefined();
    expect(moduleEdge!.sourceId).toBe(1);
    expect(moduleEdge!.targetId).toBe(2);
  });

  it('creates IMPORTS edge to exported symbol when found', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const importedFile = makeFileNode(2, 'src/utils/greet.ts');
    const exportedFunc = makeFuncNode(3, 'greet', 'src/utils/greet.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, importedFile, exportedFunc]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeImportResult('greet', './utils/greet'));
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    // Should have at least one import edge to the exported function
    const symbolEdge = getEdgesByType(edges, 'IMPORTS').find(
      e => e.targetId === 3
    );
    expect(symbolEdge).toBeDefined();
    expect(symbolEdge!.properties.localName).toBe('greet');
  });

  it('does not create IMPORTS edge when source and target are the same', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    // Self-import (edge case)
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeImportResult('something', './index'));
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    // No edge should be created because moduleToFileNode won't resolve to same file
    // Or if it does, the file.id !== fileNode.id check prevents it
    const selfEdges = getEdgesByType(edges, 'IMPORTS').filter(
      e => e.sourceId === e.targetId
    );
    expect(selfEdges.length).toBe(0);
  });

  it('makes all declarations in an included C header reachable to call resolution', () => {
    const sourceFile = makeFileNode(1, 'src/run.c');
    const headerFile = makeFileNode(2, 'include/api.h');
    const declared = makeFuncNode(3, 'client_open', 'include/api.h');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, headerFile, declared]);

    const batch = makeBatch(
      'src/run.c', '/fake/src/run.c', makeImportResult('apih', '../include/api.h'),
    );
    passImports([batch], idx, []);

    expect(idx.importedQnByFile.get('src/run.c')).toContain(declared.qualified_name);
  });

  it('resolves a bare C include through a unique repository header suffix', () => {
    const sourceFile = makeFileNode(1, 'tests/test_cbm.c');
    const headerFile = makeFileNode(2, 'internal/cbm/cbm.h');
    const declared = makeFuncNode(3, 'cbm_open', 'internal/cbm/cbm.h');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, headerFile, declared]);

    const batch = makeBatch(
      'tests/test_cbm.c', '/fake/tests/test_cbm.c', makeImportResult('cbmh', 'cbm.h'),
    );
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    expect(idx.importedQnByFile.get('tests/test_cbm.c')).toContain(declared.qualified_name);
    expect(getEdgesByType(edges, 'IMPORTS')).toContainEqual(
      expect.objectContaining({ sourceId: sourceFile.id, targetId: headerFile.id }),
    );
  });

  it('does not guess when a bare C header include is ambiguous', () => {
    const sourceFile = makeFileNode(1, 'tests/test_common.c');
    const firstHeader = makeFileNode(2, 'lib/a/common.h');
    const secondHeader = makeFileNode(3, 'lib/b/common.h');
    const firstFn = makeFuncNode(4, 'common_open', 'lib/a/common.h');
    const secondFn = makeFuncNode(5, 'common_open', 'lib/b/common.h');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, firstHeader, secondHeader, firstFn, secondFn]);

    const batch = makeBatch(
      'tests/test_common.c', '/fake/tests/test_common.c', makeImportResult('commonh', 'common.h'),
    );
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    expect(idx.importedQnByFile.get('tests/test_common.c')).toEqual(new Set());
    expect(getEdgesByType(edges, 'IMPORTS')).toHaveLength(0);
  });

  it('resolves a Go module import to the unique local package directory', () => {
    const sourceFile = makeFileNode(1, 'cmd/main.go');
    const packageFile = makeFileNode(2, 'pkg/mathlib/mathlib.go');
    const secondPackageFile = makeFileNode(3, 'pkg/mathlib/extra.go');
    const twice = makeFuncNode(4, 'Twice', 'pkg/mathlib/mathlib.go');
    const add = makeFuncNode(5, 'Add', 'pkg/mathlib/extra.go');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, packageFile, secondPackageFile, twice, add]);

    const batch = makeBatch(
      'cmd/main.go', '/fake/cmd/main.go', makeImportResult('mathlib', 'example.com/acme/project/pkg/mathlib'),
    );
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    expect(idx.importedQnByFile.get('cmd/main.go')).toEqual(
      new Set([twice.qualified_name, add.qualified_name]),
    );
    expect(getEdgesByType(edges, 'IMPORTS')).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: sourceFile.id, targetId: packageFile.id }),
      expect.objectContaining({ sourceId: sourceFile.id, targetId: secondPackageFile.id }),
    ]));
  });

  it('does not guess when a Go package suffix is ambiguous', () => {
    const sourceFile = makeFileNode(1, 'cmd/main.go');
    const firstPackage = makeFileNode(2, 'first/mathlib/mathlib.go');
    const secondPackage = makeFileNode(3, 'second/mathlib/mathlib.go');
    const firstFn = makeFuncNode(4, 'Twice', firstPackage.file_path);
    const secondFn = makeFuncNode(5, 'Twice', secondPackage.file_path);
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, firstPackage, secondPackage, firstFn, secondFn]);

    const batch = makeBatch(
      'cmd/main.go', '/fake/cmd/main.go', makeImportResult('mathlib', 'example.com/project/mathlib'),
    );
    const edges: LynxEdge[] = [];
    passImports([batch], idx, edges);

    expect(idx.importedQnByFile.get('cmd/main.go')).toEqual(new Set());
    expect(getEdgesByType(edges, 'IMPORTS')).toHaveLength(0);
  });

  it('makes static methods in an imported JVM class reachable', () => {
    const sourceFile = makeFileNode(1, 'golden/App.java');
    const classFile = makeFileNode(2, 'golden/MathLib.java');
    const twice = { ...makeFuncNode(3, 'twice', classFile.file_path), kind: 'Method' };
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [sourceFile, classFile, twice]);

    const batch = makeBatch(
      sourceFile.file_path,
      '/fake/golden/App.java',
      makeImportResult('MathLib', 'golden/MathLib'),
    );
    passImports([batch], idx, []);

    expect(idx.importedQnByFile.get(sourceFile.file_path)).toContain(twice.qualified_name);
  });

  it('skip when file node not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts', makeImportResult('x', './y'));
    const edges: LynxEdge[] = [];
    expect(() => passImports([batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
