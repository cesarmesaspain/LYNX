import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installDistributionArtifact, type DistributionReceipt } from './distribution.js';
import { downloadReleaseAsset } from './release-download.js';
import { selectReleaseAsset, verifyReleaseManifest } from './release-manifest.js';

export interface ReleaseUpgradeRequest {
  manifestUrl: string;
  signatureUrl: string;
  publicKeyPem: string;
  destinationPath: string;
  platform?: string;
  fetchImpl?: typeof fetch;
  accept: (installedPath: string) => Promise<void>;
  maxArtifactBytes?: number;
}

export function currentReleasePlatform(platform = process.platform, arch = process.arch): string {
  const osName = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : null;
  const archName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!osName || !archName) throw new Error(`Unsupported release platform: ${platform}-${arch}.`);
  return `${osName}-${archName}`;
}

async function fetchTrustDocument(url: string, fetchImpl: typeof fetch, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Release trust documents must use HTTPS.');
  const response = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/octet-stream' } });
  if (!response.ok) throw new Error(`Release trust document download failed with HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > maxBytes) throw new Error(`Release trust document size must be between 1 and ${maxBytes} bytes.`);
  return body;
}

/** Compose trust verification, bounded download and atomic publication. */
export async function upgradePackagedDistribution(request: ReleaseUpgradeRequest): Promise<DistributionReceipt> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchTrustDocument(request.manifestUrl, fetchImpl, 1024 * 1024),
    fetchTrustDocument(request.signatureUrl, fetchImpl, 16 * 1024),
  ]);
  const manifest = verifyReleaseManifest(manifestBytes, signatureBytes.toString('utf8'), request.publicKeyPem);
  const asset = selectReleaseAsset(manifest, request.platform ?? currentReleasePlatform());
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-upgrade-'));
  try {
    const artifactPath = path.join(tempRoot, 'lynx-artifact');
    await downloadReleaseAsset(asset, artifactPath, {
      fetchImpl,
      maxBytes: request.maxArtifactBytes,
    });
    return await installDistributionArtifact({
      artifactPath,
      destinationPath: request.destinationPath,
      expectedSha256: asset.sha256,
      version: manifest.version,
      accept: request.accept,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
