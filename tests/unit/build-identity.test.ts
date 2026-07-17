import { describe, expect, it } from 'vitest';
import { getBuildIdentity } from '../../src/build-identity.js';

describe('LYNX build identity', () => {
  it('uses the real package version and preserves verified build metadata', () => {
    const identity = getBuildIdentity({
      LYNX_BUILD_COMMIT: 'abcdef1234567',
      LYNX_DISTRIBUTION_SHA256: 'a'.repeat(64),
      LYNX_NATIVE_CORE_SHA256: 'b'.repeat(64),
      LYNX_BUILD_TIMESTAMP: '2026-07-17T20:00:00.000Z',
    });
    expect(identity.version).toBe('0.2.0');
    expect(identity.sourceCommit).toBe('abcdef1234567');
    expect(identity.distributionSha256).toBe('a'.repeat(64));
    expect(identity.nativeCoreSha256).toBe('b'.repeat(64));
    expect(identity.builtAt).toBe('2026-07-17T20:00:00.000Z');
    expect(identity.runtime).toBe('source');
  });

  it('reports missing or malformed provenance as unknown instead of inventing it', () => {
    const identity = getBuildIdentity({
      LYNX_BUILD_COMMIT: 'not-a-commit',
      LYNX_DISTRIBUTION_SHA256: 'short',
      LYNX_BUILD_TIMESTAMP: 'yesterday',
    });
    expect(identity.sourceCommit).toBeNull();
    expect(identity.distributionSha256).toBeNull();
    expect(identity.nativeCoreSha256).toBeNull();
    expect(identity.builtAt).toBeNull();
  });
});
