/*
 * pass-routes.test.ts — Unit tests for passRoutes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passRoutes } from '../../../src/pipeline/phases/resolve/pass-routes.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  resetIdCounter, makeFileNode, makeEmptyResult, makeBatch,
  createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

describe('passRoutes', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('skip files that do not match Next.js app route pattern', () => {
    const fileNode = makeFileNode(1, 'src/app/components/Button.tsx');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/app/components/Button.tsx', '/fake/src/app/components/Button.tsx', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passRoutes(db, [batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('skip files that do not match route/page pattern', () => {
    const fileNode = makeFileNode(1, 'src/utils/helpers.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/utils/helpers.ts', '/fake/src/utils/helpers.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passRoutes(db, [batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('creates Route with ALL method when file is not readable', () => {
    // Use a path that never exists on disk
    const routePath = 'src/app/products/route.ts';
    const fileNode = makeFileNode(1, routePath);
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch(routePath, '/tmp/nonexistent-lynx-test/products/route.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passRoutes(db, [batch], idx, edges);

    // Route node created with ALL method since file can't be read
    const routeNodes = idx.allRows.filter(r => r.kind === 'Route');
    expect(routeNodes.length).toBeGreaterThanOrEqual(1);
    if (routeNodes.length > 0) {
      const props = JSON.parse(routeNodes[0].properties || '{}');
      expect(props.httpMethod).toBe('ALL');
    }
  });

  it('skip when file node not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/app/page.tsx', '/fake/src/app/page.tsx', makeEmptyResult());
    const edges: LynxEdge[] = [];
    expect(() => passRoutes(db, [batch], idx, edges)).not.toThrow();
  });
});
