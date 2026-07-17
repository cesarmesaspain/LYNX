/*
 * resolve/pass-tests.ts — TESTS and TESTS_FILE edges.
 */

import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, getFileNode, resolveImportedFile } from './utils.js';

function isTestPath(filePath: string): boolean {
  const base = filePath.split('/').pop() || filePath;
  return (
    base.startsWith('test_') ||
    filePath.includes('__tests__/') ||
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    filePath.startsWith('tests/') ||
    filePath.startsWith('test/') ||
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    /_test\.[^.]+$/.test(filePath) ||
    /_spec\.[^.]+$/.test(filePath) ||
    /(?:Test|Spec)\.[^.]+$/.test(filePath)
  );
}

function isTestFunctionName(name: string): boolean {
  return (
    name === 'test' ||
    name === 'it' ||
    name === 'describe' ||
    name.startsWith('test_') ||
    /^test[A-Z]/.test(name) ||
    /^Test(?:[A-Z]|$)/.test(name) ||
    /^Benchmark(?:[A-Z]|$)/.test(name) ||
    /^Example(?:[A-Z]|$)/.test(name)
  );
}

function testToProdPath(filePath: string): string | undefined {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const base = filePath.split('/').pop() || filePath;
  const prefix = dir ? `${dir}/` : '';

  if (base.startsWith('test_') && base.endsWith('.py')) {
    return `${prefix}${base.slice(5)}`;
  }

  const suffixMatch = base.match(/^(.+?)(?:_test|_spec)(\.[^.]+)$/);
  if (suffixMatch) {
    return `${prefix}${suffixMatch[1]}${suffixMatch[2]}`;
  }

  const dotMatch = base.match(/^(.+?)\.(?:test|spec)\.(.+)$/);
  if (dotMatch) {
    return `${prefix}${dotMatch[1]}.${dotMatch[2]}`;
  }

  const classMatch = base.match(/^(.+?)(?:Test|Spec)(\.[^.]+)$/);
  if (classMatch) {
    return `${prefix}${classMatch[1]}${classMatch[2]}`;
  }
  return undefined;
}

export function passTests(batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const batch of batches) {
    const fileNode = getFileNode(idx, batch.file.relPath);
    if (!fileNode) continue;

    if (batch.result.isTestFile) {
      for (const imp of batch.result.imports) {
        const importedFile = resolveImportedFile(idx, imp.modulePath, batch.file.relPath);
        if (importedFile && importedFile.id !== fileNode.id) {
          addEdge(edges, idx.project, fileNode.id, importedFile.id, 'TESTS_FILE', {
            modulePath: imp.modulePath,
            resolution: 'test-import',
            confidence: 0.9,
          });
        }
      }

      const prodPath = testToProdPath(batch.file.relPath);
      const prodFile = prodPath ? getFileNode(idx, prodPath) : undefined;
      if (prodFile && prodFile.id !== fileNode.id) {
        addEdge(edges, idx.project, fileNode.id, prodFile.id, 'TESTS_FILE', {
          resolution: 'test-name-convention',
          confidence: 0.95,
        });
      }
    }
  }

  const callEdges = edges.filter((edge) => edge.type === 'CALLS');
  for (const edge of callEdges) {
    const source = idx.idToRow.get(edge.sourceId);
    const target = idx.idToRow.get(edge.targetId);
    if (!source || !target) continue;
    // A production helper can legitimately have a test-like name. File
    // location is authoritative; the name only adjusts confidence below.
    if (!isTestPath(source.file_path)) continue;
    if (isTestPath(target.file_path) || isTestFunctionName(target.name)) continue;

    addEdge(edges, idx.project, source.id, target.id, 'TESTS', {
      resolution: 'test-call',
      confidence: isTestFunctionName(source.name) ? 0.95 : 0.8,
    });
  }
}
