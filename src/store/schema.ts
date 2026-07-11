/*
 * schema.ts — Schema introspection for the Lynx graph store.
 *
 * Returns label/type counts, sample entities, and relationship patterns.
 */

import type { LynxDatabase } from './database.js';

export interface LynxSchemaInfo {
  nodeLabels: { label: string; count: number; properties: string[] }[];
  edgeTypes: { type: string; count: number }[];
  relPatterns: string[];
  sampleFunctionNames: string[];
  sampleClassNames: string[];
}

export function getSchema(db: LynxDatabase, project: string): LynxSchemaInfo {
  // Node labels with counts
  const nodeLabels = db.db
    .prepare(
      'SELECT kind as label, COUNT(*) as count FROM nodes WHERE project = ? GROUP BY kind ORDER BY count DESC'
    )
    .all(project) as { label: string; count: number }[];

  // For each label, collect distinct property keys from the JSON properties column
  const labelsWithProps = nodeLabels.map((nl) => {
    const rows = db.db
      .prepare(
        `SELECT DISTINCT key FROM nodes, json_each(properties) WHERE project = ? AND kind = ?`
      )
      .all(project, nl.label) as { key: string }[];
    return { ...nl, properties: rows.map((r) => r.key) };
  });

  // Edge types with counts
  const edgeTypes = db.db
    .prepare(
      'SELECT type, COUNT(*) as count FROM edges WHERE project = ? GROUP BY type ORDER BY count DESC'
    )
    .all(project) as { type: string; count: number }[];

  // Relationship patterns: (Source)-[TYPE]->(Target)
  const relPatterns = db.db
    .prepare(
      `SELECT DISTINCT
         ns.kind as source_kind, e.type, nt.kind as target_kind,
         COUNT(*) as cnt
       FROM edges e
       JOIN nodes ns ON e.source_id = ns.id
       JOIN nodes nt ON e.target_id = nt.id
       WHERE e.project = ?
       GROUP BY source_kind, e.type, target_kind
       ORDER BY cnt DESC
       LIMIT 30`
    )
    .all(project)
    .map(
      (r: unknown) => {
        const row = r as { source_kind: string; type: string; target_kind: string; cnt: number };
        return `(${row.source_kind})-[${row.type}]->(${row.target_kind}) [${row.cnt}x]`;
      }
    );

  // Samples
  const sampleFunctionNames = db.db
    .prepare(
      'SELECT name FROM nodes WHERE project = ? AND kind = ? ORDER BY RANDOM() LIMIT 10'
    )
    .all(project, 'Function')
    .map((r: unknown) => (r as { name: string }).name);

  const sampleClassNames = db.db
    .prepare(
      'SELECT name FROM nodes WHERE project = ? AND kind IN (?, ?) ORDER BY RANDOM() LIMIT 10'
    )
    .all(project, 'Class', 'Interface')
    .map((r: unknown) => (r as { name: string }).name);

  return {
    nodeLabels: labelsWithProps,
    edgeTypes,
    relPatterns,
    sampleFunctionNames,
    sampleClassNames,
  };
}
