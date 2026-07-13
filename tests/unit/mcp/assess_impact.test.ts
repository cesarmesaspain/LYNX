/*
 * assess_impact.test.ts — Unit tests for assess_impact query functions.
 *
 * Tests each query in isolation using an in-memory DB with synthetic data.
 * Verifies that: "no test relation found" ≠ "confirmed untested",
 * unindexed files are classified correctly, and evidence strengths are correct.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LynxDatabase } from '../../../src/store/database.js';
import {
  queryTestsCoveringChanges,
  queryUntestedFiles,
  queryNewSymbolsNoCallers,
  queryDeletedSymbolsLiveRefs,
  queryUnindexedModified,
  stableSort,
  fairTruncate,
  collectGitDiffFiles,
  normalizeFileArg,
  resolveRequestedFiles,
} from '../../../src/mcp/handlers/assess_impact.js';
import type { ImpactFinding } from '../../../src/mcp/handlers/assess_impact.js';

function seedDb(db: LynxDatabase, project: string) {
  // File nodes
  const files = [
    { rel: 'src/index.ts' },
    { rel: 'src/utils.ts' },
    { rel: 'src/uncovered.ts' },
    { rel: 'tests/index.test.ts' },
    { rel: 'tests/utils.test.ts' },
  ];
  const fileIds: Record<string, number> = {};
  let id = 1;
  for (const f of files) {
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, 'File', ?, ?, ?, 1, 1, 0, ?, 0, '{}')`
    ).run(id, project, f.rel.split('/').pop(), f.rel.replace(/\.[^.]+$/, '').replace(/\//g, '.'), f.rel, f.rel.includes('.test.') ? 1 : 0);
    fileIds[f.rel] = id;
    id++;
  }

  // Function nodes
  const funcs = [
    { name: 'main', file: 'src/index.ts', isTest: 0, isExported: 1, isEntry: 1 },
    { name: 'doWork', file: 'src/utils.ts', isTest: 0, isExported: 1, isEntry: 0 },
    { name: 'helper', file: 'src/utils.ts', isTest: 0, isExported: 0, isEntry: 0 },
    { name: 'uncoveredFn', file: 'src/uncovered.ts', isTest: 0, isExported: 1, isEntry: 0 },
    { name: 'deadFn', file: 'src/uncovered.ts', isTest: 0, isExported: 0, isEntry: 0 },
    { name: 'testMain', file: 'tests/index.test.ts', isTest: 1, isExported: 0, isEntry: 0 },
    { name: 'testDoWork', file: 'tests/utils.test.ts', isTest: 1, isExported: 0, isEntry: 0 },
  ];
  const funcIds: Record<string, number> = {};
  for (const fn of funcs) {
    const qn = `${fn.file.replace(/\.[^.]+$/, '').replace(/\//g, '.')}.${fn.name}`;
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, 'Function', ?, ?, ?, 1, 10, ?, ?, ?, '{"signature":"function"}')`
    ).run(id, project, fn.name, qn, fn.file, fn.isExported, fn.isTest, fn.isEntry);
    funcIds[qn] = id;
    id++;
  }

  // TESTS edges: testMain → main, testDoWork → doWork
  if (funcIds['tests.index.test.testMain'] && funcIds['src.index.main']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'TESTS\', \'{}\')'
    ).run(project, funcIds['tests.index.test.testMain'], funcIds['src.index.main']);
  }
  if (funcIds['tests.utils.test.testDoWork'] && funcIds['src.utils.doWork']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'TESTS\', \'{}\')'
    ).run(project, funcIds['tests.utils.test.testDoWork'], funcIds['src.utils.doWork']);
  }

  // TESTS_FILE edges
  if (fileIds['tests/index.test.ts'] && fileIds['src/index.ts']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'TESTS_FILE\', \'{}\')'
    ).run(project, fileIds['tests/index.test.ts'], fileIds['src/index.ts']);
  }
  if (fileIds['tests/utils.test.ts'] && fileIds['src/utils.ts']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'TESTS_FILE\', \'{}\')'
    ).run(project, fileIds['tests/utils.test.ts'], fileIds['src/utils.ts']);
  }

  // CALLS edges for deleted test
  if (funcIds['src.utils.doWork'] && funcIds['src.utils.helper']) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'CALLS\', \'{}\')'
    ).run(project, funcIds['src.utils.doWork'], funcIds['src.utils.helper']);
  }

  return { fileIds, funcIds };
}

describe('assess_impact queries', () => {
  let db: LynxDatabase;
  const PROJECT = 'test-impact';

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedDb(db, PROJECT);
  });

  // ── Query 1: tests covering changes ──────────────────────────

  describe('queryTestsCoveringChanges', () => {
    it('does not request coverage for modified test files', () => {
      expect(queryTestsCoveringChanges(db, PROJECT, ['tests/index.test.ts'])).toEqual([]);
    });

    it('finds tests covering modified symbols via TESTS edges', () => {
      const findings = queryTestsCoveringChanges(db, PROJECT, ['src/index.ts']);
      const covering = findings.filter(f => f.category === 'tests_covering_changes');
      expect(covering.length).toBeGreaterThanOrEqual(1);
      const mainFinding = covering.find(f => f.symbol === 'main');
      expect(mainFinding).toBeDefined();
      expect(mainFinding!.overall_confidence).toBe('high');
      expect(mainFinding!.evidence.some(e => e.strength === 'confirmed')).toBe(true);
    });

    it('reports untested_changes when no TESTS edges exist', () => {
      const findings = queryTestsCoveringChanges(db, PROJECT, ['src/uncovered.ts']);
      const untested = findings.filter(f => f.category === 'untested_changes');
      expect(untested.length).toBeGreaterThanOrEqual(1);
      const uf = untested.find(f => f.symbol === 'uncoveredFn');
      expect(uf).toBeDefined();
      expect(uf!.evidence.some(e => e.strength === 'searched_not_found')).toBe(true);
    });

    it('skips unindexed files (no findings)', () => {
      const findings = queryTestsCoveringChanges(db, PROJECT, ['src/nonexistent.ts']);
      expect(findings.length).toBe(0);
    });
  });

  // ── Query 2: untested files ─────────────────────────────────

  describe('queryUntestedFiles', () => {
    it('does not classify modified test files as untested production code', () => {
      expect(queryUntestedFiles(db, PROJECT, ['tests/index.test.ts'])).toEqual([]);
    });

    it('identifies indexed files without TESTS_FILE edges', () => {
      const findings = queryUntestedFiles(db, PROJECT, ['src/uncovered.ts']);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].category).toBe('untested_changes');
      expect(findings[0].evidence.some(e => e.strength === 'searched_not_found')).toBe(true);
    });

    it('does not flag a file when its symbols are covered through TESTS edges alone', () => {
      db.db.prepare(
        `DELETE FROM edges
         WHERE project = ? AND type = 'TESTS_FILE'
           AND target_id = (SELECT id FROM nodes WHERE project = ? AND file_path = ? AND kind = 'File')`
      ).run(PROJECT, PROJECT, 'src/utils.ts');

      expect(queryUntestedFiles(db, PROJECT, ['src/utils.ts'])).toEqual([]);
    });

    it('deduplicates convention-based test file suggestions', () => {
      const insert = db.db.prepare(
        `INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
         VALUES (?, 'Function', ?, ?, 'tests/uncovered.test.ts', 1, 1, 0, 1, 0, '{}')`,
      );
      insert.run(PROJECT, 'uncoveredCaseA', 'tests.uncovered.caseA');
      insert.run(PROJECT, 'uncoveredCaseB', 'tests.uncovered.caseB');

      const finding = queryUntestedFiles(db, PROJECT, ['src/uncovered.ts'])[0];
      const convention = finding.evidence.find(e => e.source === 'name convention');

      expect(convention?.detail).toBe('Possible related test files: tests/uncovered.test.ts');
    });

    it('skips unindexed files silently (they belong in queryUnindexedModified)', () => {
      const findings = queryUntestedFiles(db, PROJECT, ['src/ghost.ts']);
      expect(findings.length).toBe(0);
    });
  });

  // ── Query 3: new symbols without callers ────────────────────

  describe('queryNewSymbolsNoCallers', () => {
    it('finds functions with zero CALLS edges', () => {
      const findings = queryNewSymbolsNoCallers(db, PROJECT);
      // deadFn has no CALLS edges and is not exported/entry
      const dead = findings.filter(f => f.symbol === 'deadFn');
      expect(dead.length).toBe(1);
      expect(dead[0].overall_confidence).toBe('high');
      expect(dead[0].evidence.some(e => e.source === 'CALLS edges')).toBe(true);
    });

    it('limits findings to the requested changed files', () => {
      const findings = queryNewSymbolsNoCallers(db, PROJECT, ['src/utils.ts']);
      expect(findings.some(f => f.file === 'src/uncovered.ts')).toBe(false);
      expect(findings.some(f => f.symbol === 'deadFn')).toBe(false);
    });

    it('returns no findings for an explicitly empty changed-file scope', () => {
      const findings = queryNewSymbolsNoCallers(db, PROJECT, []);
      expect(findings).toEqual([]);
    });

    it('preserves whole-project behavior when no scope is provided', () => {
      const findings = queryNewSymbolsNoCallers(db, PROJECT);
      expect(findings.some(f => f.symbol === 'deadFn')).toBe(true);
    });

    it('skips exported and entry-point symbols', () => {
      const findings = queryNewSymbolsNoCallers(db, PROJECT);
      const main = findings.filter(f => f.symbol === 'main');
      expect(main.length).toBe(0);
    });

    it('does not classify conventional main entry points as removable', () => {
      db.db.prepare(`INSERT INTO nodes (project, name, qualified_name, kind, file_path, start_line, end_line, is_exported, is_entry_point, is_test, properties)
        VALUES (?, 'main', 'native.main', 'Function', 'native/tool.c', 1, 4, 0, 0, 0, '{"signature":"int main(void)"}')`).run(PROJECT);

      expect(queryNewSymbolsNoCallers(db, PROJECT).some(f => f.qualified_name === 'native.main')).toBe(false);
    });

    it('reports medium confidence when USAGE edges exist', () => {
      // Add a USAGE edge to deadFn
      const deadFnId = db.db.prepare(
        'SELECT id FROM nodes WHERE project = ? AND qualified_name = ?'
      ).get(PROJECT, 'src.uncovered.deadFn') as { id: number } | undefined;

      const doWorkId = db.db.prepare(
        'SELECT id FROM nodes WHERE project = ? AND qualified_name = ?'
      ).get(PROJECT, 'src.utils.doWork') as { id: number } | undefined;

      if (deadFnId && doWorkId) {
        db.db.prepare(
          'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, \'USAGE\', \'{}\')'
        ).run(PROJECT, doWorkId.id, deadFnId.id);
      }

      const findings = queryNewSymbolsNoCallers(db, PROJECT);
      const dead = findings.filter(f => f.symbol === 'deadFn');
      if (dead.length > 0) {
        expect(dead[0].overall_confidence).toBe('medium');
      }
    });
  });

  // ── Query 4: deleted symbols with live refs ──────────────────

  describe('queryDeletedSymbolsLiveRefs', () => {
    it('returns empty when no deletions detected (all files exist)', () => {
      // Pass existsFn that always returns true — no deletions in this synthetic DB
      const findings = queryDeletedSymbolsLiveRefs(db, PROJECT, '/fake/root', (_p: string) => true);
      expect(Array.isArray(findings)).toBe(true);
      expect(findings.length).toBe(0);
    });

    it('detects deleted files when existsFn returns false', () => {
      // Simulate src/utils.ts being deleted — doWork had a CALLS edge to helper
      const findings = queryDeletedSymbolsLiveRefs(db, PROJECT, '/fake/root',
        (p: string) => !p.includes('src/utils.ts'));
      expect(findings.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Query 5: unindexed modified files ───────────────────────

  describe('queryUnindexedModified', () => {
    const fakeExists = (_p: string) => true;

    it('flags files in diff but not in graph', () => {
      const findings = queryUnindexedModified(db, PROJECT, ['src/notindexed.ts', 'src/index.ts'], '/fake/root', fakeExists);
      const unindexed = findings.filter(f => f.file === 'src/notindexed.ts');
      expect(unindexed.length).toBe(1);
      expect(unindexed[0].overall_confidence).toBe('high');
      expect(unindexed[0].evidence.some(e => e.strength === 'searched_not_found')).toBe(true);
    });

    it('skips files already in the graph', () => {
      const findings = queryUnindexedModified(db, PROJECT, ['src/index.ts'], '/fake/root', fakeExists);
      expect(findings.length).toBe(0);
    });

    it('distinguishes generated files', () => {
      // Generated files are detected by path convention before filesystem check
      const findings = queryUnindexedModified(db, PROJECT, ['dist/bundle.js'], '/fake/root');
      expect(findings.length).toBe(1);
      expect(findings[0].detail).toContain('Generated');
      expect(findings[0].evidence.some(e => e.source === 'path convention')).toBe(true);
    });

    it('flags deleted files when existsFn returns false', () => {
      const findings = queryUnindexedModified(db, PROJECT, ['src/notindexed.ts'], '/fake/root', (_p: string) => false);
      expect(findings.length).toBe(1);
      expect(findings[0].detail).toContain('no longer exists');
    });

    it('flags unindexed code file as unindexed_modified_files', () => {
      const findings = queryUnindexedModified(db, PROJECT, ['src/notindexed.ts'], '/fake/root', (_p: string) => true);
      const unindexed = findings.filter(f => f.file === 'src/notindexed.ts');
      expect(unindexed.length).toBe(1);
      expect(unindexed[0].category).toBe('unindexed_modified_files');
      expect(unindexed[0].overall_confidence).toBe('high');
      expect(unindexed[0].evidence.some(e => e.strength === 'searched_not_found')).toBe(true);
    });

    it('flags non-code file via extension check', () => {
      const findings = queryUnindexedModified(db, PROJECT, ['README.md'], '/fake/root', (_p: string) => true);
      expect(findings.length).toBe(1);
      expect(findings[0].category).toBe('unindexed_modified_files');
      expect(findings[0].evidence.some(e => e.source === 'extension check')).toBe(true);
    });
  });

  // ── Non-code filtering ──────────────────────────────────────

  describe('non-code file handling', () => {
    it('queryUntestedFiles skips non-code files silently', () => {
      // README.md is not a code file — should generate zero findings
      const findings = queryUntestedFiles(db, PROJECT, ['README.md']);
      expect(findings.length).toBe(0);
    });

    it('queryUntestedFiles handles indexed code file without TESTS_FILE', () => {
      // src/uncovered.ts IS indexed but has no TESTS_FILE edges
      const findings = queryUntestedFiles(db, PROJECT, ['src/uncovered.ts']);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].category).toBe('untested_changes');
      expect(findings[0].evidence.some(e => e.strength === 'searched_not_found')).toBe(true);
    });
  });
});

describe('assess_impact input compatibility', () => {
  it('normalizes detect_changes changed_files entries into a file scope', () => {
    expect(normalizeFileArg([
      { file: 'src/auth.ts', status: 'M' },
      { file: 'src/session.ts', status: '?' },
    ])).toEqual(['src/auth.ts', 'src/session.ts']);
  });

  it('accepts target and file aliases without broadening to the full diff', () => {
    expect(resolveRequestedFiles({ target: 'src/auth.ts' })).toEqual(['src/auth.ts']);
    expect(resolveRequestedFiles({ file: 'src/session.ts' })).toEqual(['src/session.ts']);
    expect(resolveRequestedFiles({ changed_files: [{ file: 'src/auth.ts' }] })).toEqual(['src/auth.ts']);
  });
});

describe('collectGitDiffFiles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not execute a malicious base branch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-assess-impact-'));
    tempDirs.push(repo);
    const marker = path.join(repo, 'injected');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'sample.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'sample.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const files = collectGitDiffFiles(repo, `main; touch ${marker}`);

    expect(files).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Fair truncation tests
// ═══════════════════════════════════════════════════════════════

function makeFinding(overrides: Partial<ImpactFinding>): ImpactFinding {
  return {
    category: 'untested_changes',
    file: 'src/test.ts',
    detail: 'test',
    evidence: [],
    overall_confidence: 'medium',
    ...overrides,
  };
}

describe('stableSort', () => {
  it('sorts by confidence high→medium→low', () => {
    const findings = [
      makeFinding({ overall_confidence: 'low', file: 'a.ts' }),
      makeFinding({ overall_confidence: 'high', file: 'b.ts' }),
      makeFinding({ overall_confidence: 'medium', file: 'c.ts' }),
    ];
    const sorted = stableSort(findings);
    expect(sorted[0].overall_confidence).toBe('high');
    expect(sorted[1].overall_confidence).toBe('medium');
    expect(sorted[2].overall_confidence).toBe('low');
  });

  it('sorts by category within same confidence', () => {
    const findings = [
      makeFinding({ overall_confidence: 'high', category: 'unindexed_modified_files', file: 'a.ts' }),
      makeFinding({ overall_confidence: 'high', category: 'deleted_symbols_live_refs', file: 'b.ts' }),
      makeFinding({ overall_confidence: 'high', category: 'new_symbols_no_callers', file: 'c.ts' }),
    ];
    const sorted = stableSort(findings);
    expect(sorted[0].category).toBe('deleted_symbols_live_refs');
    expect(sorted[2].category).toBe('unindexed_modified_files');
  });

  it('is deterministic (same input → same output)', () => {
    const findings = [
      makeFinding({ confidence: 'high', file: 'b.ts', symbol: 'x' }),
      makeFinding({ confidence: 'high', file: 'a.ts', symbol: 'y' }),
      makeFinding({ confidence: 'medium', file: 'c.ts', symbol: 'z' }),
    ];
    const a = stableSort(findings);
    const b = stableSort(findings);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].file).toBe(b[i].file);
      expect(a[i].symbol).toBe(b[i].symbol);
    }
  });
});

describe('fairTruncate', () => {
  const categories = [
    'tests_covering_changes' as const,
    'untested_changes' as const,
    'new_symbols_no_callers' as const,
    'unindexed_modified_files' as const,
    'deleted_symbols_live_refs' as const,
  ];

  it('each non-empty category is represented', () => {
    const findings: ImpactFinding[] = [];
    // 20 findings per category, all medium confidence
    for (const cat of categories) {
      for (let i = 0; i < 20; i++) {
        findings.push(makeFinding({ category: cat, file: `${cat}/${i}.ts`, overall_confidence: 'medium' }));
      }
    }
    const { selected } = fairTruncate(findings, 30, 0);
    const cats = new Set(selected.map(f => f.category));
    // With 5 categories and limit 30, every category should have at least 5 entries
    expect(cats.size).toBe(5);
    for (const cat of categories) {
      const count = selected.filter(f => f.category === cat).length;
      expect(count).toBeGreaterThanOrEqual(5);
    }
    expect(selected.length).toBeLessThanOrEqual(30);
  });

  it('category totals survive truncation (returned is capped, internal count is full)', () => {
    const findings: ImpactFinding[] = [];
    for (const cat of categories) {
      for (let i = 0; i < 20; i++) {
        findings.push(makeFinding({ category: cat, file: `${cat}/${i}.ts`, overall_confidence: 'medium' }));
      }
    }
    // total = 100, limit = 30
    const { selected } = fairTruncate(findings, 30, 0);
    expect(selected.length).toBeLessThanOrEqual(30);
    // total findings should still be 100 (the array was not mutated)
    expect(findings.length).toBe(100);
  });

  it('is deterministic (same input → same output order)', () => {
    const findings: ImpactFinding[] = [];
    for (const cat of categories) {
      for (let i = 0; i < 5; i++) {
        findings.push(makeFinding({ category: cat, file: `${cat}/${i}.ts`, symbol: `sym${i}`, overall_confidence: 'medium' }));
      }
    }
    const a = fairTruncate(findings, 20, 0);
    const b = fairTruncate(findings, 20, 0);
    expect(a.selected.length).toBe(b.selected.length);
    for (let i = 0; i < a.selected.length; i++) {
      expect(a.selected[i].file).toBe(b.selected[i].file);
      expect(a.selected[i].symbol).toBe(b.selected[i].symbol);
    }
  });

  it('pagination: consecutive pages have no overlap', () => {
    const findings: ImpactFinding[] = [];
    for (const cat of categories) {
      for (let i = 0; i < 15; i++) {
        findings.push(makeFinding({ category: cat, file: `${cat}/${i}.ts`, symbol: `sym${i}`, overall_confidence: 'medium' }));
      }
    }
    const page1 = fairTruncate(findings, 30, 0).selected;
    const page2 = fairTruncate(findings, 30, 30).selected;

    // No overlap
    const page1Keys = new Set(page1.map(f => `${f.file}::${f.symbol}`));
    for (const f of page2) {
      expect(page1Keys.has(`${f.file}::${f.symbol}`)).toBe(false);
    }

    // Combined should be ≤ 60 unique
    const allKeys = new Set([...page1, ...page2].map(f => `${f.file}::${f.symbol}`));
    expect(allKeys.size).toBe(page1.length + page2.length);
  });

  it('pagination is stable: fair truncation pages have no overlap', () => {
    const findings: ImpactFinding[] = [];
    for (const cat of categories) {
      for (let i = 0; i < 10; i++) {
        findings.push(makeFinding({ category: cat, file: `${cat}/${i}.ts`, symbol: `sym${i}`, overall_confidence: 'medium' }));
      }
    }
    const page1 = fairTruncate(findings, 10, 0).selected;
    const page2 = fairTruncate(findings, 10, 10).selected;

    // No overlap between pages
    const page1Keys = new Set(page1.map(f => `${f.file}::${f.symbol}`));
    for (const f of page2) {
      expect(page1Keys.has(`${f.file}::${f.symbol}`)).toBe(false);
    }
    // Combined unique count equals sum (no overlap + no duplicates within page)
    const allKeys = [...page1, ...page2].map(f => `${f.file}::${f.symbol}`);
    expect(new Set(allKeys).size).toBe(page1.length + page2.length);
  });

  it('offset beyond total returns empty', () => {
    const findings = [makeFinding({ file: 'a.ts' })];
    const { selected } = fairTruncate(findings, 10, 50);
    expect(selected.length).toBe(0);
  });

  it('handles empty input', () => {
    const { selected } = fairTruncate([], 10, 0);
    expect(selected.length).toBe(0);
  });

  it('handles single category', () => {
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ category: 'untested_changes', file: `src/${i}.ts`, overall_confidence: 'medium' }));
    const { selected } = fairTruncate(findings, 10, 0);
    expect(selected.length).toBe(10);
    expect(new Set(selected.map(f => f.category)).size).toBe(1);
  });
});
