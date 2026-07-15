import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const start = vi.fn(() => {
    throw new Error('watcher start failed');
  });
  const status = vi.fn(() => ({ watching: false }));
  const stop = vi.fn();

  return {
    close,
    start,
    status,
    stop,
    openProject: vi.fn(() => ({ close })),
    FileWatcher: vi.fn(function FileWatcherMock() {
      return { start, status, stop };
    }),
  };
});

vi.mock('../../../src/store/database.js', () => ({
  LynxDatabase: { openProject: mocks.openProject },
}));

vi.mock('../../../src/watcher/file-watcher.js', () => ({
  FileWatcher: mocks.FileWatcher,
}));

import {
  getProjectWatcherStatus,
  startProjectWatcher,
  stopProjectWatcher,
} from '../../../src/watcher/watcher-manager.js';

describe('project watcher manager start failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the database and leaves no registered watcher', async () => {
    expect(() =>
      startProjectWatcher('failing-project', '/tmp/failing-project', 'fast'),
    ).toThrow('watcher start failed');

    expect(mocks.openProject).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(getProjectWatcherStatus('failing-project')).toBeNull();
    expect(await stopProjectWatcher('failing-project')).toBeNull();
  });
});
