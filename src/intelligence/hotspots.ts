/*
 * hotspots.ts — Hotspot detection: rank functions by fan-in and complexity.
 *
 * Hotspots are functions with unusually high inbound calls or complexity.
 * They're the "busy intersections" of the project — most likely to break
 * when modified and most valuable to test/refactor.
 */

import type { LynxDatabase } from '../store/database.js';
import type { LynxHotspot } from '../types.js';

export function findHotspots(
  db: LynxDatabase,
  project: string,
  limit = 20
): LynxHotspot[] {
  // Hotspot query: rank by fan_in weighted by distinct caller qualified_names.
  // A node with many callers sharing the same generic name (e.g. "handler")
  // gets a lower effective score than one with callers from diverse QNs.
  const rows = db.db
    .prepare(
      `SELECT * FROM (
         SELECT n.name, n.qualified_name, n.file_path,
                n.properties,
                (SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id AND e.type = 'CALLS') as fan_in,
                (SELECT COUNT(DISTINCT caller.qualified_name)
                 FROM edges e
                 JOIN nodes caller ON caller.id = e.source_id
                 WHERE e.target_id = n.id AND e.type = 'CALLS'
                   AND caller.qualified_name IS NOT NULL
                   AND caller.qualified_name != '') as distinct_callers
         FROM nodes n
         WHERE n.project = ? AND n.kind IN ('Function', 'Method')
       ) WHERE fan_in > 0
       ORDER BY (fan_in * 0.4 + distinct_callers * 0.6) DESC
       LIMIT ?`
    )
    .all(project, limit) as {
    name: string;
    qualified_name: string;
    file_path: string;
    properties: string;
    fan_in: number;
  }[];

  return rows.map((r) => {
    let complexity = 0;
    try {
      const props = JSON.parse(r.properties || '{}');
      complexity = props.cyclomaticComplexity || props.complexity || 0;
    } catch {
      // ignore
    }
    return {
      name: r.name,
      qualifiedName: r.qualified_name,
      fanIn: r.fan_in,
      filePath: r.file_path,
      complexity,
    };
  });
}

/**
 * Find "god components" — modules or classes that are too large.
 */
export function findGodComponents(
  db: LynxDatabase,
  project: string,
  minLines = 1000
): LynxHotspot[] {
  const rows = db.db
    .prepare(
      `SELECT n.name, n.qualified_name, n.file_path, n.properties,
              json_extract(n.properties, '$.lineCount') as line_count
       FROM nodes n
       WHERE n.project = ? AND n.kind IN ('Function', 'Class', 'Method')
         AND CAST(json_extract(n.properties, '$.lineCount') AS INTEGER) >= ?
       ORDER BY CAST(json_extract(n.properties, '$.lineCount') AS INTEGER) DESC
       LIMIT 20`
    )
    .all(project, minLines) as {
    name: string;
    qualified_name: string;
    file_path: string;
    properties: string;
    line_count: number;
  }[];

  return rows.map((r) => ({
    name: r.name,
    qualifiedName: r.qualified_name,
    fanIn: 0,
    filePath: r.file_path,
    complexity: r.line_count,
  }));
}
