import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getProjectWatcherStatus: vi.fn(),
  startProjectWatcher: vi.fn(),
  stopProjectWatcher: vi.fn(),
}));

vi.mock('../../../src/mcp/server.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/watcher/watcher-manager.js', () => ({
  getProjectWatcherStatus: mocks.getProjectWatcherStatus,
  startProjectWatcher: mocks.startProjectWatcher,
  stopProjectWatcher: mocks.stopProjectWatcher,
}));

import { handleWatchProject } from '../../../src/mcp/handlers/watch_project.js';

const status = { watching: true, paused: false, filesWatched: 12, pendingChanges: 0, lastActivity: null, changesProcessed: 0 };

describe('handleWatchProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ getProject: vi.fn(() => ({ rootPath: '/repo' })) });
  });

  it('validates the project and action', async () => {
    await expect(handleWatchProject({})).resolves.toEqual({ error: 'project is required' });
    await expect(handleWatchProject({ project: 'p', action: 'bad' })).resolves.toEqual({ error: 'Unknown action: bad. Use: start, stop, status.' });
  });

  it('starts a watcher with the requested mode', async () => {
    mocks.getProjectWatcherStatus.mockReturnValue(null);
    mocks.startProjectWatcher.mockReturnValue({ status });

    const result = await handleWatchProject({ project: 'p', action: 'start', mode: 'moderate' });

    expect(mocks.startProjectWatcher).toHaveBeenCalledWith('p', '/repo', 'moderate');
    expect(result).toEqual(expect.objectContaining({ action: 'start', status }));
  });

  it('reports an inactive watcher without mutating state', async () => {
    mocks.getProjectWatcherStatus.mockReturnValue(null);

    await expect(handleWatchProject({ project: 'p', action: 'status' })).resolves.toEqual(expect.objectContaining({ active: false }));
  });
});
