import { describe, expect, it } from 'vitest';
import { restoreNativeEntryPointFlags, selectExtractionWorkerCount } from '../../../src/pipeline/phases/extract.js';

describe('native extraction normalization', () => {
  it('restores the conventional entry-point mark on native index modules', () => {
    const nodes = [
      { kind: 'File', isEntryPoint: false },
      { kind: 'Module', isEntryPoint: false },
      { kind: 'Function', isEntryPoint: false },
    ] as any;

    restoreNativeEntryPointFlags(nodes, 'src/index.ts');

    expect(nodes).toEqual([
      { kind: 'File', isEntryPoint: false },
      { kind: 'Module', isEntryPoint: true },
      { kind: 'Function', isEntryPoint: false },
    ]);
  });

  it('does not mark ordinary native modules as entry points', () => {
    const nodes = [{ kind: 'Module', isEntryPoint: false }] as any;

    restoreNativeEntryPointFlags(nodes, 'src/service.ts');

    expect(nodes[0].isEntryPoint).toBe(false);
  });
});

describe('extraction worker selection', () => {
  it('uses sixty percent of available parallelism by default', () => {
    expect(selectExtractionWorkerCount(100, 0, 8)).toBe(5);
    expect(selectExtractionWorkerCount(100, 0, 32)).toBe(20);
  });

  it('honors explicit workers while capping by tasks and available parallelism', () => {
    expect(selectExtractionWorkerCount(3, 12, 16)).toBe(3);
    expect(selectExtractionWorkerCount(100, 12, 16)).toBe(12);
  });

  it('normalizes invalid and fractional inputs safely', () => {
    expect(selectExtractionWorkerCount(0, Number.NaN, 0)).toBe(1);
    expect(selectExtractionWorkerCount(9.8, 2.9, 4.9)).toBe(2);
  });
});
