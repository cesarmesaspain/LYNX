import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LynxDatabase } from '../../../src/store/database.js';
import { runPipeline } from '../../../src/pipeline/orchestrator.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIN = 1;

type Metrics = { precision: number; recall: number; f1: number; fp: string[]; fn: string[] };

function score(expected: readonly string[], actual: readonly string[]): Metrics {
  const truth = new Set(expected);
  const observed = new Set(actual);
  const tp = [...observed].filter(value => truth.has(value)).length;
  const fp = [...observed].filter(value => !truth.has(value)).sort();
  const fn = [...truth].filter(value => !observed.has(value)).sort();
  const precision = observed.size ? tp / observed.size : truth.size ? 0 : 1;
  const recall = truth.size ? tp / truth.size : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, fp, fn };
}

const cases = [
  {
    language: 'typescript',
    fixture: 'typescript',
    nodes: ['Function:main.ts:run', 'Function:math.ts:add', 'Function:math.ts:twice'],
    relations: ['CALLS:main.ts:run->math.ts:twice', 'CALLS:math.ts:twice->math.ts:add', 'IMPORTS:main.ts->math.ts'],
  },
  {
    language: 'c',
    fixture: 'c',
    nodes: ['Function:main.c:run', 'Function:math.c:add', 'Function:math.c:twice'],
    relations: ['CALLS:main.c:run->math.c:twice', 'CALLS:math.c:twice->math.c:add', 'IMPORTS:main.c->math.h', 'IMPORTS:math.c->math.h'],
  },
] as const;

describe('per-language golden truth sets', () => {
  for (const golden of cases) {
    it(`${golden.language}: precision, recall and F1`, async () => {
      const db = LynxDatabase.openMemory();
      const project = `golden-${golden.language}`;
      try {
        await runPipeline(db, path.join(ROOT, golden.fixture), project, { mode: 'fast', testSkipProjectBrief: true });

        const nodeRows = db.db.prepare(`
          SELECT kind, file_path, name FROM nodes
          WHERE project = ? AND kind IN ('Function', 'Method') AND file_path NOT LIKE '%.h'
          ORDER BY file_path, name
        `).all(project) as Array<{ kind: string; file_path: string; name: string }>;
        const actualNodes = nodeRows.map(n => `${n.kind}:${n.file_path}:${n.name}`);

        const edgeRows = db.db.prepare(`
          SELECT e.type, s.file_path source_file, s.name source_name,
                 t.file_path target_file, t.name target_name
          FROM edges e
          JOIN nodes s ON s.id = e.source_id AND s.project = e.project
          JOIN nodes t ON t.id = e.target_id AND t.project = e.project
          WHERE e.project = ? AND e.type IN ('CALLS', 'IMPORTS')
          ORDER BY e.type, source_file, source_name, target_file, target_name
        `).all(project) as Array<{ type: string; source_file: string; source_name: string; target_file: string; target_name: string }>;
        const actualRelations = edgeRows.map(e => e.type === 'CALLS'
          ? `CALLS:${e.source_file}:${e.source_name}->${e.target_file}:${e.target_name}`
          : `IMPORTS:${e.source_file}->${e.target_file}`);

        const nodes = score(golden.nodes, actualNodes);
        const relations = score(golden.relations, actualRelations);
        console.info(JSON.stringify({ language: golden.language, nodes, relations }, null, 2));

        expect(nodes.fp, `node FP: ${JSON.stringify(nodes.fp)}`).toEqual([]);
        expect(nodes.fn, `node FN: ${JSON.stringify(nodes.fn)}`).toEqual([]);
        expect(relations.fp, `relation FP: ${JSON.stringify(relations.fp)}`).toEqual([]);
        expect(relations.fn, `relation FN: ${JSON.stringify(relations.fn)}`).toEqual([]);
        for (const metrics of [nodes, relations]) {
          expect(metrics.precision).toBeGreaterThanOrEqual(MIN);
          expect(metrics.recall).toBeGreaterThanOrEqual(MIN);
          expect(metrics.f1).toBeGreaterThanOrEqual(MIN);
        }
      } finally {
        db.close();
      }
    }, 30000);
  }
});
