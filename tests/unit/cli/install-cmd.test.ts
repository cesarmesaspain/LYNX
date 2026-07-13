import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  runInstall: vi.fn(async () => undefined),
}));

vi.mock('../../../src/install/index.js', () => ({
  runInstall: handlers.runInstall,
}));

import { cmdInstall } from '../../../src/cli/commands/install-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('install CLI command', () => {
  it('passes install flags', async () => {
    await cmdInstall(['--dry-run', '--plan', '--no-auto-index', '--strict']);
    expect(handlers.runInstall).toHaveBeenCalledWith({
      dryRun: true,
      planOnly: true,
      autoIndex: false,
      strict: true,
    });
  });
});
