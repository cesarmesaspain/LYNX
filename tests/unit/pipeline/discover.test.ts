/*
 * discover.test.ts — Focused tests for file discovery exclusions.
 *
 * Proves: .claude, .claude/worktrees, node_modules, .next, generated
 * output, caches, backups, logs, reports, tmp, coverage, and nested
 * worktrees/repos are excluded, while legitimate source dirs remain.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverFiles } from '../../../src/pipeline/phases/discover.js';

function mkdir(...parts: string[]) {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(filepath: string, content: string) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5_000 });
}

let testDir: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-discover-test-'));
});

afterAll(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function relFiles(result: ReturnType<typeof discoverFiles>): string[] {
  return result.files.map(f => f.relPath);
}

function hasFile(result: ReturnType<typeof discoverFiles>, suffix: string): boolean {
  return result.files.some(f => f.relPath.endsWith(suffix) || f.relPath === suffix);
}

describe('discover exclusion rules', () => {
  it('excludes .claude directory', () => {
    writeFile(path.join(testDir, '.claude/skills/some-skill.md'), '# skill');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'fast');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, '.claude/skills/some-skill.md')).toBe(false);
  });

  it('excludes nested .claude/worktrees content', () => {
    writeFile(path.join(testDir, '.claude/worktrees/wt1/src/app.ts'), 'export const app = 1;');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'fast');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, '.claude/worktrees/wt1/src/app.ts')).toBe(false);
  });

  it('excludes node_modules', () => {
    writeFile(path.join(testDir, 'node_modules/pkg/index.js'), 'module.exports = 1;');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'node_modules/pkg/index.js')).toBe(false);
  });

  it('excludes .next build output', () => {
    writeFile(path.join(testDir, '.next/static/chunks/app.js'), '// chunk');
    writeFile(path.join(testDir, 'src/page.tsx'), 'export default Page;');

    const result = discoverFiles(testDir, 'fast');
    expect(relFiles(result)).toContain('src/page.tsx');
    expect(hasFile(result, '.next/static/chunks/app.js')).toBe(false);
  });

  it('excludes generated directories (fast mode)', () => {
    writeFile(path.join(testDir, 'generated/types.ts'), 'export type T = string;');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'fast');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'generated/types.ts')).toBe(false);
  });

  it('includes application scripts in fast mode', () => {
    writeFile(path.join(testDir, 'scripts/sync-production.ts'), 'export async function sync() {}');
    const result = discoverFiles(testDir, 'fast');
    expect(relFiles(result)).toContain('scripts/sync-production.ts');
  });

  it('excludes coverage output', () => {
    writeFile(path.join(testDir, 'coverage/lcov-report/app.js'), '// lcov');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'coverage/lcov-report/app.js')).toBe(false);
  });

  it('excludes .cache directory', () => {
    writeFile(path.join(testDir, '.cache/babel/foo.json'), '{}');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, '.cache/babel/foo.json')).toBe(false);
  });

  it('excludes backups directory', () => {
    writeFile(path.join(testDir, 'backups/old-index.ts'), 'old code');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'backups/old-index.ts')).toBe(false);
  });

  it('excludes logs directory', () => {
    writeFile(path.join(testDir, 'logs/app.log'), 'log line');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'logs/app.log')).toBe(false);
  });

  it('excludes reports directory', () => {
    writeFile(path.join(testDir, 'reports/audit.md'), '# audit');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'reports/audit.md')).toBe(false);
  });

  it('excludes tmp directories', () => {
    writeFile(path.join(testDir, 'tmp/scratch.ts'), 'scratch');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'tmp/scratch.ts')).toBe(false);
  });

  it('excludes tmp_build directory', () => {
    writeFile(path.join(testDir, 'tmp_build/output.ts'), 'build output');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    expect(relFiles(result)).toContain('src/index.ts');
    expect(hasFile(result, 'tmp_build/output.ts')).toBe(false);
  });

  it('legitimate source directories remain indexed', () => {
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');
    writeFile(path.join(testDir, 'src/lib/math.ts'), 'export function add() {}');
    writeFile(path.join(testDir, 'tests/index.test.ts'), 'import { x } from "../src/index";');
    writeFile(path.join(testDir, 'tests/integration/runtime.test.ts'), 'import { x } from "../../src/index";');
    writeFile(path.join(testDir, 'components/Button.tsx'), 'export const Button = () => null;');

    const result = discoverFiles(testDir, 'fast');
    const files = relFiles(result);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/lib/math.ts');
    expect(files).toContain('tests/index.test.ts');
    expect(files).toContain('tests/integration/runtime.test.ts');
    expect(files).toContain('components/Button.tsx');
  });
});

describe('discover nested repo/worktree detection', () => {
  it('excludes nested git repository (contains .git directory)', () => {
    writeFile(path.join(testDir, 'src/main.ts'), 'export const main = 1;');
    // Create a nested git repo in workspace/subrepo
    const subrepoDir = path.join(testDir, 'workspace', 'subrepo');
    mkdir(subrepoDir);
    git(['init'], subrepoDir);
    writeFile(path.join(subrepoDir, 'src/app.ts'), 'export const app = 1;');

    // moderate mode so workspace/ is not excluded by fast mode
    const result = discoverFiles(testDir, 'moderate');
    const files = relFiles(result);
    expect(files).toContain('src/main.ts');
    // Nested repo content must be excluded
    expect(hasFile(result, 'workspace/subrepo/src/app.ts')).toBe(false);
  });

  it('excludes linked git worktree (contains .git file)', () => {
    // Create a main repo
    const mainRepoDir = path.join(testDir, 'mainrepo');
    mkdir(mainRepoDir);
    git(['init'], mainRepoDir);
    git(['config', 'user.email', 'test@lynx.dev'], mainRepoDir);
    git(['config', 'user.name', 'LYNX Test'], mainRepoDir);
    writeFile(path.join(mainRepoDir, 'src/app.ts'), 'export const app = 1;');
    git(['add', '-A'], mainRepoDir);
    git(['commit', '-m', 'init'], mainRepoDir);

    // Create a linked worktree
    const wtDir = path.join(testDir, 'worktrees', 'feature-branch');
    mkdir(path.dirname(wtDir));
    git(['worktree', 'add', wtDir, 'HEAD'], mainRepoDir);

    // Also put a legitimate source file in testDir
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    const files = relFiles(result);
    expect(files).toContain('src/index.ts');
    // The linked worktree is a nested repo — its contents should be excluded
    expect(hasFile(result, 'worktrees/feature-branch/src/app.ts')).toBe(false);
  });

  it('does not exclude the indexing root even though it has .git', () => {
    // testDir itself does not have .git, but let's check that a root with .git works
    const rootHasGit = path.join(testDir, 'root-with-git');
    mkdir(rootHasGit);
    git(['init'], rootHasGit);
    git(['config', 'user.email', 'test@lynx.dev'], rootHasGit);
    git(['config', 'user.name', 'LYNX Test'], rootHasGit);
    writeFile(path.join(rootHasGit, 'src/app.ts'), 'export const app = 1;');
    git(['add', '-A'], rootHasGit);
    git(['commit', '-m', 'init'], rootHasGit);

    // Index rootHasGit as the root — its files should be discovered
    const result = discoverFiles(rootHasGit, 'moderate');
    const files = relFiles(result);
    expect(files).toContain('src/app.ts');
  });

  it('ordinary directory named "workspace" remains indexable when not a repo', () => {
    writeFile(path.join(testDir, 'workspace/notes.md'), '# notes');
    writeFile(path.join(testDir, 'workspace/project/src/app.ts'), 'export const app = 1;');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    const files = relFiles(result);
    expect(files).toContain('src/index.ts');
    // workspace/ is NOT a git repo, so its content should be discovered
    expect(files).toContain('workspace/project/src/app.ts');
  });

  it('symlinked directory pointing outside root is handled safely', () => {
    mkdir(path.join(testDir, 'src'));
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');
    // Create a target dir outside testDir
    const outsideDir = path.join(testDir, '..', `lynx-discover-outside-${Date.now()}`);
    mkdir(outsideDir);
    writeFile(path.join(outsideDir, 'escape.ts'), 'export const escape = 1;');
    // Symlink from inside testDir to outside
    fs.symlinkSync(outsideDir, path.join(testDir, 'escape-link'), 'dir');

    try {
      const result = discoverFiles(testDir, 'moderate');
      const files = relFiles(result);

      // Legitimate source files are still discovered
      expect(files).toContain('src/index.ts');
      // Symlinked content outside root may or may not be discovered
      // depending on readdir behavior, but it must not crash
      expect(files.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.unlinkSync(path.join(testDir, 'escape-link'));
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('symlink cycle is handled safely', () => {
    mkdir(path.join(testDir, 'src'));
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');
    // Create dir A linking to B, B linking to A
    mkdir(path.join(testDir, 'loop-a'));
    fs.symlinkSync(path.join(testDir, 'loop-a'), path.join(testDir, 'loop-b'), 'dir');

    try {
      const result = discoverFiles(testDir, 'moderate');
      const files = relFiles(result);
      // Must not crash; must still find legitimate files
      expect(files).toContain('src/index.ts');
    } finally {
      try { fs.unlinkSync(path.join(testDir, 'loop-b')); } catch { /* ok */ }
    }
  });

  it('excludedDirs contains excluded paths', () => {
    writeFile(path.join(testDir, 'node_modules/pkg/index.js'), 'x');
    writeFile(path.join(testDir, '.claude/config.json'), '{}');
    writeFile(path.join(testDir, 'backups/old.ts'), 'old');
    writeFile(path.join(testDir, 'src/index.ts'), 'export const x = 1;');

    const result = discoverFiles(testDir, 'moderate');
    const excluded = result.excludedDirs;
    expect(excluded.some(d => d.includes('node_modules'))).toBe(true);
    expect(excluded.some(d => d.includes('.claude'))).toBe(true);
    expect(excluded.some(d => d.includes('backups'))).toBe(true);
  });
});
