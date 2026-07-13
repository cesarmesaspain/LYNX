import { afterEach, describe, expect, it } from 'vitest';
import { handleGetCodeSnippet } from '../../../src/mcp/handlers/get_code_snippet.js';
import { unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'snippet-unknown';

afterEach(() => unsetDb(PROJECT, { close: true }));

describe('get_code_snippet project diagnostics', () => {
  it('reports an unindexed project before attempting symbol lookup', async () => {
    const result = await handleGetCodeSnippet({ project: PROJECT, qualified_name: 'app.main' }) as Record<string, unknown>;
    expect(result.error).toContain('not indexed');
    expect(result.recoverable).toBe(true);
  });
});
