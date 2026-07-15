import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleDeleteProject } from '../../../src/mcp/handlers/delete_project.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) unsetDb(project, { close: false });
});

function persistentFixture(project: string): { db: LynxDatabase; dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-delete-project-'));
  const dbPath = path.join(dir, 'project.db');
  const db = LynxDatabase.openPath(dbPath);
  projects.push(project);
  setDb(project, db);
  return { db, dbPath, dir };
}

describe('delete_project persistent cleanup', () => {
  it('removes the project database and sidecar files after deleting data', async () => {
    const project = 'delete-persistent';
    const { db, dbPath, dir } = persistentFixture(project);
    try {
      db.upsertProject(project, '/tmp/repo');
      db.db.prepare(`INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (?, 'Function', 'main', 'app.main', 'src/index.ts', 1, 1, 0, 0, 0, '{}')`).run(project);

      const result = await handleDeleteProject({ project, confirm: true }) as Record<string, unknown>;

      expect(result).toMatchObject({ deleted: project, nodes_removed: 1, database_purged: true });
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(dbPath + '-wal')).toBe(false);
      expect(fs.existsSync(dbPath + '-shm')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purges a confirmed empty persistent database left by an old workflow', async () => {
    const project = 'delete-empty';
    const { dbPath, dir } = persistentFixture(project);
    try {
      const result = await handleDeleteProject({ project, confirm: true }) as Record<string, unknown>;

      expect(result).toMatchObject({ deleted: project, nodes_removed: 0, database_purged: true });
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
