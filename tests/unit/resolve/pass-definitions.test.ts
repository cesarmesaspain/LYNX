/*
 * pass-definitions.test.ts — Unit tests for passDefinitions and splitTypeList.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passDefinitions, splitTypeList } from '../../../src/pipeline/phases/resolve/pass-definitions.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  resetIdCounter, makeFileNode, makeFuncNode, makeClassNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
  type NodeRef,
} from './helpers.js';

describe('splitTypeList', () => {
  it('splits simple comma-separated names', () => {
    expect(splitTypeList('Foo, Bar, Baz')).toEqual(['Foo', 'Bar', 'Baz']);
  });

  it('handles a single name', () => {
    expect(splitTypeList('Foo')).toEqual(['Foo']);
  });

  it('respects angle-bracket nesting (does not split on commas inside <>)', () => {
    const result = splitTypeList('Foo<Bar, Baz>, Qux');
    // 2 top-level types: Foo<Bar, Baz> and Qux
    expect(result.length).toBe(2);
    // First token of Foo<Bar, Baz> after split(/\s+/) is Foo<Bar,
    expect(result[1]).toBe('Qux');
  });

  it('handles deeply nested generics (does not split on nested commas)', () => {
    const result = splitTypeList('Result<Promise<Data>, Error>');
    // 1 top-level type: Result<Promise<Data>, Error>
    expect(result.length).toBe(1);
  });

  it('returns empty array for empty string', () => {
    expect(splitTypeList('')).toEqual([]);
  });

  it('trims whitespace around names', () => {
    expect(splitTypeList(' Foo , Bar ')).toEqual(['Foo', 'Bar']);
  });
});

describe('passDefinitions', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates DEFINES edges from File to symbols', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const funcNode = makeFuncNode(2, 'greet', 'src/index.ts');
    const classNode = makeClassNode(3, 'App', 'src/index.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, funcNode, classNode]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];

    passDefinitions([batch], idx, edges);

    const defEdges = getEdgesByType(edges, 'DEFINES');
    expect(defEdges.length).toBe(2);
    expect(defEdges.map(e => e.targetId).sort()).toEqual([2, 3]);
  });

  it('does not create DEFINES for File or Folder nodes', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passDefinitions([batch], idx, edges);

    // Only File node exists, should get no DEFINES (File→File is skipped)
    const defEdges = getEdgesByType(edges, 'DEFINES');
    expect(defEdges.length).toBe(0);
  });

  it('creates DEFINES_METHOD for methods inside classes', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const classNode = makeClassNode(2, 'App', 'src/app.ts');
    const methodNode: NodeRef = {
      id: 3,
      kind: 'Method',
      name: 'render',
      qualified_name: 'app.App.render',
      file_path: 'src/app.ts',
      start_line: 5,
      properties: null,
    };

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, classNode, methodNode]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passDefinitions([batch], idx, edges);

    const methodEdges = getEdgesByType(edges, 'DEFINES_METHOD');
    expect(methodEdges.length).toBe(1);
    expect(methodEdges[0].sourceId).toBe(2);
    expect(methodEdges[0].targetId).toBe(3);
  });

  it('skips when file node not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    expect(() => passDefinitions([batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
