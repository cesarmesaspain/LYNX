import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLynxHome } from '../../../src/config/runtime.js';
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


describe('LynxDatabase project paths', () => {
  it('rejects project names that escape the configured database directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-project-path-'));
    const escapedPath = path.resolve(home, 'dbs', '../../escape-proof.db');

    try {
      withLynxHome(home, () => {
        expect(() => LynxDatabase.openProject('../../escape-proof')).toThrow(/project name/i);
      });
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(escapedPath, { force: true });
    }
  });
});
