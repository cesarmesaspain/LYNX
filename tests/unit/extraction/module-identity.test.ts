import { describe, expect, it } from 'vitest';
import { extractFile } from '../../../src/extraction/extractor.js';
import {
  baseModuleQn,
  buildModuleIdentityMap,
  effectiveModuleQn,
  moduleIdentityForPath,
} from '../../../src/extraction/module-identity.js';

describe('physical module identity', () => {
  it('preserves historical module names when they do not collide', () => {
    const identities = buildModuleIdentityMap([
      'src/lib/service.ts',
      'src/lib/other.swift',
    ]);

    expect(moduleIdentityForPath(identities, 'src/lib/service.ts')).toBe('lib.service');
    expect(moduleIdentityForPath(identities, 'src/lib/other.swift')).toBe('lib.other');
  });

  it('keeps same-stem C headers and sources distinct without suffixing the source', () => {
    const identities = buildModuleIdentityMap(['src/store.h', 'src/store.c']);

    expect(moduleIdentityForPath(identities, 'src/store.c')).toBe('store');
    expect(
      effectiveModuleQn(
        moduleIdentityForPath(identities, 'src/store.h'),
        'src/store.h',
      ),
    ).toBe('store.__header');
  });

  it('adds stable extension discriminators only when effective identities collide', () => {
    const identities = buildModuleIdentityMap([
      'native/lynx_ts_extractor.c',
      'native/lynx_ts_extractor.swift',
    ]);

    expect(
      moduleIdentityForPath(identities, 'native/lynx_ts_extractor.c'),
    ).toBe('native.lynx_ts_extractor.__c');
    expect(
      moduleIdentityForPath(identities, 'native/lynx_ts_extractor.swift'),
    ).toBe('native.lynx_ts_extractor.__swift');
  });

  it('keeps colliding same-extension module identities unique and deterministic', () => {
    const forward = buildModuleIdentityMap([
      'src/lib.ts',
      'src/lib/index.ts',
    ]);
    const reverse = buildModuleIdentityMap([
      'src/lib/index.ts',
      'src/lib.ts',
    ]);

    const direct = moduleIdentityForPath(forward, 'src/lib.ts');
    const indexed = moduleIdentityForPath(forward, 'src/lib/index.ts');

    expect(direct).not.toBe(indexed);
    expect(moduleIdentityForPath(reverse, 'src/lib.ts')).toBe(direct);
    expect(moduleIdentityForPath(reverse, 'src/lib/index.ts')).toBe(indexed);
  });

  it('normalizes root and src index modules compatibly', () => {
    expect(baseModuleQn('src/index.ts')).toBe('src');
    expect(baseModuleQn('src/lib/index.ts')).toBe('lib');
  });

  it('requires extractFile to honor the explicit physical module identity', async () => {
    const result = await extractFile(
      'export function work() { return true; }',
      'fixture',
      'src/work.ts',
      'work.__ts',
    );

    expect(
      result.nodes.some((node) => node.qualifiedName === 'work.__ts.work'),
    ).toBe(true);
  });
});
