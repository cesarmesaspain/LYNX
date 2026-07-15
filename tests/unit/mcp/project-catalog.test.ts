import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lynxHome } from '../../../src/config/runtime.js';
import { scanIndexedProjects } from '../../../src/mcp/project-catalog.js';
import { LynxDatabase } from '../../../src/store/database.js';

const project = `catalog-${process.pid}-${Date.now()}`;
const dbPath = path.join(lynxHome(), 'dbs', `${project}.db`);
const orphanPath = path.join(lynxHome(), 'dbs', `${project}-orphan.db`);

afterEach(() => {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(orphanPath, { force: true });
});

describe('scanIndexedProjects', () => {
  it('returns registered indexes and ignores unregistered database files', () => {
    const db = LynxDatabase.openProject(project);
    try {
      db.upsertProject(project, '/tmp/catalog-project');
    } finally {
      db.close();
    }
    fs.writeFileSync(orphanPath, 'not a LYNX project database');

    const matches = scanIndexedProjects().filter(entry => entry.name.startsWith(project));

    expect(matches).toEqual([
      expect.objectContaining({ name: project, rootPath: '/tmp/catalog-project', nodeCount: 0 }),
    ]);
  });
});
