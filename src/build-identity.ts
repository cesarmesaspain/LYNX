import { isPkg, readAsset } from './paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LynxBuildIdentity {
  schema: 'lynx.build-identity.v1';
  version: string;
  sourceCommit: string | null;
  distributionSha256: string | null;
  nativeCoreSha256: string | null;
  builtAt: string | null;
  runtime: 'packaged' | 'source';
}

function packageVersion(): string {
  const candidates: Array<Buffer | null> = [];
  try { candidates.push(fs.readFileSync(path.join(process.cwd(), 'package.json'))); } catch { /* not a source checkout */ }
  candidates.push(readAsset('package.json'));
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { name?: unknown; version?: unknown };
      if (parsed.name === 'lynx' && typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch { /* try the next authoritative candidate */ }
  }
  return 'unknown';
}

function optionalMatch(value: string | undefined, pattern: RegExp): string | null {
  const normalized = value?.trim();
  return normalized && pattern.test(normalized) ? normalized : null;
}

export function getBuildIdentity(env: NodeJS.ProcessEnv = process.env): LynxBuildIdentity {
  const builtAt = env.LYNX_BUILD_TIMESTAMP?.trim();
  return {
    schema: 'lynx.build-identity.v1',
    version: packageVersion(),
    sourceCommit: optionalMatch(env.LYNX_BUILD_COMMIT, /^[a-f0-9]{7,64}$/i),
    distributionSha256: optionalMatch(env.LYNX_DISTRIBUTION_SHA256, /^[a-f0-9]{64}$/i),
    nativeCoreSha256: optionalMatch(env.LYNX_NATIVE_CORE_SHA256, /^[a-f0-9]{64}$/i),
    builtAt: builtAt && Number.isFinite(Date.parse(builtAt)) ? builtAt : null,
    runtime: isPkg() ? 'packaged' : 'source',
  };
}
