import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFile } from '../../../src/extraction/extractor.js';

describe('tree-sitter JavaScript definition identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps same-stem C header prototypes distinct from source definitions', async () => {
    const header = await extractFile(
      'int store_open(const char *path);', 'fixture', 'src/store/store.h', 'src.store.store',
    );
    const source = await extractFile(
      'int store_open(const char *path) { return 1; }', 'fixture', 'src/store/store.c', 'src.store.store',
    );
    const headerFn = header.nodes.find((node) => node.kind === 'Function' && node.name === 'store_open');
    const sourceFn = source.nodes.find((node) => node.kind === 'Function' && node.name === 'store_open');

    expect(headerFn).toBeDefined();
    expect(sourceFn).toBeDefined();
    expect(headerFn!.qualifiedName).not.toBe(sourceFn!.qualifiedName);
    expect(headerFn!.qualifiedName).toContain('.__header.');
  });

  it('keeps root index symbols qualified and does not promote arrow parameters', async () => {
    const result = await extractFile(
      `const decamelize = string => string.toLowerCase();
       export function slugifyWithCounter() { return decamelize('A'); }`,
      'fixture',
      'index.js',
      'index',
    );

    const qualifiedNames = result.nodes.map((node) => node.qualifiedName);
    expect(qualifiedNames).toContain('index.decamelize');
    expect(qualifiedNames).toContain('index.slugifyWithCounter');
    expect(qualifiedNames).not.toContain('index.string');
    expect(qualifiedNames.every((name) => !name.startsWith('.'))).toBe(true);
  });

  it('attributes calls and usages to their nearest function in one scoped walk', async () => {
    const result = await extractFile(
      `const sharedValue = 1;
       function outerFunction() {
         helperFunction(sharedValue);
       }
       function helperFunction(inputValue) { return inputValue; }`,
      'fixture',
      'scopes.js',
      'scopes',
    );

    expect(result.calls).toContainEqual(expect.objectContaining({
      calleeName: 'helperFunction',
      enclosingFuncQn: 'scopes.outerFunction',
    }));
    expect(result.usages).toContainEqual(expect.objectContaining({
      refName: 'sharedValue',
      enclosingFuncQn: 'scopes.outerFunction',
    }));
  });

  it('marks conventional root test files and all of their nodes as tests', async () => {
    const result = await extractFile(
      `function helper() { return true; }
       helper();`,
      'fixture',
      'test.js',
      'test',
    );

    expect(result.isTestFile).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.every((node) => node.isTest)).toBe(true);
  });

  it('does not promote TypeScript local values to top-level definitions', async () => {
    const result = await extractFile(
      `async function load(response: Response) {
         const json = (await response.json()) as { ok: boolean };
         const key = json.ok ? 'ok' : 'missing';
         const callback = () => key;
         return callback();
       }`,
      'fixture',
      'sample.ts',
      'sample',
    );

    const names = result.nodes.map((node) => node.name);
    expect(names).not.toContain('json');
    expect(names).not.toContain('key');
    expect(names).not.toContain('callback');
  });

  it('marks the index module as an entry point', async () => {
    const result = await extractFile(
      'export function main() { return true; }',
      'fixture',
      'src/index.ts',
      'index',
    );

    expect(result.nodes.find(node => node.kind === 'Module')).toMatchObject({
      filePath: 'src/index.ts',
      isEntryPoint: true,
    });
  });

  it('extracts a same-file TypeScript call from a multiline async function', async () => {
    const result = await extractFile(
      `export async function runScenarioDev(input: { flowKey: string }): Promise<void> {
         await executeNode(input.flowKey);
       }
       async function executeNode(flowKey: string): Promise<void> { }
      `,
      'fixture',
      'src/scenarioRuntimeDev.ts',
      'scenarioRuntimeDev',
    );

    expect(result.calls).toContainEqual(expect.objectContaining({
      calleeName: 'executeNode',
      enclosingFuncQn: 'scenarioRuntimeDev.runScenarioDev',
    }));
  });

  it('caps dense usage extraction without losing definitions or calls', async () => {
    vi.stubEnv('LYNX_MAX_USAGES_PER_FILE', '2');
    const result = await extractFile(
      `function target() { return true; }
       function run() { const alpha = target(); return alpha + beta + gamma; }`,
      'fixture',
      'dense.js',
      'dense',
    );

    expect(result.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(['target', 'run']));
    expect(result.calls).toContainEqual(expect.objectContaining({ calleeName: 'target' }));
    expect(result.usages).toHaveLength(2);
    expect(result.partialReasons).toEqual(['usage extraction capped at 2 unique references']);
  });

  it('keeps generated files visible without expanding their generated semantics', async () => {
    const result = await extractFile(
      `/* Automatically @generated by tree-sitter */
       static int generated_helper(void) { return generated_call(); }`,
      'fixture',
      'vendor/parser.c',
      'vendor.parser',
    );

    expect(result.nodes.map((node) => node.kind)).toEqual(['File', 'Module']);
    expect(result.calls).toEqual([]);
    expect(result.partialReasons).toEqual([
      'automatically generated source: semantic extraction skipped',
    ]);
  });

  it('does not treat generated-code phrases in executable source as metadata', async () => {
    const result = await extractFile(
      `const generatedByPattern = /generated by/i;
       const warningPattern = /do not edit/i;
       export function inspectSource() { return generatedByPattern.test('input') && warningPattern.test('input'); }`,
      'fixture',
      'src/generated-detector.ts',
      'generated-detector',
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Function', name: 'inspectSource' }),
    ]));
    expect(result.partialReasons).toBeUndefined();
  });

  it('ignores generated notices that appear after executable source begins', async () => {
    const result = await extractFile(
      `export function retained() { return true; }
       // Generated by a downstream tool. Do not edit its output.
       export function alsoRetained() { return retained(); }`,
      'fixture',
      'src/with-late-notice.ts',
      'with-late-notice',
    );

    expect(result.nodes.map((node) => node.name)).toEqual(
      expect.arrayContaining(['retained', 'alsoRetained']),
    );
    expect(result.partialReasons).toBeUndefined();
  });

  it('extracts C preprocessor includes as structural imports', async () => {
    const result = await extractFile(
      '#include "api/client.h"\nint run(void) { return client_open(); }',
      'fixture',
      'src/run.c',
      'src.run',
    );

    expect(result.imports).toContainEqual(expect.objectContaining({ modulePath: 'api/client.h' }));
  });

  it('normalizes a Rust crate use to a relative module import', async () => {
    const result = await extractFile(
      'use crate::mathlib::twice;\nfn run() -> i32 { twice(21) }',
      'fixture',
      'main.rs',
      'main',
    );

    expect(result.imports).toContainEqual({
      localName: 'twice',
      modulePath: './mathlib',
      startLine: 1,
    });
  });

  it('keeps the method name in a qualified Java invocation', async () => {
    const result = await extractFile(
      'class App { static int run() { return MathLib.twice(21); } }',
      'fixture',
      'golden/App.java',
      'golden.App',
    );

    expect(result.calls).toContainEqual(expect.objectContaining({
      calleeName: 'MathLib.twice',
      enclosingFuncQn: expect.stringContaining('.run'),
    }));
  });
});
