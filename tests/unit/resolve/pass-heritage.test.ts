/*
 * pass-heritage.test.ts — Unit tests for passHeritage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passHeritage } from '../../../src/pipeline/phases/resolve/pass-heritage.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  resetIdCounter, makeFileNode, makeClassNode, makeInterfaceNode,
  createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

describe('passHeritage', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates INHERITS from class to base class in same file', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const childClass = makeClassNode(2, 'Dog', 'src/app.ts');
    // Add baseClasses property to child
    childClass.properties = JSON.stringify({ baseClasses: ['Animal'] });
    const parentClass = makeClassNode(3, 'Animal', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, childClass, parentClass]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    const inhEdges = getEdgesByType(edges, 'INHERITS');
    expect(inhEdges.length).toBe(1);
    expect(inhEdges[0].sourceId).toBe(2); // Dog
    expect(inhEdges[0].targetId).toBe(3); // Animal
    expect(inhEdges[0].properties.confidence).toBe(0.9); // same-file
  });

  it('creates INHERITS from interface to base interface', () => {
    const fileNode = makeFileNode(1, 'src/types.ts');
    const childIface = makeInterfaceNode(2, 'Dog', 'src/types.ts', ['Animal']);
    const parentIface = makeInterfaceNode(3, 'Animal', 'src/types.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, childIface, parentIface]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    const inhEdges = getEdgesByType(edges, 'INHERITS');
    expect(inhEdges.length).toBe(1);
    expect(inhEdges[0].sourceId).toBe(2);
    expect(inhEdges[0].targetId).toBe(3);
  });

  it('creates INHERITS from class to interface (implements)', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const childClass = makeClassNode(2, 'Dog', 'src/app.ts');
    childClass.properties = JSON.stringify({ baseInterfaces: ['CanBark'] });
    const iface = makeInterfaceNode(3, 'CanBark', 'src/app.ts');

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, childClass, iface]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    const inhEdges = getEdgesByType(edges, 'INHERITS');
    expect(inhEdges.length).toBe(1);
    expect(inhEdges[0].sourceId).toBe(2); // Dog
    expect(inhEdges[0].targetId).toBe(3); // CanBark
  });

  it('skip when base class not found', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const childClass = makeClassNode(2, 'Dog', 'src/app.ts');
    childClass.properties = JSON.stringify({ baseClasses: ['UnknownParent'] });

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, childClass]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    expect(edges.length).toBe(0);
  });

  it('skip classes/interfaces without heritage properties', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const klass = makeClassNode(2, 'Standalone', 'src/app.ts');
    // No properties set = no baseClasses/baseInterfaces

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, klass]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    expect(edges.length).toBe(0);
  });

  it('skip self-inheritance', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const klass = makeClassNode(2, 'Foo', 'src/app.ts');
    klass.properties = JSON.stringify({ baseClasses: ['Foo'] });

    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode, klass]);

    const edges: LynxEdge[] = [];
    passHeritage(idx, edges);

    // Should not create INHERITS from Foo to itself
    const selfEdges = getEdgesByType(edges, 'INHERITS').filter(
      e => e.sourceId === e.targetId
    );
    expect(selfEdges.length).toBe(0);
  });
});
