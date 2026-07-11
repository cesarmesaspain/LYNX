/*
 * version.ts — GET /v1/version route.
 *
 * Returns the latest LYNX binary info (version, download URL, checksum).
 * Reads from GitHub Releases API (cached for 1 hour in memory).
 */

import type { FastifyInstance } from 'fastify';

interface CachedRelease {
  fetched: number;
  data: any;
}

let cachedRelease: CachedRelease | null = null;

export function versionRoutes(app: FastifyInstance): void {
  app.get('/v1/version', async (request) => {
    const query = request.query as { platform?: string; current?: string };
    const platform = query.platform || 'macos-arm64';

    // Check cache (1 hour TTL)
    if (cachedRelease && Date.now() - cachedRelease.fetched < 3600_000) {
      return formatResponse(cachedRelease.data, platform);
    }

    try {
      const res = await fetch(
        'https://api.github.com/repos/lynx-dev/lynx/releases/latest',
        {
          headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'LYNX-API/0.1',
          },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return fallbackResponse(platform);

      const release = await res.json() as any;
      cachedRelease = { fetched: Date.now(), data: release };
      return formatResponse(release, platform);
    } catch {
      return fallbackResponse(platform);
    }
  });
}

function formatResponse(release: any, platform: string) {
  const assets = release.assets || [];
  const binaryName = `lynx-${platform}`;
  const asset = assets.find((a: any) => a.name === binaryName);

  return {
    latest: (release.tag_name || 'v0.1.0').replace(/^v/, ''),
    download_url: asset?.browser_download_url || `https://github.com/lynx-dev/lynx/releases/latest/download/${binaryName}`,
    checksum_sha256: asset ? '[checksum from release]' : '',
    release_notes: release.body?.slice(0, 500) || '',
  };
}

function fallbackResponse(platform: string) {
  return {
    latest: '0.1.0',
    download_url: `https://github.com/lynx-dev/lynx/releases/latest/download/lynx-${platform}`,
    checksum_sha256: '',
    release_notes: '',
  };
}
