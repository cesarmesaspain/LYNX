import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  runBenchmark: vi.fn(),
}));

vi.mock('../../../src/cli/benchmark.js', () => ({
  runBenchmark: handlers.runBenchmark,
}));

import { cmdBenchmark } from '../../../src/cli/commands/benchmark-cmd.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('benchmark CLI command', () => {
  it('delegates all arguments to runBenchmark', async () => {
    const args = ['.', '--name', 'LYNX', '--mode', 'moderate'];

    await cmdBenchmark(args);

    expect(handlers.runBenchmark).toHaveBeenCalledTimes(1);
    expect(handlers.runBenchmark).toHaveBeenCalledWith(args);
  });
});
