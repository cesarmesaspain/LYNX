import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildIndexContext, setDb, unsetDb } from '../../../src/mcp/server.js';
import { handleIndexStatus } from '../../../src/mcp/handlers/index_status.js';
import { LynxDatabase } from '../../../src/store/database.js';
import { upsertFileHash } from '../../../src/store/memory.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 5_000,
  }).trim();
}

describe('MCP graph drift warnings', () => {
  it('marks index context and index_status as drifted after indexed source changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-mcp-drift-'));
    const file = path.join(root, 'src', 'app.ts');
    const project = `mcp-drift-${Date.now()}`;
    const db = LynxDatabase.openMemory();

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export const app = 1;\n');
      for (const args of [
        ['init'],
        ['config', 'user.email', 'test@lynx.local'],
        ['config', 'user.name', 'LYNX Test'],
        ['add', '.'],
        ['commit', '-m', 'fixture'],
      ]) {
        git(root, args);
      }

      db.upsertProject(project, root);
      db.setProjectIndexedCommit(project, git(root, ['rev-parse', 'HEAD']));
      db.db.prepare(
        'INSERT INTO nodes (project, kind, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?)',
      ).run(project, 'Variable', 'app', 'app', 'src/app.ts');

      const source = fs.readFileSync(file);
      const stat = fs.statSync(file);
      upsertFileHash(
        db,
        project,
        'src/app.ts',
        createHash('sha256').update(source).digest('hex'),
        Math.floor(stat.mtimeMs * 1_000_000),
        stat.size,
      );
      setDb(project, db);

      expect(buildIndexContext({ project })).toMatchObject({
        freshness: 'fresh',
        graph_drift: { status: 'clean' },
      });

      fs.writeFileSync(file, 'export const app = 100;\n');

      expect(buildIndexContext({ project })).toMatchObject({
        freshness: 'drifted',
        graph_drift: {
          status: 'drifted',
          working_tree_changed: true,
          changed_files: ['src/app.ts'],
        },
      });
      expect(await handleIndexStatus({ project })).toMatchObject({
        freshness: 'drifted',
        graph_drift: {
          status: 'drifted',
          working_tree_changed: true,
        },
      });
    } finally {
      unsetDb(project, { close: false });
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
