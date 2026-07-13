import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ runReport: vi.fn() }));

vi.mock('../../../src/cli/report.js', () => ({ runReport: handlers.runReport }));

import { cmdReport } from '../../../src/cli/commands/report-cmd.js';

beforeEach(() => vi.clearAllMocks());

describe('report CLI command', () => {
  it('delegates all arguments to runReport', () => {
    const args = ['LYNX'];
    cmdReport(args);
    expect(handlers.runReport).toHaveBeenCalledWith(args);
  });
});