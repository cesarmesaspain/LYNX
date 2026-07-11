/*
 * detect_changes.test.ts — Unit tests for detect_changes pure functions.
 *
 * Tests: parseGitStatus, normalizeRequestedFiles, canonicalizeAndDeduplicatePaths,
 * classifyGitEntries, filterPrimaryScope, classifyImpactEvidence,
 * deduplicateRelatedDependencies.
 * All pure — no git, no filesystem, no LYNX DB.
 */

import { describe, it, expect } from 'vitest';
import {
  parseGitStatus,
  normalizeRequestedFiles,
  canonicalizeAndDeduplicatePaths,
  classifyGitEntries,
  filterPrimaryScope,
  classifyImpactEvidence,
  deduplicateRelatedDependencies,
  isGitWorkTree,
} from '../../../src/mcp/handlers/detect_changes.js';
import type { GitStatusEntry, CanonicalChange, RelatedDependency } from '../../../src/mcp/handlers/detect_changes.js';

// ═══════════════════════════════════════════════════════════════
// parseGitStatus
// ═══════════════════════════════════════════════════════════════

describe('parseGitStatus', () => {
  it('parses --name-status staged modified (M)', () => {
    const r = parseGitStatus('M\tsrc/index.ts');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('staged');
    expect(r!.file).toBe('src/index.ts');
  });

  it('parses --name-status added (A)', () => {
    const r = parseGitStatus('A\tsrc/new.ts');
    expect(r!.kind).toBe('staged');
    expect(r!.file).toBe('src/new.ts');
  });

  it('parses --name-status deleted (D)', () => {
    const r = parseGitStatus('D\told.ts');
    expect(r!.kind).toBe('deleted');
    expect(r!.file).toBe('old.ts');
  });

  it('parses --name-status renamed (R with old→new)', () => {
    const r = parseGitStatus('R100\told.ts\tnew.ts');
    expect(r!.kind).toBe('renamed');
    expect(r!.file).toBe('new.ts');
    expect((r as Extract<GitStatusEntry, { kind: 'renamed' }>).oldPath).toBe('old.ts');
  });

  it('parses porcelain untracked (??)', () => {
    const r = parseGitStatus('?? newfile.ts');
    expect(r!.kind).toBe('untracked');
    expect(r!.file).toBe('newfile.ts');
  });

  it('parses porcelain staged modified (M_)', () => {
    const r = parseGitStatus('M  src/index.ts');
    expect(r!.kind).toBe('staged');
    expect(r!.file).toBe('src/index.ts');
  });

  it('preserves leading space for unstaged (_M)', () => {
    const r = parseGitStatus(' M src/modified.ts');
    expect(r!.kind).toBe('unstaged');
    expect(r!.file).toBe('src/modified.ts');
  });

  it('preserves leading space for unstaged deleted (_D)', () => {
    const r = parseGitStatus(' D removed.ts');
    expect(r!.kind).toBe('unstaged');
    expect(r!.file).toBe('removed.ts');
  });

  it('parses staged added (A_)', () => {
    const r = parseGitStatus('A  src/new.ts');
    expect(r!.kind).toBe('staged');
    expect(r!.file).toBe('src/new.ts');
  });

  it('parses staged modified (M_) preserving trailing space', () => {
    const r = parseGitStatus('M  src/index.ts');
    expect(r!.kind).toBe('staged');
    expect(r!.file).toBe('src/index.ts');
  });

  it('parses porcelain deleted staged (D_)', () => {
    const r = parseGitStatus('D  old.ts');
    expect(r!.kind).toBe('deleted');
    expect(r!.file).toBe('old.ts');
  });

  it('parses porcelain rename with arrow', () => {
    const r = parseGitStatus('R  oldname.ts -> newname.ts');
    expect(r!.kind).toBe('renamed');
    expect(r!.file).toBe('newname.ts');
    expect((r as Extract<GitStatusEntry, { kind: 'renamed' }>).oldPath).toBe('oldname.ts');
  });

  it('parses mixed staged+unstaged (MM)', () => {
    const r = parseGitStatus('MM src/both.ts');
    expect(r!.kind).toBe('mixed');
    expect(r!.file).toBe('src/both.ts');
    const m = r as Extract<GitStatusEntry, { kind: 'mixed' }>;
    expect(m.staged).toBe('M');
    expect(m.unstaged).toBe('M');
  });

  it('returns null for empty line', () => {
    expect(parseGitStatus('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseGitStatus('   ')).toBeNull();
    expect(parseGitStatus('  ')).toBeNull();
  });

  it('returns null for two-char XY without path', () => {
    expect(parseGitStatus(' M')).toBeNull();
    expect(parseGitStatus('M ')).toBeNull();
  });

  it('parses path with spaces (quoted or unquoted)', () => {
    // Git porcelain can output paths with spaces
    const r = parseGitStatus(' M src/my folder/file with spaces.ts');
    expect(r).not.toBeNull();
    expect(r!.file).toContain('file with spaces.ts');
  });

  it('handles trailing CRLF', () => {
    const r = parseGitStatus(' M src/modified.ts\r\n');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('unstaged');
    expect(r!.file).toBe('src/modified.ts');
  });

  it('handles trailing LF only', () => {
    const r = parseGitStatus('?? untracked.ts\n');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('untracked');
    expect(r!.file).toBe('untracked.ts');
  });

  it('returns null for too-short line', () => {
    expect(parseGitStatus('M')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// normalizeRequestedFiles
// ═══════════════════════════════════════════════════════════════

describe('normalizeRequestedFiles', () => {
  it('returns null for undefined', () => {
    expect(normalizeRequestedFiles(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeRequestedFiles('')).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(normalizeRequestedFiles([])).toBeNull();
  });

  it('parses comma-separated string', () => {
    expect(normalizeRequestedFiles('src/a.ts,src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('trims whitespace from comma-separated', () => {
    expect(normalizeRequestedFiles(' src/a.ts , src/b.ts ')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('accepts string array', () => {
    expect(normalizeRequestedFiles(['src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('filters empty entries', () => {
    expect(normalizeRequestedFiles('src/a.ts,,src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

// ═══════════════════════════════════════════════════════════════
// canonicalizeAndDeduplicatePaths
// ═══════════════════════════════════════════════════════════════

describe('canonicalizeAndDeduplicatePaths', () => {
  it('deduplicates same file appearing in multiple entries', () => {
    const entries: GitStatusEntry[] = [
      { kind: 'staged', file: 'src/index.ts', status: 'M', isRename: false },
      { kind: 'unstaged', file: 'src/index.ts', status: 'M' },
      { kind: 'staged', file: 'src/utils.ts', status: 'M', isRename: false },
    ];
    const result = canonicalizeAndDeduplicatePaths(entries);
    expect(result.length).toBe(2);
  });

  it('merges staged+unstaged into mixed state', () => {
    const entries: GitStatusEntry[] = [
      { kind: 'staged', file: 'src/index.ts', status: 'M', isRename: false },
      { kind: 'unstaged', file: 'src/index.ts', status: 'M' },
    ];
    const result = canonicalizeAndDeduplicatePaths(entries);
    expect(result.length).toBe(1);
    expect(result[0].hasMixedState).toBe(true);
  });

  it('preserves oldPath from rename', () => {
    const entries: GitStatusEntry[] = [
      { kind: 'renamed', file: 'new.ts', oldPath: 'old.ts', status: 'R' },
    ];
    const result = canonicalizeAndDeduplicatePaths(entries);
    expect(result.length).toBe(1);
    expect(result[0].oldPath).toBe('old.ts');
    expect(result[0].file).toBe('new.ts');
  });

  it('handles empty input', () => {
    expect(canonicalizeAndDeduplicatePaths([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// classifyGitEntries
// ═══════════════════════════════════════════════════════════════

function c(file: string, kind: GitStatusEntry['kind'], extra?: Partial<GitStatusEntry>): CanonicalChange {
  const entry = { kind, file, status: 'M', ...extra } as GitStatusEntry;
  return { file, entries: [entry], hasMixedState: kind === 'mixed', oldPath: entry.kind === 'renamed' ? (entry as Extract<GitStatusEntry, { kind: 'renamed' }>).oldPath : undefined };
}

describe('classifyGitEntries', () => {
  it('separates categories correctly', () => {
    const changes: CanonicalChange[] = [
      { file: 'src/a.ts', entries: [{ kind: 'staged', file: 'src/a.ts', status: 'M', isRename: false }], hasMixedState: false },
      { file: 'src/b.ts', entries: [{ kind: 'unstaged', file: 'src/b.ts', status: 'M' }], hasMixedState: false },
      { file: 'src/c.ts', entries: [{ kind: 'untracked', file: 'src/c.ts', status: '?' }], hasMixedState: false },
      { file: 'src/d.ts', entries: [{ kind: 'deleted', file: 'src/d.ts', status: 'D' }], hasMixedState: false },
      { file: 'src/e.ts', entries: [{ kind: 'renamed', file: 'src/e.ts', oldPath: 'src/old.ts', status: 'R' }], hasMixedState: false, oldPath: 'src/old.ts' },
    ];
    const cats = classifyGitEntries(changes);
    expect(cats.tracked_changes.length).toBe(1);
    expect(cats.unstaged_changes.length).toBe(1);
    expect(cats.untracked_files.length).toBe(1);
    expect(cats.deleted_files.length).toBe(1);
    expect(cats.renamed_files.length).toBe(1);
  });

  it('rename does NOT appear in deleted_files', () => {
    const changes: CanonicalChange[] = [
      { file: 'new.ts', entries: [{ kind: 'renamed', file: 'new.ts', oldPath: 'old.ts', status: 'R' }], hasMixedState: false, oldPath: 'old.ts' },
    ];
    const cats = classifyGitEntries(changes);
    expect(cats.renamed_files.length).toBe(1);
    expect(cats.deleted_files.length).toBe(0);
  });

  it('genuine delete appears in deleted_files only', () => {
    const changes: CanonicalChange[] = [
      { file: 'removed.ts', entries: [{ kind: 'deleted', file: 'removed.ts', status: 'D' }], hasMixedState: false },
    ];
    const cats = classifyGitEntries(changes);
    expect(cats.deleted_files.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// filterPrimaryScope
// ═══════════════════════════════════════════════════════════════

describe('filterPrimaryScope', () => {
  const make = (f: string): CanonicalChange => ({
    file: f, entries: [{ kind: 'staged', file: f, status: 'M', isRename: false }], hasMixedState: false,
  });

  it('returns all when filter is null', () => {
    const files = [make('a.ts'), make('b.ts')];
    const { included, excluded } = filterPrimaryScope(files, null);
    expect(included.length).toBe(2);
    expect(excluded.length).toBe(0);
  });

  it('returns only requested files', () => {
    const files = [make('a.ts'), make('b.ts'), make('c.ts')];
    const { included, excluded } = filterPrimaryScope(files, ['a.ts']);
    expect(included.length).toBe(1);
    expect(included[0].file).toBe('a.ts');
    expect(excluded.length).toBe(2);
  });

  it('exact path match only, not substring', () => {
    const files = [make('index.ts'), make('index.test.ts')];
    const { included } = filterPrimaryScope(files, ['index.ts']);
    expect(included.length).toBe(1);
    expect(included[0].file).toBe('index.ts');
  });

  it('multiple filter paths', () => {
    const files = [make('a.ts'), make('b.ts'), make('c.ts')];
    const { included } = filterPrimaryScope(files, ['a.ts', 'c.ts']);
    expect(included.length).toBe(2);
  });

  it('nonexistent path returns empty included', () => {
    const files = [make('real.ts')];
    const { included, excluded } = filterPrimaryScope(files, ['ghost.ts']);
    expect(included.length).toBe(0);
    expect(excluded.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// classifyImpactEvidence
// ═══════════════════════════════════════════════════════════════

describe('classifyImpactEvidence', () => {
  it('confirmed: direct CALLS edges', () => {
    const result = classifyImpactEvidence({ directCallsCount: 3, importEdgesCount: 0, sameModuleCallerCount: 0 });
    expect(result.tier).toBe('confirmed');
  });

  it('confirmed: IMPORTS edges', () => {
    const result = classifyImpactEvidence({ directCallsCount: 0, importEdgesCount: 2, sameModuleCallerCount: 0 });
    expect(result.tier).toBe('confirmed');
  });

  it('probable: same-module callers without direct edges', () => {
    const result = classifyImpactEvidence({ directCallsCount: 0, importEdgesCount: 0, sameModuleCallerCount: 2 });
    expect(result.tier).toBe('probable');
  });

  it('nominal: no evidence at all', () => {
    const result = classifyImpactEvidence({ directCallsCount: 0, importEdgesCount: 0, sameModuleCallerCount: 0 });
    expect(result.tier).toBe('nominal');
  });
});

// ═══════════════════════════════════════════════════════════════
// deduplicateRelatedDependencies
// ═══════════════════════════════════════════════════════════════

describe('deduplicateRelatedDependencies', () => {
  function dep(overrides: Partial<RelatedDependency> = {}): RelatedDependency {
    return {
      scopeFile: 'src/a.ts',
      scopeSymbol: 'a.main',
      relatedFile: 'src/lib/b.ts',
      relatedSymbol: 'b.helper',
      direction: 'outbound',
      edgeType: 'CALLS',
      reason: 'CALLS edge from a.main to b.helper',
      confidence: 'high',
      ...overrides,
    };
  }

  it('passes through unique entries', () => {
    const deps = [dep(), dep({ relatedFile: 'src/lib/c.ts', relatedSymbol: 'c.util' })];
    const result = deduplicateRelatedDependencies(deps);
    expect(result.length).toBe(2);
  });

  it('removes exact duplicates', () => {
    const d = dep();
    const result = deduplicateRelatedDependencies([d, d]);
    expect(result.length).toBe(1);
  });

  it('deduplicates by canonical key (file+symbol+direction)', () => {
    const d1 = dep();
    const d2 = dep({ reason: 'different reason but same key' });
    const result = deduplicateRelatedDependencies([d1, d2]);
    expect(result.length).toBe(1);
  });

  it('keeps entries with different directions', () => {
    const d1 = dep({ direction: 'outbound' });
    const d2 = dep({ direction: 'inbound' });
    const result = deduplicateRelatedDependencies([d1, d2]);
    expect(result.length).toBe(2);
  });

  it('handles null symbols', () => {
    const d1 = dep({ scopeSymbol: null, relatedSymbol: null });
    const d2 = dep({ scopeSymbol: null, relatedSymbol: null, reason: 'same' });
    const result = deduplicateRelatedDependencies([d1, d2]);
    expect(result.length).toBe(1);
  });
});


describe('isGitWorkTree', () => {
  it('returns false for a non-repository directory', () => {
    expect(isGitWorkTree('/tmp')).toBe(false);
  });
});
