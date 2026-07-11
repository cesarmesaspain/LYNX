/*
 * resolve/pass-usages.ts — USAGE/READS/WRITES edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { NodeRef, ResolverIndexes } from './indexes.js';
import { usageSkip, lowSignalGlobalUsage, symbolKinds } from './constants.js';
import {
  addEdge, resolveCaller, resolveImportToModuleKey,
  preferSameFile, preferSamePackage, usageEdgeType,
} from './utils.js';

function buildImportMapForFile(
  batch: ExtractionBatch,
  idx: ResolverIndexes
): Map<string, string> {
  const impMap = new Map<string, string>();
  for (const imp of batch.result.imports) {
    const moduleKey = resolveImportToModuleKey(imp.modulePath, batch.file.relPath);
    const exports = idx.exportedByModule.get(moduleKey) || [];
    const match = exports.find((node) => symbolKinds.has(node.kind));
    if (match) impMap.set(imp.localName, match.qualified_name);
  }
  return impMap;
}

type ResolvedUsage = { target: NodeRef; strategy: 'import-map' | 'same-file' | 'unique-name' | 'same-package' };

function resolveUsageWithImportMap(
  idx: ResolverIndexes,
  filePath: string,
  refName: string,
  sourceId: number,
  impMap: Map<string, string>
): ResolvedUsage | undefined {
  const isGeneric = lowSignalGlobalUsage.has(refName);

  // Strategy 1: import_map lookup — explicit import is strong evidence.
  // Applies to ALL names (including generic) because the import proves intent.
  const importQn = impMap.get(refName);
  if (importQn) {
    const importId = idx.qnToId.get(importQn);
    if (importId && importId !== sourceId) {
      const importRow = idx.idToRow.get(importId);
      if (importRow) return { target: importRow, strategy: 'import-map' };
    }
  }

  // Build candidates once for strategies 2-4
  const candidates = (idx.nameToRows.get(refName) || [])
    .filter((node) => node.id !== sourceId && symbolKinds.has(node.kind));

  // Strategy 2: same-file — strong evidence for ALL names (including generic).
  const sameFile = preferSameFile(candidates, filePath);
  if (sameFile) return { target: sameFile, strategy: 'same-file' };

  // Strategy 3: unique_name — only for non-generic names.
  // Generic names never resolve via unique-name heuristic (too ambiguous).
  if (!isGeneric && candidates.length === 1) {
    return { target: candidates[0], strategy: 'unique-name' };
  }

  // Strategy 4: same-package — only for non-generic names.
  // Generic names at package level are still too ambiguous without import or same-file evidence.
  if (!isGeneric) {
    const samePkg = preferSamePackage(candidates, filePath);
    if (samePkg) return { target: samePkg, strategy: 'same-package' };
  }

  return undefined;
}

// Confidence per resolution strategy.
// import-map and same-file are explicit structural evidence → 0.85.
// unique-name (single global match) is moderate evidence → 0.70.
// same-package (fuzzy directory match) is weaker evidence → 0.55.
const STRATEGY_CONFIDENCE: Record<ResolvedUsage['strategy'], number> = {
  'import-map': 0.85,
  'same-file': 0.85,
  'unique-name': 0.70,
  'same-package': 0.55,
};

export function passUsages(batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const batch of batches) {
    const impMap = buildImportMapForFile(batch, idx);
    for (const usage of batch.result.usages) {
      if (usageSkip.has(usage.refName)) continue;
      const source = resolveCaller(idx, batch.file.relPath, usage.enclosingFuncQn);
      if (!source) continue;

      const resolved = resolveUsageWithImportMap(idx, batch.file.relPath, usage.refName, source.id, impMap);
      if (!resolved) continue;

      const type = usage.isWrite ? 'WRITES' : usageEdgeType(usage.refName, resolved.target);
      const confidence = STRATEGY_CONFIDENCE[resolved.strategy];
      addEdge(edges, idx.project, source.id, resolved.target.id, type, {
        refName: usage.refName,
        line: usage.startLine,
        resolution: resolved.strategy,
        confidence,
      });
    }
  }
}
