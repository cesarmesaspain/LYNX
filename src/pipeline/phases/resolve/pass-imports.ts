/*
 * resolve/pass-imports.ts — IMPORTS edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import {
  addEdge,
  getFileNode,
  resolveGoPackageFiles,
  resolveImportedFile,
  resolveImportTargets,
  resolveImportToModuleKey,
} from './utils.js';
import { symbolKinds } from './constants.js';

export function passImports(batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    for (const imp of batch.result.imports) {
      const moduleKey = resolveImportToModuleKey(imp.modulePath, batch.file.relPath);
      const goPackageFiles = /\.go$/i.test(batch.file.relPath)
        ? resolveGoPackageFiles(idx, imp.modulePath)
        : [];
      const importedFile = goPackageFiles[0] || resolveImportedFile(idx, imp.modulePath, batch.file.relPath);
      const importedFiles = goPackageFiles.length > 0 ? goPackageFiles : importedFile ? [importedFile] : [];
      for (const targetFile of importedFiles) {
        if (targetFile.id === fileNode.id) continue;
        addEdge(edges, idx.project, fileNode.id, targetFile.id, 'IMPORTS', {
          localName: imp.localName,
          modulePath: imp.modulePath,
          resolution: goPackageFiles.length > 0 ? 'go-package' : 'module',
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

      // JVM imports commonly bind a class while calls target a static method
      // on that class. The extractor keeps the method name, so make callables
      // from the resolved class file visible without exposing unrelated files.
      if (importedFile && /\.(?:java|kt|kts)$/i.test(batch.file.relPath)) {
        for (const target of idx.fileToNodes.get(importedFile.file_path) || []) {
          if (target.kind === 'Function' || target.kind === 'Method') {
            importedQns.add(target.qualified_name);
          }
        }
      }

      // Go imports expose an entire package directory. The module prefix in
      // go.mod is intentionally irrelevant here: the conservative suffix
      // resolver returns files only when one local package directory wins.
      if (goPackageFiles.length > 0) {
        for (const packageFile of goPackageFiles) {
          for (const target of idx.fileToNodes.get(packageFile.file_path) || []) {
            if (symbolKinds.has(target.kind)) importedQns.add(target.qualified_name);
          }
        }
      }

      // C/C++ includes import a header namespace, not one JS-style local
      // binding. Make every symbol declared by that resolved header reachable
      // for the later CALLS pass while keeping the visible IMPORTS edge at file
      // level. This mirrors compiler/LSP header lookup without fabricating one
      // import edge per declaration.
      if (importedFile && /\.(?:h|hh|hpp|hxx)$/i.test(importedFile.file_path)) {
        for (const target of idx.fileToNodes.get(importedFile.file_path) || []) {
          if (!symbolKinds.has(target.kind)) continue;
          importedQns.add(target.qualified_name);
          if (target.kind === 'Function' || target.kind === 'Method') {
            const implementations = (idx.nameToRows.get(target.name) || []).filter((candidate) =>
              (candidate.kind === 'Function' || candidate.kind === 'Method') &&
              !/\.(?:h|hh|hpp|hxx)$/i.test(candidate.file_path) &&
              /\.(?:c|cc|cpp|cxx|m|mm)$/i.test(candidate.file_path),
            );
            if (implementations.length === 1) importedQns.add(implementations[0].qualified_name);
          }
        }
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
