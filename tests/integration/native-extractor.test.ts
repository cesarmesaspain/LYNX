import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { LynxDatabase } from '../../src/store/database.js';
import { runPipeline } from '../../src/pipeline/orchestrator.js';
import { getNativeExtractorPath } from '../../src/paths.js';
import type { ExtractionResult } from '../../src/extraction/extractor.js';

interface NativeResult {
  id: number;
  file: Record<string, unknown>;
  sha256: string;
  result: ExtractionResult;
  skipped?: boolean;
}

function spawnNativeExtractor(input: string): Promise<string> {
  const binaryPath = getNativeExtractorPath();
  if (!binaryPath) throw new Error('Native extractor binary not available');

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf-8'));
      else reject(new Error(Buffer.concat(errChunks).toString('utf-8') || `exit ${code}`));
    });
    child.stdin.end(input);
  });
}

describe('Native extractor integration', () => {
  const hasNative = !!getNativeExtractorPath();
  const testPrefix = hasNative ? '[native]' : '[native:SKIP]';

  it(`${testPrefix} binary exists and produces valid JSON for a simple TS file`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsPath = path.join(dir, 'sample.ts');
      fs.writeFileSync(tsPath, "export function add(a: number, b: number): number {\n  return a + b;\n}\n");

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'sample.ts', absPath: tsPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed).toHaveLength(1);
      const r = parsed[0];
      expect(r.result.hasError).toBe(false);
      expect(r.result.nodes.length).toBeGreaterThanOrEqual(2); // File + Module + Function
      const funcNode = r.result.nodes.find(n => n.name === 'add');
      expect(funcNode).toBeDefined();
      expect(funcNode!.kind).toBe('Function');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`${testPrefix} extracts imports correctly`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsPath = path.join(dir, 'consumer.ts');
      fs.writeFileSync(tsPath, "import { add } from './math.js';\nexport const result = add(1, 2);\n");

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'consumer.ts', absPath: tsPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed[0].result.hasError).toBe(false);
      expect(parsed[0].result.imports.length).toBeGreaterThan(0);
      const importEdge = parsed[0].result.imports.find(i => i.localName === 'add');
      expect(importEdge).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`${testPrefix} extracts call edges`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsPath = path.join(dir, 'fn.ts');
      fs.writeFileSync(tsPath, "export function greet(name: string): string {\n  return `Hello ${format(name)}`;\n}\n\nfunction format(s: string): string {\n  return s.trim();\n}\n");

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'fn.ts', absPath: tsPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed[0].result.hasError).toBe(false);
      const calls = parsed[0].result.calls;
      const formatCall = calls.find(c => c.calleeName === 'format');
      expect(formatCall).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`${testPrefix} pipeline uses native extractor and produces consistent results vs WASM fallback`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'),
        "export { add } from './math.js';\n");
      fs.writeFileSync(path.join(dir, 'src', 'math.ts'),
        "export function add(a: number, b: number): number {\n  const result = a + b;\n  return result;\n}\n");

      // Run with native extractor
      const dbNative = LynxDatabase.openMemory();
      const resultNative = await runPipeline(dbNative, dir, 'native', {
        mode: 'fast',
        testSkipProjectBrief: true,
      });

      // Run without native extractor (force WASM/JS fallback)
      const oldDisable = process.env.LYNX_DISABLE_NATIVE;
      process.env.LYNX_DISABLE_NATIVE = '1';
      let resultFallback;
      try {
        const dbFallback = LynxDatabase.openMemory();
        resultFallback = await runPipeline(dbFallback, dir, 'fallback', {
          mode: 'fast',
          testSkipProjectBrief: true,
        });
        dbFallback.close();
      } finally {
        if (oldDisable !== undefined) {
          process.env.LYNX_DISABLE_NATIVE = oldDisable;
        } else {
          delete process.env.LYNX_DISABLE_NATIVE;
        }
      }

      // Both paths should produce nodes and edges
      expect(resultNative.status.totalNodes).toBeGreaterThan(0);
      expect(resultFallback.status.totalNodes).toBeGreaterThan(0);
      expect(resultNative.status.totalEdges).toBeGreaterThan(0);
      expect(resultFallback.status.totalEdges).toBeGreaterThan(0);

      // Node and edge counts should be in similar range (allow minor differences
      // between native and WASM extractors)
      const nodeRatio = resultNative.status.totalNodes / resultFallback.status.totalNodes;
      expect(nodeRatio).toBeGreaterThan(0.5);
      expect(nodeRatio).toBeLessThan(2.0);

      dbNative.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it(`${testPrefix} native extractor handles TypeScript generics and interfaces`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsPath = path.join(dir, 'generic.ts');
      fs.writeFileSync(tsPath, [
        'export interface Box<T> {',
        '  value: T;',
        '}',
        '',
        'export class Container<T> implements Box<T> {',
        '  value: T;',
        '  constructor(value: T) {',
        '    this.value = value;',
        '  }',
        '  getValue(): T {',
        '    return this.value;',
        '  }',
        '}',
        '',
        'export function identity<T>(x: T): T {',
        '  return x;',
        '}',
      ].join('\n'));

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'generic.ts', absPath: tsPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed[0].result.hasError).toBe(false);

      const nodeNames = parsed[0].result.nodes.map(n => n.name);
      expect(nodeNames).toContain('Box');
      expect(nodeNames).toContain('Container');
      expect(nodeNames).toContain('identity');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`${testPrefix} native extractor handles JSX/TSX syntax`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsxPath = path.join(dir, 'component.tsx');
      fs.writeFileSync(tsxPath, [
        'import React from "react";',
        '',
        'interface Props {',
        '  name: string;',
        '}',
        '',
        'export function Greeting({ name }: Props): JSX.Element {',
        '  return <div>Hello {name}</div>;',
        '}',
        '',
        'export default function App(): JSX.Element {',
        '  return <Greeting name="World" />;',
        '}',
      ].join('\n'));

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'component.tsx', absPath: tsxPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed[0].result.hasError).toBe(false);

      const funcNames = parsed[0].result.nodes
        .filter(n => n.kind === 'Function')
        .map(n => n.name);
      expect(funcNames).toContain('Greeting');
      expect(funcNames).toContain('App');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`${testPrefix} native extractor extracts usage edges`, async () => {
    if (!hasNative) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    try {
      const tsPath = path.join(dir, 'usage.ts');
      fs.writeFileSync(tsPath,
        "export const API_URL = 'https://api.example.com';\n" +
        "export function fetchData(): void {\n  console.log(API_URL);\n}\n"
      );

      const input = JSON.stringify([
        { id: 0, project: 'test', relPath: 'usage.ts', absPath: tsPath },
      ]);
      const output = await spawnNativeExtractor(input);
      const parsed = JSON.parse(output) as NativeResult[];
      expect(parsed[0].result.hasError).toBe(false);
      expect(parsed[0].result.usages.length).toBeGreaterThan(0);
      const apiUsage = parsed[0].result.usages.find(u => u.refName === 'API_URL');
      expect(apiUsage).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pipeline gracefully falls back when LYNX_DISABLE_NATIVE=1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-int-'));
    const db = LynxDatabase.openMemory();
    const oldDisable = process.env.LYNX_DISABLE_NATIVE;
    process.env.LYNX_DISABLE_NATIVE = '1';
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');

      const result = await runPipeline(db, dir, 'fallback-test', {
        mode: 'fast',
        testSkipProjectBrief: true,
      });
      expect(result.status.totalNodes).toBeGreaterThan(0);
      expect(result.status.status).toBe('ready');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (oldDisable !== undefined) {
        process.env.LYNX_DISABLE_NATIVE = oldDisable;
      } else {
        delete process.env.LYNX_DISABLE_NATIVE;
      }
    }
  }, 15000);
});
