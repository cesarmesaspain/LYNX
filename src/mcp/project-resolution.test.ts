import { describe, expect, it } from 'vitest';
import { normalizeProjectArgs } from './server.js';
import { resolveProjectReference } from './project-resolution.js';

const projects = [
  // Fixture kept deliberately independent from the local persistent index.
  { name: 'LYNX', rootPath: '/tmp/lynx-project', indexedAt: '2026-07-12', status: 'ready', statusError: null, nodeCount: 1 },
  { name: 'OTHER', rootPath: '/tmp/other-project', indexedAt: '2026-07-12', status: 'ready', statusError: null, nodeCount: 1 },
];

describe('project reference resolution', () => {
  it('keeps canonical project names unchanged', () => {
    expect(resolveProjectReference('LYNX', projects)).toEqual({ resolved: true, project: 'LYNX', matchedBy: 'name' });
  });

  it('canonicalizes a differently cased project name', () => {
    expect(resolveProjectReference('lynx', projects)).toEqual({
      resolved: true, project: 'LYNX', matchedBy: 'name',
    });
  });

  it('chooses the newest canonical identity when legacy aliases share a root', () => {
    expect(resolveProjectReference('/tmp/lynx-project', [
      ...projects,
      { name: 'lynx', rootPath: '/tmp/lynx-project', indexedAt: '2026-07-13', status: 'ready', statusError: null, nodeCount: 1 },
    ])).toEqual({ resolved: true, project: 'lynx', matchedBy: 'root_path' });
  });

  it('resolves an indexed root path to its canonical project name', () => {
    expect(resolveProjectReference('/tmp/lynx-project/', projects)).toEqual({ resolved: true, project: 'LYNX', matchedBy: 'root_path' });
  });

  it('prefers an explicit absolute root over legacy relative-root indexes', () => {
    expect(resolveProjectReference('/tmp/lynx-project', [
      ...projects,
      { name: 'legacy-run', rootPath: '.', indexedAt: '2026-07-12', status: 'ready', statusError: null, nodeCount: 1 },
    ])).toEqual({ resolved: true, project: 'LYNX', matchedBy: 'root_path' });
  });

  it('does not guess from an unqualified basename', () => {
    expect(resolveProjectReference('lynx-project', projects)).toEqual({ resolved: false, project: 'lynx-project' });
  });

  it('rejects a root path for destructive deletion', () => {
    expect(normalizeProjectArgs('delete_project', { project: '/tmp/lynx-project' })).toMatchObject({
      error: expect.stringContaining('canonical project name'),
    });
  });
});
