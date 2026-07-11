/*
 * pass-dependencies.test.ts — Unit tests for passDependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passDependencies } from '../../../src/pipeline/phases/resolve/pass-dependencies.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  resetIdCounter, makeEmptyResult, makeBatch,
  createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

describe('passDependencies', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('skip when no Project node exists in rows', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/index.ts', '/fake/src/index.ts', makeEmptyResult());
    const edges: LynxEdge[] = [];
    passDependencies(db, [batch], idx, edges);

    expect(edges.length).toBe(0);
  });

  it('reads package.json and creates DEPENDS_ON edges', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-dep-test-'));

    // Write a minimal package.json in the tmp dir
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { chokidar: '^3.5.0', express: '^4.18.0' },
    }));

    const projectRow = {
      id: 1,
      kind: 'Project' as const,
      name: 'test-proj',
      qualified_name: 'test-proj.project',
      file_path: '',
      start_line: 0,
      properties: null,
    };

    const idx = createEmptyIndexes('test-proj');
    populateIndex(db, idx, [projectRow]);

    // File must be in the tmp dir root so findCommonRoot returns tmpDir itself
    const batch = makeBatch('index.ts', path.join(tmpDir, 'index.ts'), makeEmptyResult());
    const edges: LynxEdge[] = [];

    try {
      passDependencies(db, [batch], idx, edges);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const depEdges = getEdgesByType(edges, 'DEPENDS_ON');
    expect(depEdges.length).toBe(2);
    const chokidarEdge = depEdges.find(e => e.properties.package === 'chokidar');
    expect(chokidarEdge).toBeDefined();
    expect(chokidarEdge!.properties.ecosystem).toBe('npm');
    expect(chokidarEdge!.properties.confidence).toBe(0.9);

    const expressEdge = depEdges.find(e => e.properties.package === 'express');
    expect(expressEdge).toBeDefined();
    expect(expressEdge!.properties.version).toBe('^4.18.0');
  });

  it('skip when no package.json in root dir', () => {
    const projectRow = {
      id: 1,
      kind: 'Project' as const,
      name: 'test-proj',
      qualified_name: 'test-proj.project',
      file_path: '',
      start_line: 0,
      properties: null,
    };

    const idx = createEmptyIndexes('test-proj');
    populateIndex(db, idx, [projectRow]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-dep-empty-'));
    try {
      const batch = makeBatch('src/index.ts', path.join(tmpDir, 'src/index.ts'), makeEmptyResult());
      const edges: LynxEdge[] = [];
      passDependencies(db, [batch], idx, edges);
      expect(edges.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
