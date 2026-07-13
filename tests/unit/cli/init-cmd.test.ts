import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ runInit: vi.fn() }));

vi.mock('../../../src/install/index.js', () => ({ runInit: handlers.runInit }));

import { cmdInit } from '../../../src/cli/commands/init-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('init CLI command', () => {
  it('delegates dryRun flag to runInit', () => {
    cmdInit(['--dry-run']);
    expect(handlers.runInit).toHaveBeenCalledWith(true);
  });

  it('delegates false when no flag is present', () => {
    cmdInit([]);
    expect(handlers.runInit).toHaveBeenCalledWith(false);
  });
});
