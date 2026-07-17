import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadReleaseAsset } from '../../../src/install/release-download.js';
import type { ReleaseAssetV1 } from '../../../src/install/release-manifest.js';

const roots: string[] = [];
const digest = (body: string) => crypto.createHash('sha256').update(body).digest('hex');

function target(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-release-download-'));
  roots.push(root);
  return path.join(root, 'artifact');
}

function asset(body: string): ReleaseAssetV1 {
  return { platform: 'test-x64', url: 'https://example.test/lynx', sha256: digest(body), size: Buffer.byteLength(body) };
}

function responder(body: string, contentLength = Buffer.byteLength(body)): typeof fetch {
  return (async () => new Response(body, {
    status: 200,
    headers: { 'content-length': String(contentLength) },
  })) as typeof fetch;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('bounded release asset download', () => {
  it('publishes only an exact-size exact-hash response', async () => {
    const destination = target();
    await expect(downloadReleaseAsset(asset('trusted'), destination, { fetchImpl: responder('trusted') }))
      .resolves.toBe(destination);
    expect(fs.readFileSync(destination, 'utf8')).toBe('trusted');
  });

  it('rejects contradictory length before creating a published artifact', async () => {
    const destination = target();
    await expect(downloadReleaseAsset(asset('trusted'), destination, { fetchImpl: responder('trusted', 999) }))
      .rejects.toThrow('Content-Length mismatch');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('rejects truncated, oversized and wrong-hash bodies', async () => {
    const truncated = target();
    await expect(downloadReleaseAsset(asset('trusted'), truncated, { fetchImpl: responder('tru', 7) }))
      .rejects.toThrow('was truncated');

    const oversized = target();
    const signed = asset('tiny');
    await expect(downloadReleaseAsset(signed, oversized, { fetchImpl: responder('too large', signed.size) }))
      .rejects.toThrow('exceeded its signed size');

    const wrongHash = target();
    await expect(downloadReleaseAsset({ ...asset('trusted'), sha256: 'a'.repeat(64) }, wrongHash, { fetchImpl: responder('trusted') }))
      .rejects.toThrow('checksum mismatch');
  });

  it('rejects signed assets above the configured resource budget without fetching', async () => {
    const destination = target();
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('x'); }) as typeof fetch;
    await expect(downloadReleaseAsset({ ...asset('x'), size: 101 }, destination, { fetchImpl, maxBytes: 100 }))
      .rejects.toThrow('download limit');
    expect(called).toBe(false);
  });
});
