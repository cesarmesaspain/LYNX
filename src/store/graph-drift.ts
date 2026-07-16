
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readGitHead } from '../git/context.js';
import type { LynxDatabase, ProjectMetadata } from './database.js';

export type GraphDriftStatus = 'clean' | 'drifted' | 'unknown';

export interface GraphDriftReport {
  status: GraphDriftStatus;
  indexed_commit: string | null;
  current_commit: string | null;
  head_changed: boolean;
  working_tree_changed: boolean;
  changed_files_count: number;
  changed_files: string[];
  checked_files: number;
  duration_ms: number;
  note: string;
}

interface FileHashMetadataRow {
  rel_path: string;
  mtime_ns: number;
  size: number;
}

export function detectGraphDrift(
  db: LynxDatabase,
  meta: ProjectMetadata,
  sampleLimit = 20,
): GraphDriftReport {
  const started = Date.now();
  const currentCommit = readGitHead(meta.rootPath);
  const rows = db.db
    .prepare('SELEC rel_path, mtime_ns, size FROM file_hashes WHERE project = ? ORDER BY rel_path')
    .all(meta.name) as FileHashMetadataRow[];
  const changedFiles: string[] = [];
  let incompleteMetadata = rows.length === 0;

  for (const row of rows) {
    const absPath = path.resolve(meta.rootPath, row.rel_path);
    const relative = path.relative(meta.rootPath, absPath);
    let changed = relative.startsWith('..') || path.isAbsolute(relative);
    if (!changed) {
      try {
        const stat = fs.statSync(absPath);
        const mtimeNs = Math.floor(stat.mtimeMs * 1_000_000);
        changed = stat.size !== row.size
          || (row.mtime_ns > 0 && Math.abs(mtimeNs - row.mtime_ns) > 1_000_000);
        if (row.mtime_ns <= 0) incompleteMetadata = true;
      } catch {
        changed = true;
      }
    }
    if (changed && changedFiles.length < sampleLimit) changedFiles.push(row.rel_path);
  }

  const headChanged = Boolean(meta.indexedCommit && currentCommit && meta.indexedCommit !== currentCommit);
  const workingTreeChanged = changedFiles.length > 0;
  let status: GraphDriftStatus = 'clean';
  if (headChanged || workingTreeChanged) status = 'drifted';
  else if (!meta.indexedCommit || !currentCommit || incompleteMetadata) status = 'unknown';

  const note = status === 'drifted'
    ? 'Index differs from HEAD or indexed file metadata.'
    : status === 'clean'
      ? 'Indexed commit and file metadata match the current working tree.'
      : 'Drift could not be fully verified; re-index to establish a fresh baseline.';

  return {
    status,
    indexed_commit: meta.indexedCommit,
    current_commit: currentCommit,
    head_changed: headChanged,
    working_tree_changed: workingTreeChanged,
    changed_files_count: changedFiles.length,
    changed_files: changedFiles,
    checked_files: rows.length,
    duration_ms: Date.now() - started,
    note,
  };
}

