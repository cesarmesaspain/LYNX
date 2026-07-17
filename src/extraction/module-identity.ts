/*
 * module-identity.ts — Canonical physical module identity.
 *
 * Semantic import keys intentionally omit file extensions. Graph node identities
 * need one additional guarantee: two source files must never emit the same
 * qualified names. We preserve historical names for non-colliding files and add
 * a stable extension discriminator only when effective module identities collide.
 */

import { Buffer } from 'node:buffer';
import * as path from 'node:path';

const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx']);

function normalizedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Historical extensionless module name, before language-specific decoration. */
export function baseModuleQn(filePath: string): string {
  const normalized = normalizedPath(filePath);
  const extension = path.posix.extname(normalized);
  const withoutExt = extension ? normalized.slice(0, -extension.length) : normalized;
  const parts = withoutExt.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length > 1 && parts.at(-1) === 'index') parts.pop();
  if (parts.length > 1 && parts[0] === 'src') parts.shift();
  return parts.join('.') || path.posix.basename(withoutExt) || 'root';
}

export function isHeaderFilePath(filePath: string): boolean {
  return HEADER_EXTENSIONS.has(path.posix.extname(normalizedPath(filePath)).toLowerCase());
}

/**
 * Apply extractor-level decoration to a physical module identity.
 * Native C/C++ receives the undecorated base and applies this same header scope
 * internally; tree-sitter uses this helper directly.
 */
export function effectiveModuleQn(moduleQn: string, filePath: string): string {
  return isHeaderFilePath(filePath) ? `${moduleQn}.__header` : moduleQn;
}

function extensionDiscriminator(filePath: string): string {
  const extension = path.posix.extname(normalizedPath(filePath)).toLowerCase().replace(/^\./, '');
  const sanitized = extension.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'source';
}

function pathDiscriminator(filePath: string): string {
  return Buffer.from(normalizedPath(filePath), 'utf8').toString('base64url');
}

/**
 * Build deterministic physical identities from the complete discovered file set.
 * Only files whose effective historical identities collide receive suffixes.
 */
export function buildModuleIdentityMap(filePaths: Iterable<string>): Map<string, string> {
  const entries = [...new Set([...filePaths].map(normalizedPath))].sort().map((filePath) => {
    const base = baseModuleQn(filePath);
    return {
      filePath,
      base,
      effective: effectiveModuleQn(base, filePath),
      discriminator: extensionDiscriminator(filePath),
    };
  });
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = groups.get(entry.effective);
    if (group) group.push(entry);
    else groups.set(entry.effective, [entry]);
  }

  const identities = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      identities.set(group[0].filePath, group[0].base);
      continue;
    }

    const candidates = group.map((entry) => ({
      entry,
      identity: `${entry.base}.__${entry.discriminator}`,
    }));
    const candidateCounts = new Map<string, number>();
    for (const { identity } of candidates) {
      candidateCounts.set(identity, (candidateCounts.get(identity) ?? 0) + 1);
    }
    for (const { entry, identity } of candidates) {
      identities.set(
        entry.filePath,
        candidateCounts.get(identity) === 1
          ? identity
          : `${identity}_${pathDiscriminator(entry.filePath)}`,
      );
    }
  }
  return identities;
}

export function moduleIdentityForPath(
  identities: ReadonlyMap<string, string>,
  filePath: string,
): string {
  const normalized = normalizedPath(filePath);
  return identities.get(normalized) ?? baseModuleQn(normalized);
}
