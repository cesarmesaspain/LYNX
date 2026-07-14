/*
 * discover.ts — Phase 1: File discovery.
 *
 * Walks the repository directory tree, classifies files by extension,
 * and skips excluded paths (node_modules, .git, dist, .next, etc.).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSupportedFilePath } from '../../extraction/language-registry.js';
import type { LynxIndexMode } from '../../types.js';

const ALWAYS_EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.next',
  '.next-build',
  'dist',
  'build',
  'out',
  'obj',
  'target',
  'tmp',
  'temp',
  '.tmp',
  'tmp_build',
  'vendor',
  'vendored',
  'backups',
  'reports',
  'logs',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.nyc_output',
  '.idea',
  '.vscode',
]);

/**
 * Returns true when `dir` is a nested Git repository or linked worktree
 * (i.e. it contains its own `.git` directory or `.git` file) and is not
 * the indexing root itself.
 */
function isNestedGitRepo(dir: string, rootPath: string): boolean {
  if (path.resolve(dir) === path.resolve(rootPath)) return false;
  const gitPath = path.join(dir, '.git');
  try {
    const stat = fs.lstatSync(gitPath);
    // Linked worktrees have a `.git` file; nested repos have a `.git` directory.
    // Use lstat so a symlink to a git dir is treated as a nested repo too.
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

const FAST_EXCLUDE_DIRS = new Set([
  'generated',
  'gen',
  'auto-generated',
  'fixtures',
  'testdata',
  'test_data',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  '__fixtures__',
  '__test__',
  'docs',
  'doc',
  'documentation',
  'examples',
  'example',
  'samples',
  'sample',
  'assets',
  'static',
  'public',
  'media',
  'third_party',
  'thirdparty',
  '3rdparty',
  'external',
  'migrations',
  'seeds',
  'e2e',
  'locale',
  'locales',
  'i18n',
  'l10n',
  'tools',
  'hack',
  'bin',
]);

// Files excluded in fast mode
const FAST_EXCLUDE_EXTS = new Set([
  '.json', '.md', '.mdx', '.css', '.scss', '.svg', '.png', '.jpg',
  '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.lock', '.yaml',
  '.yml', '.toml', '.xml', '.graphql', '.gql', '.env', '.txt',
]);

function loadRootGitignoreDirSkips(rootPath: string): Set<string> {
  const skips = new Set<string>();
  let text = '';
  try {
    text = fs.readFileSync(path.join(rootPath, '.gitignore'), 'utf-8');
  } catch {
    return skips;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.includes('*')) continue;
    const normalized = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized || normalized.includes('.')) continue;
    skips.add(normalized);
  }
  return skips;
}

export interface DiscoveredFile {
  relPath: string;
  absPath: string;
  extension: string;
  size: number;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  excludedDirs: string[];
  mode: LynxIndexMode;
}

/**
 * Walk directory tree and discover all processable files.
 */
export function discoverFiles(
  rootPath: string,
  mode: LynxIndexMode
): DiscoverResult {
  const files: DiscoveredFile[] = [];
  const excludedDirs: string[] = [];
  const gitignoreDirSkips = loadRootGitignoreDirSkips(rootPath);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied, skip
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        const shouldSkip =
          ALWAYS_EXCLUDE.has(entry.name) ||
          entry.name.startsWith('.') ||
          isNestedGitRepo(fullPath, rootPath) ||
          gitignoreDirSkips.has(rel) ||
          gitignoreDirSkips.has(entry.name) ||
          (mode === 'fast' && FAST_EXCLUDE_DIRS.has(entry.name));

        if (shouldSkip) {
          excludedDirs.push(rel);
          continue;
        }
        // Skip directories that start with _ in fast mode (private modules)
        // but not in moderate/full
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Size check: skip files > 10MB
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 10 * 1024 * 1024) continue;
        } catch {
          continue;
        }

        // Fast mode: skip non-code files
        if (mode === 'fast' && FAST_EXCLUDE_EXTS.has(ext)) {
          continue;
        }

        // Check if extension or special filename is supported.
        if (isSupportedFilePath(entry.name) || isSupportedFilePath(rel)) {
          let size = 0;
          try { size = fs.statSync(fullPath).size; } catch { /* keep 0 */ }
          files.push({
            relPath: rel,
            absPath: fullPath,
            extension: ext,
            size,
          });
        }
      }
    }
  }

  walk(rootPath);

  // Sort files for deterministic ordering
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { files, excludedDirs, mode };
}
