import { describe, expect, it } from 'vitest';
import { FileWatcher } from '../../../src/watcher/file-watcher.js';

describe('FileWatcher batching', () => {
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
