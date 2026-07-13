import { describe, expect, it } from 'vitest';
import { restoreNativeEntryPointFlags } from '../../../src/pipeline/phases/extract.js';

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
