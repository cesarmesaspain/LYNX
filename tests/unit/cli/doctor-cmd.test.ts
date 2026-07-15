import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  runDoctor: vi.fn(),
}));

vi.mock('../../../src/install/doctor.js', () => ({
  runDoctor: handlers.runDoctor,
}));

import { cmdDoctor } from '../../../src/cli/commands/doctor-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('doctor CLI command', () => {
  it('delegates to runDoctor', async () => {
    await cmdDoctor();
    expect(handlers.runDoctor).toHaveBeenCalledTimes(1);
  });
});