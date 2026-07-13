import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleFindTests } from '../../../src/mcp/handlers/find_tests.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'find-tests-file-coverage';

afterEach(() => unsetDb(PROJECT, { close: false }));

describe('find_tests file-level fallback', () => {
  it('returns TESTS_FILE evidence when no direct TESTS edge exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-find-tests-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'handler.ts'), 'export function handleRequest() {}\n');
    fs.writeFileSync(path.join(root, 'tests', 'handler.test.ts'), "import { handleRequest } from '../src/handler.js';\n");

    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, root);
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'File', 'handler.ts', 'app.file.handler', 'src/handler.ts', 1, 1, 0, 0, 0, '{}'),
               (2, ?, 'Function', 'handleRequest', 'app.handleRequest', 'src/handler.ts', 1, 1, 1, 0, 0, '{}'),
               (3, ?, 'File', 'handler.test.ts', 'app.file.handler.test', 'tests/handler.test.ts', 1, 1, 0, 1, 0, '{}')`).run(PROJECT, PROJECT, PROJECT);
      db.db.prepare("INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 3, 1, 'TESTS_FILE', '{}')").run(PROJECT);
      setDb(PROJECT, db);

      const result = await handleFindTests({ project: PROJECT, qualified_name: 'app.handleRequest' }) as Record<string, unknown>;

      expect(result.coverage_level).toBe('file');
      expect(result.count).toBe(1);
      expect(result.tests).toEqual([expect.objectContaining({ file_path: 'tests/handler.test.ts' })]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns low-confidence text evidence for a dynamically imported symbol', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-find-tests-text-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'dashboard.ts'), 'export function renderDashboard() {}\n');
    fs.writeFileSync(path.join(root, 'tests', 'dashboard.test.ts'), "const getRenderer = () => import('../src/dashboard.js');\nvoid getRenderer().then(({ renderDashboard }) => renderDashboard());\n");

    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject(PROJECT, root);
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (10, ?, 'Function', 'renderDashboard', 'dashboard.renderDashboard', 'src/dashboard.ts', 1, 1, 1, 0, 0, '{}'),
               (11, ?, 'File', 'dashboard.test.ts', 'tests.dashboard.test', 'tests/dashboard.test.ts', 1, 2, 0, 1, 0, '{}')`).run(PROJECT, PROJECT);
      setDb(PROJECT, db);

      const result = await handleFindTests({ project: PROJECT, qualified_name: 'dashboard.renderDashboard' }) as Record<string, unknown>;

      expect(result.coverage_level).toBe('text');
      expect(result.coverage_note).toContain('Text evidence only');
      expect(result.tests).toEqual([expect.objectContaining({ file_path: 'tests/dashboard.test.ts' })]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
