import { describe, expect, it } from 'vitest';
import { FileWatcher, findInboundDependentFiles } from '../../../src/watcher/file-watcher.js';
import { LynxDatabase } from '../../../src/store/database.js';

describe('FileWatcher batching', () => {
  it('captures unchanged source files whose edges will be invalidated', () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject('watcher-test', process.cwd());
    db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
      VALUES (1, 'watcher-test', 'File', 'server.test.ts', 'file.test', 'src/server.test.ts', 1, 1, 0, 1, 0, '{}'),
             (2, 'watcher-test', 'File', 'server.ts', 'file.server', 'src/server.ts', 1, 1, 0, 0, 0, '{}'),
             (3, 'watcher-test', 'Function', 'caller', 'test.caller', 'src/server.test.ts', 1, 1, 0, 1, 0, '{}'),
             (4, 'watcher-test', 'Function', 'target', 'server.target', 'src/server.ts', 1, 1, 0, 0, 0, '{}')`).run();
    db.db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties)
      VALUES ('watcher-test', 1, 2, 'TESTS_FILE', '{}'),
             ('watcher-test', 3, 4, 'TESTS', '{}')`).run();

    expect(findInboundDependentFiles(db, 'watcher-test', 'src/server.ts')).toEqual(['src/server.test.ts']);
    db.close();
  });

  it('serializes a second flush until the first batch has finished', async () => {
    const watcher = new FileWatcher({} as never, '/tmp', 'watcher-test');
    const internal = watcher as any;
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    internal.reindexOneFile = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        signalFirst();
        await firstGate;
      }
      active--;
    };

    internal.pending.add('first.ts');
    const firstFlush = internal.flushPending();
    await firstStarted;

    internal.pending.add('second.ts');
    const secondFlush = internal.flushPending();
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });
});
