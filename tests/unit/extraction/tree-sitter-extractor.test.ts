import { describe, expect, it } from 'vitest';
import { extractFile } from '../../../src/extraction/extractor.js';

describe('tree-sitter JavaScript definition identity', () => {
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
});
