import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  cmdAgentABBenchmark: vi.fn(),
}));

vi.mock('../../../src/cli/agent-ab/cli.js', () => ({
  cmdAgentABBenchmark: handlers.cmdAgentABBenchmark,
}));

import { cmdAgentAB } from '../../../src/cli/commands/agent-ab-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('agent-ab CLI command', () => {
  it('delegates all arguments', async () => {
    const args = ['--suite', 'smoke', '--json'];
    await cmdAgentAB(args);
    expect(handlers.cmdAgentABBenchmark).toHaveBeenCalledTimes(1);
    expect(handlers.cmdAgentABBenchmark).toHaveBeenCalledWith(args);
  });
});