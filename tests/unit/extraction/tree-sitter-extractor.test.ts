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
});
