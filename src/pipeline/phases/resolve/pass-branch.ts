/*
 * resolve/pass-branch.ts — Git branch detection and HAS_BRANCH edges.
 */

import { execSync } from 'node:child_process';
import type { LynxDatabase } from '../../../store/database.js';
import type { LynxBranch, LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, findCommonRoot, upsertSyntheticNode } from './utils.js';

export function passBranch(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  project: string,
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  let branchName = '';
  let branchQn = '';
  const absPaths = batches.map((b) => b.file.absPath).filter(Boolean);
  const rootDir = absPaths.length > 0 ? findCommonRoot(absPaths) : process.cwd();

  // Guard: only call git if rootDir is inside a git working tree.
  // Avoids `fatal: not a git repository` on stderr for non-git fixtures.
  try {
    execSync('git rev-parse --git-dir', {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return; // Not a git repo — nothing to do
  }

  try {
    branchName = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branchName && branchName !== 'HEAD') {
      branchQn = `${project}.branch.${branchName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    }
  } catch { /* git available but command failed */ }

  if (!branchQn) return;

  const projectNode = idx.allRows.find((r) => r.kind === 'Project');
  const projectId = projectNode?.id;
  if (!projectId) return;

  const branchId = upsertSyntheticNode(db, idx, {
    project,
    kind: 'Branch',
    name: branchName,
    qualifiedName: branchQn,
    filePath: '',
    startLine: 0,
    endLine: 0,
    isExported: false,
    isTest: false,
    isEntryPoint: false,
    branchName,
  } satisfies LynxBranch);

  addEdge(edges, project, projectId, branchId, 'HAS_BRANCH', {
    branchName,
    resolution: 'git-context',
    confidence: 1.0,
  });
}
