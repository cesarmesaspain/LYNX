/*
 * pass-throws.test.ts — Unit tests for passThrows.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passThrows } from '../../../src/pipeline/phases/resolve/pass-throws.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode, makeClassNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeThrowResult(exceptionName: string, enclosingFuncQn: string, startLine: number = 5): ExtractionResult {
  return {
    ...makeEmptyResult(),
    throws: [{ exceptionName, enclosingFuncQn, startLine }],
  };
}

describe('passThrows', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates RAISES edge for Error/Panic exceptions resolved to known class', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'riskyOperation', 'src/app.ts');
    const errClass = makeClassNode(3, 'Error', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, errClass]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeThrowResult('Error', 'app.riskyOperation'));
    const edges: LynxEdge[] = [];
    passThrows(db, [batch], idx, edges);

    const raisesEdges = getEdgesByType(edges, 'RAISES');
    expect(raisesEdges.length).toBe(1);
    expect(raisesEdges[0].sourceId).toBe(2);
    expect(raisesEdges[0].targetId).toBe(3);
    expect(raisesEdges[0].properties.exceptionName).toBe('Error');
  });

  it('creates THROWS edge for non-Error exceptions', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'validator', 'src/app.ts');
    const customErr = makeClassNode(3, 'ValidationException', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller, customErr]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeThrowResult('ValidationException', 'app.validator'));
    const edges: LynxEdge[] = [];
    passThrows(db, [batch], idx, edges);

    const throwsEdges = getEdgesByType(edges, 'THROWS');
    expect(throwsEdges.length).toBe(1);
    expect(throwsEdges[0].sourceId).toBe(2);
    expect(throwsEdges[0].targetId).toBe(3);
  });

  it('creates ExternalSymbol for unknown exception names', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const caller = makeFuncNode(2, 'fn', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, caller]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeThrowResult('UnknownError', 'app.fn'));
    const edges: LynxEdge[] = [];
    passThrows(db, [batch], idx, edges);

    const raisesEdges = getEdgesByType(edges, 'RAISES');
    expect(raisesEdges.length).toBe(1);
    expect(raisesEdges[0].properties.resolution).toBe('external-exception');
    expect(raisesEdges[0].properties.confidence).toBe(0.55);
  });

  it('skip if source caller not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts',
      makeThrowResult('Error', 'ghost.fn'));
    const edges: LynxEdge[] = [];
    expect(() => passThrows(db, [batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
