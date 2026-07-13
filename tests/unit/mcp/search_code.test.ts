import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleSearchCode, runGrepSearch } from '../../../src/mcp/handlers/search_code.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runGrepSearch shell safety', () => {
  it('treats a shell-looking indexed path as a literal grep argument', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-search-safe-'));
    tempDirs.push(root);
    const file = '$(touch injected).ts';
    fs.writeFileSync(path.join(root, file), 'const needle = true;\n');

    const db = LynxDatabase.openMemory();
    try {
      db.db.prepare(
        `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
         VALUES (1, ?, 'File', 'fixture', 'fixture', ?, 1, 1, 0, 0, 0, '{}')`
      ).run('fixture', file);

      const result = runGrepSearch(db, 'fixture', 'needle', false, root);

      expect(Array.isArray(result)).toBe(true);
      expect(Array.isArray(result) && result[0]).toMatchObject({ file, line: 1 });
      expect(fs.existsSync(path.join(root, 'injected'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('handleSearchCode aliases', () => {
  it('accepts query, path_prefix, and max_results like the graph search tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-search-alias-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'export const token = true;\n');

    const db = LynxDatabase.openMemory();
    try {
      db.upsertProject('fixture', root);
      db.db.prepare(
        `INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line,
          is_exported, is_test, is_entry_point, properties)
         VALUES ('fixture', 'File', 'auth.ts', 'fixture.file.auth', 'src/auth.ts', 1, 1, 0, 0, 0, '{}')`,
      ).run();
      setDb('fixture', db);

      const result = await handleSearchCode({
        project: 'fixture', query: 'token', path_prefix: 'src/', max_results: 1,
      }) as Record<string, unknown>;

      expect(result.total_grep_matches).toBe(1);
      expect(result.total_results).toBe(1);
      expect(result.files).toEqual(['src/auth.ts']);
    } finally {
      unsetDb('fixture', { close: false });
      db.close();
    }
  });
});
