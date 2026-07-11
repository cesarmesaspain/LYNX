/*
 * analyze.ts — Phase 4: Compute hotspots, clustering, and architecture summary.
 *
 * Runs after nodes and edges are in place. Computes:
 * - Hotspots (high fan-in functions)
 * - Clusters (label propagation communities)
 * - File tree structure
 * - Language/file counts
 *
 * Stores results in the findings table for future reference.
 */

import type { LynxDatabase } from '../../store/database.js';
import { getKindCounts } from '../../store/nodes.js';
import { getEdgeTypeCounts } from '../../store/edges.js';
import { findHotspots } from '../../intelligence/hotspots.js';
import { detectClusters } from '../../intelligence/clustering.js';
import { buildFileTree } from '../../intelligence/complexity.js';
import { saveHotspotSnapshot } from '../../store/memory.js';
import type {
  LynxArchitecture,
  LynxLanguageCount,
  LynxEntryPoint,
  LynxHotspot,
  LynxCluster,
  LynxFileTreeEntry,
} from '../../types.js';

export interface AnalyzeResult {
  architecture: LynxArchitecture;
  clusterCount: number;
  hotspotCount: number;
}

export function analyze(
  db: LynxDatabase,
  project: string
): AnalyzeResult {
  // Language counts
  const fileNodes = db.db
    .prepare("SELECT properties FROM nodes WHERE project = ? AND kind = 'File'")
    .all(project) as { properties: string }[];

  const langMap = new Map<string, number>();
  for (const fn of fileNodes) {
    const props = JSON.parse(fn.properties || '{}');
    const ext = props.extension || 'unknown';
    langMap.set(ext, (langMap.get(ext) || 0) + 1);
  }
  const languages: LynxLanguageCount[] = Array.from(langMap.entries())
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);

  // Entry points
  const entryPointRows = db.db
    .prepare(
      "SELECT name, qualified_name, file_path FROM nodes WHERE project = ? AND is_entry_point = 1 LIMIT 20"
    )
    .all(project) as { name: string; qualified_name: string; file_path: string }[];
  const entryPoints: LynxEntryPoint[] = entryPointRows.map((r) => ({
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
  }));

  // Hotspots — complex query ranking by fan_in
  const hotspots = findHotspots(db, project, 20);

  // Clusters — label propagation community detection
  const clusters = detectClusters(db, project);

  // File tree — hierarchical structure
  const fileTree = buildFileTree(db, project);

  // Node label and edge type counts
  const nodeLabels = getKindCounts(db, project);
  const edgeTypes = getEdgeTypeCounts(db, project);

  const totalNodes = nodeLabels.reduce((sum, nl) => sum + nl.count, 0);
  const totalEdges = edgeTypes.reduce((sum, et) => sum + et.count, 0);

  const architecture: LynxArchitecture = {
    languages,
    entryPoints,
    hotspots,
    clusters,
    fileTree,
    totalNodes,
    totalEdges,
    nodeLabels,
    edgeTypes,
  };

  // Save hotspot snapshot to findings (persistent memory)
  saveHotspotSnapshot(
    db,
    project,
    hotspots.map((hs) => ({
      qn: hs.qualifiedName,
      file: hs.filePath,
      fanIn: hs.fanIn,
      complexity: hs.complexity,
    }))
  );

  return {
    architecture,
    clusterCount: clusters.length,
    hotspotCount: hotspots.length,
  };
}
