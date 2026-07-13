import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../src/store/database.js';
import { getCachedLlmSummary, upsertCachedLlmSummary } from '../../src/store/memory.js';

describe('persistent LLM summary cache', () => {
  it('persists a summary with measurable token savings', () => {
    const db = LynxDatabase.openMemory();
    upsertCachedLlmSummary(db, 'project', 'hash', 'short summary', 400, 4);
    expect(getCachedLlmSummary(db, 'project', 'hash')).toEqual({
      summary: 'short summary', sourceTokensEst: 400, summaryTokensEst: 4,
    });
    db.close();
  });
});
