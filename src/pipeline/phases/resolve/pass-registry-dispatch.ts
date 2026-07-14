/* Infer low-confidence dynamic dispatch through local TypeScript handler maps. */
import * as fs from 'node:fs';
import type { LynxEdge } from '../../../types.js';
import type { ExtractionBatch } from '../extract.js';
import type { ResolverIndexes } from './indexes.js';
import { addEdge, resolveCallee, resolveCaller } from './utils.js';

const REGISTRY = /\b(?:const|let)\s+([A-Za-z_$][\w$]*(?:handlers|registry|dispatch|map)[\w$]*)\s*=\s*\{([\s\S]{0,12000}?)\n?\s*\};/gi;
const ENTRY = /(?:^|[,\n])\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;

export function passRegistryDispatch(
  batches: ExtractionBatch[], idx: ResolverIndexes, edges: LynxEdge[],
): void {
  for (const batch of batches) {
    if (!/\.(?:ts|tsx|js|jsx)$/.test(batch.file.relPath)) continue;
    let source = '';
    try { source = fs.readFileSync(batch.file.absPath, 'utf8'); } catch { continue; }
    const registries = new Map<string, string[]>();
    REGISTRY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REGISTRY.exec(source))) {
      const targets: string[] = [];
      ENTRY.lastIndex = 0;
      let entry: RegExpExecArray | null;
      while ((entry = ENTRY.exec(match[2]))) targets.push(entry[1]);
      if (targets.length) registries.set(match[1], [...new Set(targets)]);
    }
    if (!registries.size) continue;
    for (const call of batch.result.calls) {
      const registry = [...registries.keys()].find((name) => call.calleeName.startsWith(`${name}[`));
      if (!registry) continue;
      const caller = resolveCaller(idx, batch.file.relPath, call.enclosingFuncQn);
      if (!caller) continue;
      for (const targetName of registries.get(registry) || []) {
        const target = resolveCallee(idx, batch.file.relPath, targetName);
        if (!target || target.node.id === caller.id) continue;
        addEdge(edges, idx.project, caller.id, target.node.id, 'REGISTRY_DISPATCH', {
          registry, line: call.startLine, resolution: 'static-registry-pattern', confidence: 0.35,
          note: 'Probable dynamic dispatch; validate with runtime trace when material.',
        });
      }
    }
  }
}
