import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseReleaseManifest,
  selectReleaseAsset,
  verifyReleaseManifest,
} from '../../../src/install/release-manifest.js';

function fixture(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schema: 'lynx.release-manifest.v1',
    version: 'v1.2.3',
    createdAt: '2026-07-17T20:00:00.000Z',
    assets: [{
      platform: 'darwin-arm64',
      url: 'https://github.com/example/lynx/releases/download/v1.2.3/lynx-darwin-arm64',
      sha256: 'a'.repeat(64),
      size: 12345,
    }],
    ...overrides,
  }));
}

describe('signed release manifest', () => {
  it('verifies exact bytes with an Ed25519 key before parsing assets', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = fixture();
    const signature = crypto.sign(null, raw, privateKey).toString('base64');

    const manifest = verifyReleaseManifest(raw, signature, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    expect(selectReleaseAsset(manifest, 'darwin-arm64').size).toBe(12345);
  });

  it('rejects a manifest changed after signing', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = fixture();
    const signature = crypto.sign(null, raw, privateKey).toString('base64');
    const changed = Buffer.from(raw.toString().replace('v1.2.3', 'v1.2.4'));

    expect(() => verifyReleaseManifest(changed, signature, publicKey.export({ type: 'spki', format: 'pem' }).toString()))
      .toThrow('signature verification failed');
  });

  it('rejects duplicate platforms, insecure URLs and invalid digests', () => {
    const asset = {
      platform: 'linux-x64',
      url: 'http://example.com/lynx',
      sha256: 'bad',
      size: 1,
    };
    expect(() => parseReleaseManifest(fixture({ assets: [asset] }))).toThrow('must use HTTPS');
    expect(() => parseReleaseManifest(fixture({ assets: [{ ...asset, url: 'https://example.com/lynx' }] }))).toThrow('invalid SHA-256');
    const valid = { ...asset, url: 'https://example.com/lynx', sha256: 'b'.repeat(64) };
    expect(() => parseReleaseManifest(fixture({ assets: [valid, valid] }))).toThrow('duplicate platform');
  });

  it('fails closed when the running platform is absent', () => {
    const manifest = parseReleaseManifest(fixture());
    expect(() => selectReleaseAsset(manifest, 'windows-x64')).toThrow('no unique asset');
  });
});
