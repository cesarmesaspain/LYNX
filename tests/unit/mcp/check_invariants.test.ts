/*
 * check_invariants.test.ts — Unit tests for discoverInvariants and checkInvariantsBroken.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import {
  discoverInvariants,
  checkInvariantsBroken,
} from '../../../src/mcp/handlers/check_invariants.js';

function seedCallPairs(
  db: LynxDatabase,
  project: string,
) {
  // File nodes
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (1, ?, 'File', 'a.ts', 'a', 'src/a.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(project);
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (2, ?, 'File', 'b.ts', 'b', 'src/b.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(project);

  // Callee functions: lock (id=10), unlock (id=11)
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (10, ?, 'Function', 'lock', 'lock', 'src/lock.ts', 1, 3, 1, 0, 0, '{}')`
  ).run(project);
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (11, ?, 'Function', 'unlock', 'unlock', 'src/lock.ts', 5, 8, 1, 0, 0, '{}')`
  ).run(project);

  // Callee: standalone doLog (id=13)
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (13, ?, 'Function', 'doLog', 'doLog', 'src/log.ts', 1, 3, 1, 0, 0, '{}')`
  ).run(project);

  // Caller functions: 5 functions that call lock + unlock, 1 that calls lock only
  for (let i = 20; i <= 24; i++) {
    db.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (?, ?, 'Function', 'fn' + ?, 'fn' + ?, 'src/a.ts', 1, 1, 0, 0, 0, '{}')`
    ).run(i, project, i, i);
  }
  // fn25: calls lock only (the violator)
  db.db.prepare(
    `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
     VALUES (25, ?, 'Function', 'fn25', 'fn25', 'src/a.ts', 1, 1, 0, 0, 0, '{}')`
  ).run(project);

  // CALLS edges: fn20..fn24 → lock + unlock, fn25 → lock only
  for (let i = 20; i <= 24; i++) {
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, 10, \'CALLS\', \'{}\')'
    ).run(project, i);
    db.db.prepare(
      'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, 11, \'CALLS\', \'{}\')'
    ).run(project, i);
  }
  // fn25 → lock only
  db.db.prepare(
    'INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 25, 10, \'CALLS\', \'{}\')'
  ).run(project);

  return {
    lockId: 10, unlockId: 11, doLogId: 13,
    jointCallerIds: [20, 21, 22, 23, 24],
    violatorId: 25,
  };
}

describe('discoverInvariants', () => {
  let db: LynxDatabase;
  const PROJECT = 'test-invariants';

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedCallPairs(db, PROJECT);
  });

  it('discovers lock→unlock as a high-confidence invariant', () => {
    const invariants = discoverInvariants(db, PROJECT);
    const lockUnlock = invariants.find(
      inv => inv.from_name === 'lock' && inv.to_name === 'unlock'
    );
    expect(lockUnlock).toBeDefined();
    expect(lockUnlock!.confidence).toBe(0.833);
    expect(lockUnlock!.total_callers_of_from).toBe(6);
    expect(lockUnlock!.joint_callers).toBe(5);
  });

  it('does not create invariants for pairs with fewer than 3 callers', () => {
    // doLog (13) has zero callers — should never appear as from or to
    const invariants = discoverInvariants(db, PROJECT);
    const hasDoLog = invariants.some(
      inv => inv.from_name === 'doLog' || inv.to_name === 'doLog'
    );
    expect(hasDoLog).toBe(false);
  });

  it('returns empty when no call graph data', () => {
    const emptyDb = LynxDatabase.openMemory();
    emptyDb.db.prepare(
      `INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
       VALUES (1, ?, 'File', 'x.ts', 'x', 'src/x.ts', 1, 1, 0, 0, 0, '{}')`
    ).run(PROJECT);
    const invariants = discoverInvariants(emptyDb, PROJECT);
    expect(invariants).toEqual([]);
  });
});

describe('checkInvariantsBroken', () => {
  let db: LynxDatabase;
  const PROJECT = 'test-invariants';

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    seedCallPairs(db, PROJECT);
  });

  it('flags callers that call lock() but not unlock()', () => {
    const invariants = discoverInvariants(db, PROJECT);
    const lockUnlock = invariants.find(
      inv => inv.from_name === 'lock' && inv.to_name === 'unlock'
    );
    expect(lockUnlock).toBeDefined();

    const violations = checkInvariantsBroken(db, PROJECT, [lockUnlock!], ['src/a.ts']);
    expect(violations.length).toBe(1);
    expect(violations[0].caller_name).toBe('fn25');
    expect(violations[0].caller_file).toBe('src/a.ts');
  });

  it('returns empty when no invariants provided', () => {
    const violations = checkInvariantsBroken(db, PROJECT, [], ['src/a.ts']);
    expect(violations).toEqual([]);
  });

  it('returns empty when no files in scope', () => {
    const invariants = discoverInvariants(db, PROJECT);
    const violations = checkInvariantsBroken(db, PROJECT, invariants, []);
    expect(violations).toEqual([]);
  });

  it('returns empty for files not in the index', () => {
    const invariants = discoverInvariants(db, PROJECT);
    const violations = checkInvariantsBroken(db, PROJECT, invariants, ['src/nonexistent.ts']);
    expect(violations).toEqual([]);
  });

  it('does not flag when all callers respect the invariant', () => {
    const invariants = discoverInvariants(db, PROJECT);
    // fn25 violates, fn20–24 don't — check a file that has only the good ones
    // All callers are in src/a.ts though. Let's test with unlock→lock (reverse)
    const unlockLock = invariants.find(
      inv => inv.from_name === 'unlock' && inv.to_name === 'lock'
    );
    expect(unlockLock).toBeDefined();
    // All 5 unlock callers also call lock → no violations
    const violations = checkInvariantsBroken(db, PROJECT, [unlockLock!], ['src/a.ts']);
    expect(violations.length).toBe(0);
  });
});
