import { afterEach, describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { handleCompareRuns } from '../../../src/mcp/handlers/compare_runs.js';
import { setDb, unsetDb } from '../../../src/mcp/server.js';

const PROJECT = 'compare-runs-conditions';

describe('compare_runs comparability', () => {
  afterEach(() => unsetDb(PROJECT, { close: false }));

  it('warns when deltas compare different modes or an empty run', async () => {
    const db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, process.cwd());
    db.db.prepare(`INSERT INTO index_runs (project, run_at, total_nodes, total_edges, hotspot_count, avg_complexity, files_processed, files_skipped, mode) VALUES (?, ?, 10, 20, 1, 1, 0, 10, 'fast')`).run(PROJECT, '2026-01-01T00:00:00.000Z');
    db.db.prepare(`INSERT INTO index_runs (project, run_at, total_nodes, total_edges, hotspot_count, avg_complexity, files_processed, files_skipped, mode) VALUES (?, ?, 30, 40, 1, 1, 10, 0, 'moderate')`).run(PROJECT, '2026-01-01T01:00:00.000Z');
    setDb(PROJECT, db);

    const result = await handleCompareRuns({ project: PROJECT }) as { comparison: { comparable: boolean; comparability_warning: string | null } };
    expect(result.comparison.comparable).toBe(false);
    expect(result.comparison.comparability_warning).toContain('mode changed');
    expect(result.comparison.comparability_warning).toContain('zero files');
    db.close();
  });
});
