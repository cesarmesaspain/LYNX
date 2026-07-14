import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleIndexRepository } from '../../../src/mcp/handlers/index_repository.js';
import { unsetDb } from '../../../src/mcp/server.js';
import { getDb } from '../../../src/mcp/server.js';

const cleanup: Array<{ root: string; project: string }> = [];
afterEach(() => {
  for (const item of cleanup.splice(0)) {
    unsetDb(item.project, { close: true });
    const dbBase = path.join(os.homedir(), '.lynx', 'dbs', `${item.project}.db`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbBase + suffix, { force: true });
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

function fixture(project: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-handler-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;');
  for (const args of [['init'], ['config', 'user.email', 'test@lynx.local'], ['config', 'user.name', 'LYNX Test'], ['add', '.'], ['commit', '-m', 'fixture']]) execFileSync('git', args, { cwd: root });
  cleanup.push({ root, project });
  return root;
}

describe('handleIndexRepository incremental contract', () => {
  it('uses the incremental contract by default', async () => {
    const project = `handler-${Date.now()}`;
    const root = fixture(project);
    const result = await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', incremental: true, __test_skip_project_brief: true }) as Record<string, unknown>;
    expect(result.update_mode).toBe('incremental');
    expect(result.health).toBe('healthy');
    expect(result.files_inspected).toBeGreaterThan(0);
    expect(result.fallback_reason).toBeNull();
  }, 30000);

  it('reports an added file through the incremental contract', async () => {
    const project = `handler-${Date.now()}`;
    const root = fixture(project);
    await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', __test_skip_project_brief: true });
    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export const added = 1;');
    const result = await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', incremental: true, __test_skip_project_brief: true }) as Record<string, unknown>;
    expect(result.update_mode).toBe('incremental');
    expect(result.files_added).toEqual(['src/added.ts']);
    expect(result.files_reindexed).toContain('src/added.ts');
    expect(result.health).toBe('healthy');
    expect(result.duration_ms).toEqual(expect.any(Number));
    const db = getDb(project)!;
    expect((db.db.prepare('SELECT COUNT(*) AS count FROM file_hashes WHERE project = ? AND rel_path = ?').get(project, 'src/added.ts') as { count: number }).count).toBe(1);
  }, 30000);

  it('reports deletion and rename fallbacks with an exact reason', async () => {
    const project = `handler-${Date.now()}`;
    const root = fixture(project);
    await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', __test_skip_project_brief: true });
    fs.renameSync(path.join(root, 'src', 'app.ts'), path.join(root, 'src', 'renamed.ts'));
    const result = await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', incremental: true, __test_skip_project_brief: true }) as Record<string, any>;
    expect(result.update_mode).toBe('full_fallback');
    expect(result.fallback_reason).toBe('deleted_or_renamed_file_requires_full_relationship_resolution');
    expect(result.files_deleted).toEqual(['src/app.ts']);
    expect(result.files_renamed).toEqual([{ from: 'src/app.ts', to: 'src/renamed.ts' }]);
    expect(result.health).toBe('healthy');
  }, 30000);

  it('does not publish false success after an injected failure and recovers', async () => {
    const project = `handler-${Date.now()}`;
    const root = fixture(project);
    await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', __test_skip_project_brief: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 2;');
    await expect(handleIndexRepository({ repo_path: root, name: project, mode: 'fast', incremental: true, __test_skip_project_brief: true, __test_fail_at: 'hashes' })).rejects.toThrow('LYNX_TEST_PIPELINE_FAILURE:hashes');
    const recovered = await handleIndexRepository({ repo_path: root, name: project, mode: 'fast', incremental: true, __test_skip_project_brief: true }) as Record<string, unknown>;
    expect(recovered.health).toBe('healthy');
    expect(recovered.update_mode).toBe('incremental');
  }, 30000);
});
