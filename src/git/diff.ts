/*
 * diff.ts — Unified git diff file collector.
 *
 * Single source of truth for "which files changed?" consumed by:
 *   - mcp/handlers/assess_impact.ts  (handleAssessImpact)
 *   - mcp/handlers/pack_context.ts   (buildDecisionSummary)
 *   - Future: SACG-019 only_diff_intersect, SACG-027 Blast Radius
 *
 * Covers committed diff (base branch or HEAD~1 fallback), unstaged diff,
 * and git status --porcelain (staged + untracked + renamed).
 */

import * as child_process from 'node:child_process';

export function getModifiedFiles(rootPath: string, baseBranch?: string): string[] {
  const files = new Set<string>();
  const branch = baseBranch || 'main';

  function addFromNameStatus(stdout: string) {
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[0].startsWith('R')) {
        files.add(parts[2].trim());
      } else if (parts.length >= 2) {
        files.add(parts.slice(1).join('\t'));
      }
    }
  }

  // 1. Committed diff vs base branch (or HEAD~1 fallback)
  try {
    try {
      const out = child_process.execFileSync(
        'git', ['diff', '--name-status', `${branch}...HEAD`],
        { cwd: rootPath, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      addFromNameStatus(out);
    } catch {
      try {
        const out = child_process.execFileSync(
          'git', ['diff', '--name-status', 'HEAD~1'],
          { cwd: rootPath, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        addFromNameStatus(out);
      } catch { /* no commits yet */ }
    }
  } catch { /* git not available */ }

  // 2. Unstaged changes
  try {
    const out = child_process.execFileSync(
      'git', ['diff', '--name-only'],
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    for (const f of out.trim().split('\n')) {
      if (f.trim()) files.add(f.trim());
    }
  } catch { /* ignore */ }

  // 3. Staged + untracked + renamed (porcelain status)
  try {
    const out = child_process.execFileSync(
      'git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'],
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    for (const rawLine of out.trim().split('\n')) {
      const line = rawLine.replace(/[\r\n]+$/, '');
      if (line.length < 3) continue;
      let file = line.slice(3).trim();
      const arrow = file.indexOf(' -> ');
      if (arrow > 0) file = file.substring(arrow + 4);
      if (file) files.add(file);
    }
  } catch { /* ignore */ }

  return Array.from(files).sort();
}
