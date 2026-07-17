import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPkg: vi.fn(() => true),
  rollbackDistribution: vi.fn(),
  verifyMcpServer: vi.fn(async () => ({
    ok: true,
    expected: 33,
    discovered: 33,
    missing: [],
    error: null,
  })),
}));

vi.mock('../../../src/paths.js', () => ({ isPkg: mocks.isPkg }));
vi.mock('../../../src/install/distribution.js', () => ({
  rollbackDistribution: mocks.rollbackDistribution,
}));
vi.mock('../../../src/install/mcp-verify.js', () => ({
  verifyMcpServer: mocks.verifyMcpServer,
}));

import { cmdRollback } from '../../../src/cli/commands/rollback-cmd.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPkg.mockReturnValue(true);
  mocks.rollbackDistribution.mockImplementation(async (_path, accept) => accept('/installed/lynx'));
});

describe('rollback CLI command', () => {
  it('restores a packaged distribution only after MCP acceptance', async () => {
    await cmdRollback([]);
    expect(mocks.rollbackDistribution).toHaveBeenCalledWith(process.execPath, expect.any(Function));
    expect(mocks.verifyMcpServer).toHaveBeenCalledWith('/installed/lynx', ['serve']);
  });

  it('rejects source-linked checkouts before touching the distribution', async () => {
    mocks.isPkg.mockReturnValue(false);
    await expect(cmdRollback([])).rejects.toThrow('source-linked');
    expect(mocks.rollbackDistribution).not.toHaveBeenCalled();
  });

  it('propagates MCP rejection so the transaction restores the current build', async () => {
    mocks.verifyMcpServer.mockResolvedValueOnce({
      ok: false,
      expected: 33,
      discovered: 32,
      missing: ['trace_path'],
      error: null,
    });
    await expect(cmdRollback([])).rejects.toThrow('32/33');
  });
});
