import { afterEach, describe, expect, it } from 'vitest';
import { handleBatchGetCode } from '../../../src/mcp/handlers/batch_get_code.js';
import { unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'batch-unknown';

afterEach(() => unsetDb(PROJECT, { close: true }));

describe('batch_get_code project diagnostics', () => {
  it('reports an unindexed project before resolving requested symbols', async () => {
    const result = await handleBatchGetCode({ project: PROJECT, qualified_names: ['app.main'] }) as Record<string, unknown>;
    expect(result.error).toContain('not indexed');
    expect(result.recoverable).toBe(true);
  });
});
