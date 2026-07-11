/*
 * compare_runs — Compare two index runs to surface trends.
 *
 * Leverages the existing compareRuns() in memory.ts.
 * Returns deltas (nodes, edges, hotspots, complexity) and a narrative
 * summary of what changed between the last two indexing runs.
 */

import { getDb } from '../server.js';
import { compareRuns } from '../../store/memory.js';

export async function handleCompareRuns(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  if (!project) return { error: 'project is required' };

  const db = getDb(project);
  const comparison = compareRuns(db, project);

  if (comparison.runs.length === 0) {
    return {
      project,
      error: 'No index runs found for this project. Run index_repository first.',
    };
  }

  if (comparison.runs.length === 1) {
    return {
      project,
      single_run: {
        id: comparison.runs[0].id,
        run_at: comparison.runs[0].runAt,
        nodes: comparison.runs[0].totalNodes,
        edges: comparison.runs[0].totalEdges,
        hotspots: comparison.runs[0].hotspotCount,
        avg_complexity: comparison.runs[0].avgComplexity,
        files_processed: comparison.runs[0].filesProcessed,
        files_skipped: comparison.runs[0].filesSkipped,
        mode: comparison.runs[0].mode,
      },
      narrative: comparison.narrative,
    };
  }

  return {
    project,
    comparison: {
      latest: {
        id: comparison.runs[0].id,
        run_at: comparison.runs[0].runAt,
        nodes: comparison.runs[0].totalNodes,
        edges: comparison.runs[0].totalEdges,
        hotspots: comparison.runs[0].hotspotCount,
        avg_complexity: comparison.runs[0].avgComplexity,
        files_processed: comparison.runs[0].filesProcessed,
        mode: comparison.runs[0].mode,
      },
      previous: {
        id: comparison.runs[1].id,
        run_at: comparison.runs[1].runAt,
        nodes: comparison.runs[1].totalNodes,
        edges: comparison.runs[1].totalEdges,
        hotspots: comparison.runs[1].hotspotCount,
        avg_complexity: comparison.runs[1].avgComplexity,
        files_processed: comparison.runs[1].filesProcessed,
        mode: comparison.runs[1].mode,
      },
      deltas: {
        nodes: comparison.deltaNodes,
        edges: comparison.deltaEdges,
        hotspots: comparison.deltaHotspots,
        avg_complexity: comparison.deltaAvgComplexity,
      },
      narrative: comparison.narrative,
    },
  };
}
