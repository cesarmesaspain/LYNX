import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passRegistryDispatch } from '../../../src/pipeline/phases/resolve/pass-registry-dispatch.js';
import type { LynxEdge } from '../../../src/types.js';
import {
  createEmptyIndexes, getEdgesByType, makeBatch, makeEmptyResult, makeFileNode,
  makeFuncNode, populateIndex, resetIdCounter,
} from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('passRegistryDispatch', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('adds low-confidence labelled candidates for a static local handler registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-registry-'));
    tempDirs.push(dir);
    const sourcePath = path.join(dir, 'runtime.ts');
    fs.writeFileSync(sourcePath, [
      'const nodeRegistry = {',
      '  email: sendEmail,',
      '  delay: sleep,',
      '};',
      'async function runScenario() {',
      '  await nodeRegistry[node.type](node);',
      '}',
    ].join('\n'));

    const file = makeFileNode(1, 'src/runtime.ts');
    const caller = makeFuncNode(2, 'runScenario', 'src/runtime.ts');
    const sendEmail = makeFuncNode(3, 'sendEmail', 'src/runtime.ts');
    const sleep = makeFuncNode(4, 'sleep', 'src/runtime.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [file, caller, sendEmail, sleep]);
    const result = {
      ...makeEmptyResult(),
      calls: [{ calleeName: 'nodeRegistry[node.type]', enclosingFuncQn: 'runtime.runScenario', args: [], startLine: 6, loopDepth: 0 }],
    };
    const edges: LynxEdge[] = [];

    passRegistryDispatch([makeBatch('src/runtime.ts', sourcePath, result)], idx, edges);

    const dispatches = getEdgesByType(edges, 'REGISTRY_DISPATCH');
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((edge) => edge.targetId).sort()).toEqual([3, 4]);
    expect(dispatches.every((edge) => edge.properties.confidence === 0.35)).toBe(true);
    expect(dispatches.every((edge) => String(edge.properties.note).includes('Probable dynamic dispatch'))).toBe(true);
  });
});
