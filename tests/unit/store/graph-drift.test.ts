import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { detectGraphDrift } from '../../../src/store/graph-drift.js';
import { upsertFileHash } from '../../../src/store/memory.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5_000 }).trim();
}

describe('graph drift detector', () => {
  it('reports clean metadata and detects working-tree and HEAD changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-graph-drift-'));
    const file = path.join(root, 'src', 'app.ts');
    const db = LynxDatabase.openMemory();
    const project = 'graph-drift';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export const app = 1;\n');
      for (const args of [['init'], ['config', 'user.email', 'test@lynx.local'], ['config', 'user.name', 'LYNX Test'], ['add', '.'], ['commit', '-m', 'fixture']]) git(root, args);
      const head = git(root, ['rev-parse', 'HEAD']);
      db.upsertProject(project, root);
      db.setProjectIndexedCommit(project, head);
      const source = fs.readFileSync(file);
      const stat = fs.statSync(file);
      upsertFileHash(db, project, 'src/app.ts', createHash('sha256').update(source).digest('hex'), Math.floor(stat.mtimeMs * 1_000_000), stat.size);

      const meta = db.getProject(project);
      expect(meta).not.toBeNull();
      expect(detectGraphDrift(db, meta!)).toMatchObject({ status: 'clean', head_changed: false, working_tree_changed: false, changed_files_count: 0 });

      fs.writeFileSync(file, 'export const app = 100;\n');
      expect(detectGraphDrift(db, meta!)).toMatchObject({ status: 'drifted', head_changed: false, working_tree_changed: true, changed_files: ['src/app.ts'] });

      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'change']);
      expect(detectGraphDrift(db, meta!)).toMatchObject({ status: 'drifted', head_changed: true });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
