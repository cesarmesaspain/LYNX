/*
 * project-resolution.ts — Resolve MCP project references to canonical names.
 *
 * MCP tools historically accepted the project DB name only. Agents naturally
 * pass a repository root path, so read-only tools accept either form and
 * normalize paths before dispatching to their existing handlers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanIndexedProjects, type IndexedProject } from './project-catalog.js';

export type ProjectResolution =
  | { resolved: true; project: string; matchedBy: 'name' | 'root_path' }
  | { resolved: false; project: string };

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectReference(
  input: string,
  projects: IndexedProject[] = scanIndexedProjects(),
): ProjectResolution {
  const project = input.trim();
  const byName = projects.find(candidate => candidate.name === project);
  if (byName) return { resolved: true, project: byName.name, matchedBy: 'name' };

  // Do not guess from a basename: two indexed repositories may share one.
  if (!path.isAbsolute(project)) return { resolved: false, project };

  // Prefer an explicitly stored absolute root. Historical benchmark indexes
  // may store ".", which resolves to the server cwd but is not the same
  // project reference an MCP client supplied.
  const explicitAbsoluteMatches = projects.filter(candidate =>
    path.isAbsolute(candidate.rootPath) && path.normalize(candidate.rootPath) === path.normalize(project),
  );
  if (explicitAbsoluteMatches.length === 1) {
    return { resolved: true, project: explicitAbsoluteMatches[0].name, matchedBy: 'root_path' };
  }

  const normalizedInput = normalizedPath(project);
  const matches = projects.filter(candidate => normalizedPath(candidate.rootPath) === normalizedInput);
  if (matches.length === 1) {
    return { resolved: true, project: matches[0].name, matchedBy: 'root_path' };
  }
  return { resolved: false, project };
}
