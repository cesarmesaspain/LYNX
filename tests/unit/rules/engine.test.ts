/*
 * engine.test.ts — Unit tests for SACG-030 rules engine.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import {
  loadRules,
  detectArchitectureViolations,
  handleCheckRules,
} from '../../../src/rules/engine.js';
import type { LynxRules } from '../../../src/rules/engine.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

function seedGraph(db: LynxDatabase, project: string) {
  // File nodes
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (1, ?, 'File', 'a.ts', 'a', 'src/domain/a.ts', 1, 1, 0, 0, 0, '{}'),
            (2, ?, 'File', 'b.ts', 'b', 'src/infra/b.ts', 1, 1, 0, 0, 0, '{}'),
            (3, ?, 'File', 'c.ts', 'c', 'src/domain/c.ts', 1, 1, 0, 0, 0, '{}'),
            (4, ?, 'File', 'd.ts', 'd', 'src/ui/d.tsx', 1, 1, 0, 0, 0, '{}'),
            (5, ?, 'File', 'e.ts', 'e', 'src/ui/e.tsx', 1, 1, 0, 0, 0, '{}'),
            (6, ?, 'File', 'f.ts', 'f', 'tests/test-f.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(project, project, project, project, project, project);

  // Symbol nodes (all in domain/)
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (10, ?, 'Function', 'domainFn', 'domain.domainFn', 'src/domain/a.ts', 1, 3, 1, 0, 0, '{}')`
  ).run(project);
  // Symbol in infra
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (11, ?, 'Function', 'infraFn', 'infra.infraFn', 'src/infra/b.ts', 1, 3, 1, 0, 0, '{}')`
  ).run(project);
  // Symbol in domain/c.ts
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (12, ?, 'Function', 'anotherDomainFn', 'domain.anotherDomainFn', 'src/domain/c.ts', 1, 3, 1, 0, 0, '{}')`
  ).run(project);
  // Symbol in src/ui/d.tsx (exported React component)
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (13, ?, 'Function', 'uiFn', 'ui.uiFn', 'src/ui/d.tsx', 1, 3, 1, 0, 0, '{}')`
  ).run(project);

  // IMPORTS edges: domain/a.ts (id=10) imports from infra/b.ts (id=11) — VIOLATION
  db.db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties)
     VALUES (?, 10, 11, 'IMPORTS', '{}')`
  ).run(project);

  // domain/a.ts (id=10) imports from domain/c.ts (id=12) — OK (same layer)
  db.db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties)
     VALUES (?, 10, 12, 'IMPORTS', '{}')`
  ).run(project);

  // ui/d.tsx (id=13) imports from domain/a.ts (id=10) — not forbidden by rules
  db.db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties)
     VALUES (?, 13, 10, 'IMPORTS', '{}')`
  ).run(project);
}

function makeRules(overrides: Partial<LynxRules> = {}): LynxRules {
  return {
    version: 1,
    layers: {
      domain: { pattern: 'src/domain/**' },
      infra: { pattern: 'src/infra/**' },
      ui: { pattern: 'src/ui/**' },
    },
    rules: [
      { type: 'forbidden', from: 'domain', to: ['infra'], description: 'domain cannot call infra' },
    ],
    ...overrides,
  };
}

describe('loadRules', () => {
  it('returns null when file does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'lynx-nonexistent-' + Date.now());
    if (fs.existsSync(nonExistent)) fs.rmSync(nonExistent, { recursive: true, force: true });
    expect(loadRules(nonExistent)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-'));
    try {
      fs.writeFileSync(path.join(dir, 'lynx-rules.json'), '{bad');
      expect(loadRules(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when missing layers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-'));
    try {
      fs.writeFileSync(path.join(dir, 'lynx-rules.json'), JSON.stringify({ rules: [] }));
      expect(loadRules(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a valid rules file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-'));
    try {
      const rules = makeRules();
      fs.writeFileSync(path.join(dir, 'lynx-rules.json'), JSON.stringify(rules));
      const loaded = loadRules(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.layers.domain.pattern).toBe('src/domain/**');
      expect(loaded!.rules).toHaveLength(1);
      expect(loaded!.rules[0].from).toBe('domain');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detectArchitectureViolations', () => {
  const PROJECT = 'test-rules';
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedGraph(db, PROJECT);
  });

  it('detects domain → infra import as forbidden', () => {
    const violations = detectArchitectureViolations(db, PROJECT, makeRules());
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const domainToInfra = violations.filter(
      v => v.from_layer === 'domain' && v.to_layer === 'infra'
    );
    expect(domainToInfra.length).toBe(1);
    expect(domainToInfra[0].source_symbol).toBe('domainFn');
    expect(domainToInfra[0].target_symbol).toBe('infraFn');
    expect(domainToInfra[0].source_file).toBe('src/domain/a.ts');
    expect(domainToInfra[0].target_file).toBe('src/infra/b.ts');
  });

  it('does not flag domain → domain imports', () => {
    const violations = detectArchitectureViolations(db, PROJECT, makeRules());
    const sameLayer = violations.filter(
      v => v.from_layer === 'domain' && v.to_layer === 'domain'
    );
    expect(sameLayer.length).toBe(0);
  });

  it('does not flag ui → domain (not forbidden by rule)', () => {
    const violations = detectArchitectureViolations(db, PROJECT, makeRules());
    const uiToDomain = violations.filter(
      v => v.from_layer === 'ui' && v.to_layer === 'domain'
    );
    expect(uiToDomain.length).toBe(0);
  });

  it('returns empty when no rules are defined', () => {
    const noRules = makeRules({ rules: [] });
    const violations = detectArchitectureViolations(db, PROJECT, noRules);
    expect(violations).toEqual([]);
  });

  it('filters by scoped files', () => {
    // Only check violations where source is in src/domain/a.ts
    const violations = detectArchitectureViolations(db, PROJECT, makeRules(), ['src/domain/a.ts']);
    expect(violations.length).toBe(1);
    expect(violations[0].source_file).toBe('src/domain/a.ts');
  });

  it('returns empty for scoped files with no violations', () => {
    const violations = detectArchitectureViolations(db, PROJECT, makeRules(), ['src/ui/e.tsx']);
    expect(violations).toEqual([]);
  });
});

describe('handleCheckRules', () => {
  const PROJECT = 'test-rules-handler';

  it('returns not-indexed when project is missing', async () => {
    const result = await handleCheckRules({ project: 'nonexistent' });
    expect(result.project).toBe('nonexistent');
    expect(result.rules_file_loaded).toBe(false);
    expect(result.summary).toContain('not indexed');
  });

  it('returns no-rules-file when lynx-rules.json is absent', async () => {
    const db = LynxDatabase.openMemory();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-handler-'));
    try {
      db.upsertProject(PROJECT, dir);
      setDb(PROJECT, db);

      const result = await handleCheckRules({ project: PROJECT });
      expect(result.rules_file_loaded).toBe(false);
      expect(result.summary).toContain('No lynx-rules.json found');
    } finally {
      unsetDb(PROJECT, { close: false });
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects violations from a loaded rules file', async () => {
    const db = LynxDatabase.openMemory();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-handler-'));
    try {
      db.upsertProject(PROJECT, dir);
      seedGraph(db, PROJECT);
      fs.writeFileSync(path.join(dir, 'lynx-rules.json'), JSON.stringify(makeRules()));
      setDb(PROJECT, db);

      const result = await handleCheckRules({ project: PROJECT });
      expect(result.rules_file_loaded).toBe(true);
      expect(result.layers_defined).toBe(3);
      expect(result.rules_defined).toBe(1);
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    } finally {
      unsetDb(PROJECT, { close: false });
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scopes violations to requested files', async () => {
    const db = LynxDatabase.openMemory();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-rules-handler-'));
    try {
      db.upsertProject(PROJECT, dir);
      seedGraph(db, PROJECT);
      fs.writeFileSync(path.join(dir, 'lynx-rules.json'), JSON.stringify(makeRules()));
      setDb(PROJECT, db);

      const result = await handleCheckRules({ project: PROJECT, files: ['src/domain/a.ts'] });
      expect(result.violations.length).toBe(1);
    } finally {
      unsetDb(PROJECT, { close: false });
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
