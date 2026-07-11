/*
 * pass-structure.test.ts — Unit tests for passStructure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passStructure } from '../../../src/pipeline/phases/resolve/pass-structure.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  resetIdCounter, makeFileNode, makeEmptyResult, makeBatch,
  createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

describe('passStructure', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates Project node if not exists', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passStructure(db, [batch], idx, edges);

    const projectNode = idx.allRows.find(r => r.kind === 'Project');
    expect(projectNode).toBeDefined();
    expect(projectNode!.name).toBe(idx.project);
    expect(idx.qnToId.has(`${idx.project}.project`)).toBe(true);
  });

  it('reuses existing Project node', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    // Run twice; second run should reuse
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    passStructure(db, [batch], idx, []);
    const projectCount1 = idx.allRows.filter(r => r.kind === 'Project').length;

    passStructure(db, [batch], idx, []);
    const projectCount2 = idx.allRows.filter(r => r.kind === 'Project').length;

    expect(projectCount1).toBe(1);
    expect(projectCount2).toBe(1);
  });

  it('creates CONTAINS_FOLDER edges for nested directories', () => {
    const fileNode = makeFileNode(1, 'src/utils/greet.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/utils/greet.ts', '/fake/src/utils/greet.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passStructure(db, [batch], idx, edges);

    const folderEdges = getEdgesByType(edges, 'CONTAINS_FOLDER');
    // src/ -> src/utils/
    expect(folderEdges.length).toBeGreaterThanOrEqual(1);

    // CONTAINS_FILE from src/utils to the file
    const fileEdges = getEdgesByType(edges, 'CONTAINS_FILE');
    expect(fileEdges.length).toBe(1);
    expect(fileEdges[0].targetId).toBe(1);
  });

  it('creates CONTAINS_FILE edges for files in subdirectories', () => {
    const fileNode = makeFileNode(1, 'src/index.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passStructure(db, [batch], idx, edges);

    const fileEdges = getEdgesByType(edges, 'CONTAINS_FILE');
    expect(fileEdges.length).toBe(1);
    expect(fileEdges[0].targetId).toBe(1);
  });

  it('creates Folder nodes for nested directory paths', () => {
    const fileNode = makeFileNode(1, 'deeply/nested/path/file.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('deeply/nested/path/file.ts', '/fake/deeply/nested/path/file.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passStructure(db, [batch], idx, edges);

    // Folder nodes tracked in folderToId, not allRows
    expect(idx.folderToId.has('deeply')).toBe(true);
    expect(idx.folderToId.has('deeply/nested')).toBe(true);
    expect(idx.folderToId.has('deeply/nested/path')).toBe(true);
  });

  it('skip file without parent dir (root-level file)', () => {
    const fileNode = makeFileNode(1, 'root.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('root.ts', '/fake/root.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passStructure(db, [batch], idx, edges);

    // No CONTAINS_FILE since there's no parent folder
    const fileEdges = getEdgesByType(edges, 'CONTAINS_FILE');
    expect(fileEdges.length).toBe(0);
  });
});
