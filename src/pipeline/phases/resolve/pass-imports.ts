/*
 * resolve/pass-imports.ts — IMPORTS edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, resolveImportTargets, resolveImportToModuleKey } from './utils.js';

export function passImports(batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    for (const imp of batch.result.imports) {
      const moduleKey = resolveImportToModuleKey(imp.modulePath, batch.file.relPath);
      const importedFile = idx.moduleToFileNode.get(moduleKey);
      if (importedFile && importedFile.id !== fileNode.id) {
        addEdge(edges, idx.project, fileNode.id, importedFile.id, 'IMPORTS', {
          localName: imp.localName,
          modulePath: imp.modulePath,
          resolution: 'module',
          confidence: 0.95,
        });
      }

      const targets = resolveImportTargets(idx, batch.file.relPath, moduleKey, imp.localName);

      // Index resolved imports so the CALLS pass can disambiguate callees
      // by where they're actually imported — eliminates name-collision false positives.
      let importedQns = idx.importedQnByFile.get(batch.file.relPath);
      if (!importedQns) {
        importedQns = new Set();
        idx.importedQnByFile.set(batch.file.relPath, importedQns);
      }
      for (const target of targets) {
        importedQns.add(target.qualified_name);
      }

      for (const target of targets.slice(0, 4)) {
        if (target.id === fileNode.id) continue;
        addEdge(edges, idx.project, fileNode.id, target.id, 'IMPORTS', {
          localName: imp.localName,
          modulePath: imp.modulePath,
          resolution: target.file_path === batch.file.relPath ? 'local-name' : 'module-export',
          confidence: target.file_path === batch.file.relPath ? 0.65 : 0.9,
        });
      }
    }
  }
}
