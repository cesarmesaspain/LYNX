import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';

describe('LynxDatabase concurrency configuration', () => {
  it('waits briefly for a concurrent SQLite writer instead of failing immediately', () => {
    const db = LynxDatabase.openMemory();
    try {
      expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});
