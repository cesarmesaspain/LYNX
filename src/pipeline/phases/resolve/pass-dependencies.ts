/*
 * resolve/pass-dependencies.ts — DEPENDS_ON edges from package manifests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LynxDatabase } from '../../../store/database.js';
import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, findCommonRoot, upsertDependencyNode } from './utils.js';

export function passDependencies(
  db: LynxDatabase,
  batches: ExtractionBatch[],
  idx: ResolverIndexes,
  edges: LynxEdge[]
): void {
  const absPaths = new Set(batches.map((b) => b.file.absPath).filter(Boolean));
  const rootDir = absPaths.size > 0 ? findCommonRoot([...absPaths]) : process.cwd();

  const projectNode = idx.allRows.find((r) => r.kind === 'Project');
  const projectId = projectNode?.id;
  if (!projectId) return;

  for (const depFile of ['package.json', 'requirements.txt']) {
    const fullPath = path.resolve(rootDir, depFile);
    let source: string;
    try { source = fs.readFileSync(fullPath, 'utf-8'); }
    catch { continue; }

    if (depFile === 'package.json') {
      try {
        const pkg = JSON.parse(source);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const depName of Object.keys(deps)) {
          const depId = upsertDependencyNode(db, idx, depName, String(deps[depName]), 'npm', depFile);
          addEdge(edges, idx.project, projectId, depId, 'DEPENDS_ON', {
            package: depName,
            version: deps[depName],
            ecosystem: 'npm',
            file: depFile,
            confidence: 0.9,
          });
        }
      } catch { /* invalid JSON */ }
    } else if (depFile === 'requirements.txt') {
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const pkgName = trimmed.split(/[=<>~!\[\s]/)[0].trim();
        if (pkgName) {
          const depId = upsertDependencyNode(db, idx, pkgName, trimmed, 'pypi', depFile);
          addEdge(edges, idx.project, projectId, depId, 'DEPENDS_ON', {
            package: pkgName,
            ecosystem: 'pypi',
            file: depFile,
            confidence: 0.85,
          });
        }
      }
    }
  }
}
