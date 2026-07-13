import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  close: vi.fn(),
  get: vi.fn(),
  prepare: vi.fn(),
  openProject: vi.fn(),
}));

vi.mock('../../../src/store/database.js', () => ({
  LynxDatabase: { openProject: handlers.openProject },
}));

import { cmdStatus } from '../../../src/cli/commands/status-cmd.js';

afterEach(() => vi.restoreAllMocks());

describe('status CLI command', () => {
  it('prints project node and edge counts', () => {
    handlers.get.mockReturnValueOnce({ cnt: 10 }).mockReturnValueOnce({ cnt: 20 });
    handlers.prepare.mockReturnValue({ get: handlers.get });
    handlers.openProject.mockReturnValue({ db: { prepare: handlers.prepare }, close: handlers.close });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdStatus(['TEST']);

    expect(log).toHaveBeenNthCalledWith(1, 'Project: TEST');
    expect(log).toHaveBeenNthCalledWith(2, 'Nodes: 10, Edges: 20');
    expect(handlers.close).toHaveBeenCalledOnce();
  });
});
