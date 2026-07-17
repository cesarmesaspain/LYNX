import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentReleasePlatform, upgradePackagedDistribution } from '../../../src/install/release-client.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('trusted release upgrade composition', () => {
  it('verifies trust, downloads exactly and publishes through runtime acceptance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-release-client-'));
    roots.push(root);
    const destination = path.join(root, 'bin', 'lynx');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'v1');
    const artifact = Buffer.from('v2-binary');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const manifest = Buffer.from(JSON.stringify({
      schema: 'lynx.release-manifest.v1',
      version: 'v2',
      createdAt: '2026-07-17T20:00:00.000Z',
      assets: [{
        platform: 'darwin-arm64',
        url: 'https://release.test/lynx',
        sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
        size: artifact.length,
      }],
    }));
    const signature = crypto.sign(null, manifest, privateKey).toString('base64');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return new Response(manifest);
      if (url.endsWith('manifest.sig')) return new Response(signature);
      if (url.endsWith('/lynx')) return new Response(artifact, { headers: { 'content-length': String(artifact.length) } });
      return new Response('missing', { status: 404 });
    }) as typeof fetch;

    const receipt = await upgradePackagedDistribution({
      manifestUrl: 'https://release.test/manifest.json',
      signatureUrl: 'https://release.test/manifest.sig',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      destinationPath: destination,
      platform: 'darwin-arm64',
      fetchImpl,
      accept: async installed => expect(fs.readFileSync(installed)).toEqual(artifact),
    });

    expect(receipt.version).toBe('v2');
    expect(fs.readFileSync(destination)).toEqual(artifact);
    expect(fs.readFileSync(`${destination}.previous`, 'utf8')).toBe('v1');
  });

  it('maps only explicitly supported release platforms', () => {
    expect(currentReleasePlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(currentReleasePlatform('linux', 'x64')).toBe('linux-x64');
    expect(currentReleasePlatform('win32', 'x64')).toBe('windows-x64');
    expect(() => currentReleasePlatform('freebsd', 'x64')).toThrow('Unsupported');
  });
});
