import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256File } from './distribution.js';
import type { ReleaseAssetV1 } from './release-manifest.js';

export interface ReleaseDownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Download one signed-manifest asset with strict streaming bounds. */
export async function downloadReleaseAsset(
  asset: ReleaseAssetV1,
  destinationPath: string,
  options: ReleaseDownloadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  if (asset.size > maxBytes) throw new Error(`Release asset exceeds the ${maxBytes}-byte download limit.`);
  const destination = path.resolve(destinationPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  let fd: number | null = null;
  try {
    const response = await (options.fetchImpl ?? fetch)(asset.url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/octet-stream' },
    });
    if (!response.ok) throw new Error(`Release download failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error('Release download returned no response body.');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== asset.size) {
      throw new Error(`Release download Content-Length mismatch: expected ${asset.size}, got ${contentLength}.`);
    }

    fd = fs.openSync(partial, 'wx', 0o600);
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > asset.size || received > maxBytes) {
        await reader.cancel();
        throw new Error(`Release download exceeded its signed size of ${asset.size} bytes.`);
      }
      fs.writeSync(fd, value);
    }
    fs.closeSync(fd);
    fd = null;
    if (received !== asset.size) throw new Error(`Release download was truncated: expected ${asset.size}, got ${received}.`);
    const digest = sha256File(partial);
    if (digest !== asset.sha256) throw new Error(`Release download checksum mismatch: expected ${asset.sha256}, got ${digest}.`);
    fs.renameSync(partial, destination);
    return destination;
  } finally {
    clearTimeout(timer);
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(partial, { force: true });
  }
}
