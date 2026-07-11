/*
 * pass-decorators.test.ts — Unit tests for passDecorators.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passDecorators } from '../../../src/pipeline/phases/resolve/pass-decorators.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode, makeClassNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeDecoratorResult(decoratorName: string, targetQn: string): ExtractionResult {
  return {
    ...makeEmptyResult(),
    decorators: [{ name: decoratorName, targetQn, startLine: 1 }],
  };
}

describe('passDecorators', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates DECORATES edge when decorator is a known function', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const targetFunc = makeFuncNode(2, 'endpoint', 'src/app.ts'); // @endpoint
    const decorator = makeFuncNode(3, 'endpoint', 'src/app.ts');

    // Adjust decorator qualified_name so resolveCaller finds it
    // The targetQn in decorator extraction is the full qualified name
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, decorator, targetFunc]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeDecoratorResult('endpoint', 'app.endpoint'));
    const edges: LynxEdge[] = [];
    passDecorators([batch], idx, edges);

    const decEdges = getEdgesByType(edges, 'DECORATES');
    expect(decEdges.length).toBe(1);
    expect(decEdges[0].sourceId).toBe(2);
    expect(decEdges[0].targetId).toBe(3);
    expect(decEdges[0].properties.decorator).toBe('endpoint');
  });

  it('creates DECORATES edge when decorator is a known class', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const targetClass = makeClassNode(2, 'Controller', 'src/app.ts');
    const decorator = makeFuncNode(3, 'Component', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, decorator, targetClass]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeDecoratorResult('Component', 'app.Controller'));
    const edges: LynxEdge[] = [];
    passDecorators([batch], idx, edges);

    const decEdges = getEdgesByType(edges, 'DECORATES');
    expect(decEdges.length).toBe(1);
    expect(decEdges[0].sourceId).toBe(2);
    expect(decEdges[0].targetId).toBe(3);
  });

  it('skips when decorator name not found in registry', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const targetFunc = makeFuncNode(2, 'handler', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, targetFunc]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeDecoratorResult('UnknownDecorator', 'app.handler'));
    const edges: LynxEdge[] = [];
    passDecorators([batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('handles empty decorators array', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/x.ts', '/fake/src/x.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    expect(() => passDecorators([batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
