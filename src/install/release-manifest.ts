import * as crypto from 'node:crypto';

export interface ReleaseAssetV1 {
  platform: string;
  url: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifestV1 {
  schema: 'lynx.release-manifest.v1';
  version: string;
  createdAt: string;
  assets: ReleaseAssetV1[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Release manifest field ${field} must be a non-empty string.`);
  return value;
}

export function parseReleaseManifest(raw: Buffer): ReleaseManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Release manifest is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release manifest root must be an object.');
  const record = value as Record<string, unknown>;
  if (record.schema !== 'lynx.release-manifest.v1') throw new Error('Unsupported release manifest schema.');
  const version = requireString(record.version, 'version');
  const createdAt = requireString(record.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Release manifest createdAt must be an ISO timestamp.');
  if (!Array.isArray(record.assets) || record.assets.length === 0) throw new Error('Release manifest must contain at least one asset.');

  const seen = new Set<string>();
  const assets = record.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new Error(`Release asset ${index} must be an object.`);
    const item = asset as Record<string, unknown>;
    const platform = requireString(item.platform, `assets[${index}].platform`);
    if (seen.has(platform)) throw new Error(`Release manifest contains duplicate platform ${platform}.`);
    seen.add(platform);
    const url = requireString(item.url, `assets[${index}].url`);
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { throw new Error(`Release asset ${platform} has an invalid URL.`); }
    if (parsedUrl.protocol !== 'https:') throw new Error(`Release asset ${platform} must use HTTPS.`);
    const sha256 = requireString(item.sha256, `assets[${index}].sha256`).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Release asset ${platform} has an invalid SHA-256 digest.`);
    if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0) {
      throw new Error(`Release asset ${platform} must declare a positive integer size.`);
    }
    return { platform, url, sha256, size: item.size };
  });
  return { schema: 'lynx.release-manifest.v1', version, createdAt, assets };
}

/** Verify the exact downloaded manifest bytes before trusting any contained URL or digest. */
export function verifyReleaseManifest(
  raw: Buffer,
  signatureBase64: string,
  publicKeyPem: string,
): ReleaseManifestV1 {
  let signature: Buffer;
  try { signature = Buffer.from(signatureBase64.trim(), 'base64'); } catch { throw new Error('Release manifest signature is not valid base64.'); }
  if (signature.length === 0 || !crypto.verify(null, raw, publicKeyPem, signature)) {
    throw new Error('Release manifest signature verification failed.');
  }
  return parseReleaseManifest(raw);
}

export function selectReleaseAsset(manifest: ReleaseManifestV1, platform: string): ReleaseAssetV1 {
  const matches = manifest.assets.filter(asset => asset.platform === platform);
  if (matches.length !== 1) throw new Error(`Release ${manifest.version} has no unique asset for ${platform}.`);
  return matches[0];
}
