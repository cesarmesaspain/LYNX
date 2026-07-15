import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  cmdABBenchmark: vi.fn(),
}));

vi.mock('../../../src/cli/ab-benchmark.js', () => ({
  cmdABBenchmark: handlers.cmdABBenchmark,
}));

import { cmdAB } from '../../../src/cli/commands/ab-cmd.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ab CLI command', () => {
  it('delegates all arguments to cmdABBenchmark', async () => {
    const args = ['--seed', '77', '--tasks', 'find_definition'];

    await cmdAB(args);

    expect(handlers.cmdABBenchmark).toHaveBeenCalledTimes(1);
    expect(handlers.cmdABBenchmark).toHaveBeenCalledWith(args);
  });
});
