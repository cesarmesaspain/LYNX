/*
 * resolve/pass-heritage.ts — Class/Interface inheritance (INHERITS edges).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, bestByKindAndName, findCommonRoot, getStringArrayProp } from './utils.js';
import { splitTypeList } from './pass-definitions.js';

export function enrichHeritageFromSource(batches: ExtractionBatch[], idx: ResolverIndexes): void {
  const filesToScan = new Map<string, { id: number; kind: string; name: string; qualified_name: string; file_path: string; start_line: number; is_exported: number; properties: string | null }[]>();

  for (const node of idx.allRows) {
    if (node.kind !== 'Class' && node.kind !== 'Interface') continue;
    const propKey = node.kind === 'Interface' ? 'baseInterfaces' : 'baseClasses';
    const existing = getStringArrayProp(node, propKey);
    if (existing.length > 0) continue;
    if (!filesToScan.has(node.file_path)) filesToScan.set(node.file_path, []);
    filesToScan.get(node.file_path)!.push(node);
  }

  if (filesToScan.size === 0) return;

  const absPaths = new Set(batches.map((b) => b.file.absPath).filter(Boolean));
  const rootDir = absPaths.size > 0
    ? findCommonRoot([...absPaths])
    : process.cwd();

  for (const [filePath, nodes] of filesToScan) {
    const fullPath = path.resolve(rootDir, filePath);
    let source: string;
    try { source = fs.readFileSync(fullPath, 'utf-8'); }
    catch { continue; }

    const lines = source.split('\n');

    for (const node of nodes) {
      const lineIdx = (node.start_line || 1) - 1;
      const window = lines.slice(Math.max(0, lineIdx), Math.min(lines.length, lineIdx + 5)).join(' ');
      const bases: string[] = [];
      const ifaces: string[] = [];

      if (node.kind === 'Class') {
        // Handle extends AND/OR implements
        const extendsM = window.match(/\bclass\s+\w+\s+extends\s+([^{]+?)(?:\s+implements\s+|\s*\{)/);
        const implementsM = window.match(/\bclass\s+\w+(?:\s+extends\s+[^{]+?)?\s+implements\s+([^{]+?)\s*\{/);
        if (extendsM?.[1]) bases.push(...splitTypeList(extendsM[1]));
        if (implementsM?.[1]) ifaces.push(...splitTypeList(implementsM[1]));
        const combinedM = window.match(/\bclass\s+\w+\s+extends\s+([^{]+?)\s+implements\s+([^{]+?)\{/);
        if (combinedM) {
          if (combinedM[1] && bases.length === 0) bases.push(...splitTypeList(combinedM[1]));
          if (combinedM[2] && ifaces.length === 0) ifaces.push(...splitTypeList(combinedM[2]));
        }
      } else if (node.kind === 'Interface') {
        const m = window.match(/\binterface\s+\w+\s+extends\s+([^{]+?)\s*\{/);
        if (m?.[1]) ifaces.push(...splitTypeList(m[1]));
      }

      if (bases.length === 0 && ifaces.length === 0) continue;

      let props: Record<string, unknown> = {};
      try { props = JSON.parse(node.properties || '{}'); } catch {}

      if (node.kind === 'Class') {
        props.baseClasses = [...new Set([...getStringArrayProp(node, 'baseClasses'), ...bases])];
      }
      props.baseInterfaces = [...new Set([...getStringArrayProp(node, 'baseInterfaces'), ...ifaces])];
      (node as any).properties = JSON.stringify(props);
    }
  }
}

export function passHeritage(idx: ResolverIndexes, edges: LynxEdge[]): void {
  for (const node of idx.allRows) {
    if (node.kind !== 'Class' && node.kind !== 'Interface') continue;
    const baseNames = node.kind === 'Interface'
      ? getStringArrayProp(node, 'baseInterfaces')
      : [...getStringArrayProp(node, 'baseClasses'), ...getStringArrayProp(node, 'baseInterfaces')];
    const targetKinds = node.kind === 'Interface' ? ['Interface'] : ['Class', 'Interface'];
    for (const baseName of baseNames) {
      const target = bestByKindAndName(idx, node, baseName, targetKinds);
      if (!target || target.id === node.id) continue;
      addEdge(edges, idx.project, node.id, target.id, 'INHERITS', {
        name: baseName, resolution: 'heritage', confidence: target.file_path === node.file_path ? 0.9 : 0.75
      });
    }
  }
}
