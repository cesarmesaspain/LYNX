import { describe, expect, it } from 'vitest';
import { FileWatcher, findInboundDependentFiles } from '../../../src/watcher/file-watcher.js';
import { LynxDatabase } from '../../../src/store/database.js';
import { deleteOutgoingEdgesForNodesInFile } from '../../../src/store/edges.js';

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

  it('clears only dependent outbound edges before re-resolution', () => {
    const db = LynxDatabase.openMemory();
    try {
      const project = 'watcher-outbound';
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'Function', 'dependent', 'dependent', 'src/dependent.ts', 1, 1, 0, 0, 0, '{}'),
               (2, ?, 'Function', 'target', 'target', 'src/target.ts', 1, 1, 0, 0, 0, '{}'),
               (3, ?, 'Function', 'caller', 'caller', 'src/caller.ts', 1, 1, 0, 0, 0, '{}')`).run(project, project, project);
      db.db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties)
        VALUES (?, 1, 2, 'CALLS', '{}'), (?, 3, 1, 'CALLS', '{}')`).run(project, project);

      deleteOutgoingEdgesForNodesInFile(db, project, 'src/dependent.ts');

      const rows = db.db.prepare('SELECT source_id, target_id FROM edges WHERE project = ? ORDER BY id')
        .all(project) as Array<{ source_id: number; target_id: number }>;
      expect(rows).toEqual([{ source_id: 3, target_id: 1 }]);
    } finally {
      db.close();
    }
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
