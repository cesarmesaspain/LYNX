/*
 * context.ts — Git metadata extraction.
 *
 * Reads HEAD SHA, branch name, and basic git context.
 * Non-destructive, read-only.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitContext {
  branch: string;
  headSha: string;
  isGit: boolean;
  rootPath: string;
}

let cachedContext: GitContext | null = null;

/**
 * Get git context for a directory. Cached after first call.
 */
export function getGitContext(repoPath: string): GitContext | null {
  if (cachedContext && cachedContext.rootPath === repoPath) {
    return cachedContext;
  }

  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) return null;

  try {
    const headSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    cachedContext = {
      branch,
      headSha,
      isGit: true,
      rootPath: repoPath,
    };
    return cachedContext;
  } catch {
    return null;
  }
}

/**
 * Get file churn data (how many times each file has changed).
 * Returns top N most-churned files.
 */
export function getFileChurn(
  repoPath: string,
  topN = 20
): { filePath: string; changeCount: number }[] {
  try {
    const output = execSync(
      `git log --all --name-only --format=format: | sort | uniq -c | sort -rn | head -${topN}`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
        if (match) {
          return { changeCount: parseInt(match[1], 10), filePath: match[2] };
        }
        return null;
      })
      .filter((x): x is { filePath: string; changeCount: number } => x !== null);
  } catch {
    return [];
  }
}
