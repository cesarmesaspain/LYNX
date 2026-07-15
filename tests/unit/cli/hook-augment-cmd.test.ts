import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ runHookAugment: vi.fn() }));

vi.mock('../../../src/cli/hook-augment.js', () => ({ runHookAugment: handlers.runHookAugment }));

import { cmdHookAugment } from '../../../src/cli/commands/hook-augment-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('hook-augment CLI command', () => {
  it('delegates to runHookAugment', async () => {
    await cmdHookAugment();
    expect(handlers.runHookAugment).toHaveBeenCalledTimes(1);
  });
});
