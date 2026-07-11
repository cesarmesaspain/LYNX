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

  it('skip when file node not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts', makeImportResult('x', './y'));
    const edges: LynxEdge[] = [];
    expect(() => passImports([batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
