/*
 * analyze_hotspots — LYNX's KEY DIFFERENTIATOR.
 *
 * Hotspot analysis with narrative explanations in Spanish.
 * Returns the N riskiest functions/classes with:
 *  - Fan-in score (how many things depend on this)
 *  - Complexity metrics (cyclomatic, cognitive, loop depth)
 *  - A human-readable narrative explaining WHY it's risky
 *  - Suggestions for remediation
 */

import { getDb } from '../server.js';
import { findHotspots, findGodComponents } from '../../intelligence/hotspots.js';
import { explainHotspot } from '../../intelligence/narrative.js';
import { projectNotIndexed } from '../diagnostics.js';

export async function handleAnalyzeHotspots(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const topN = args.limit ? Number(args.limit) : (args.top_n ? Number(args.top_n) : 10);
  const includeGod = args.include_god_components !== false;

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) return { ...projectNotIndexed(project) };

  const hotspots = findHotspots(db, project, topN);
  const godComponents = includeGod ? findGodComponents(db, project, 5) : [];
  const largestFiles = db.db.prepare(`
    SELECT file_path AS file, end_line AS lines
    FROM nodes
    WHERE project = ? AND kind = 'File'
    ORDER BY end_line DESC
    LIMIT ?
  `).all(project, topN) as Array<{ file: string; lines: number }>;
  const tightestCoupling = db.db.prepare(`
    SELECT n.name, n.qualified_name, n.file_path,
           COUNT(e.id) AS fan_in
    FROM nodes n
    JOIN edges e ON e.project = n.project AND e.target_id = n.id
    WHERE n.project = ?
      AND n.kind IN ('Function', 'Method', 'Class', 'Module')
    GROUP BY n.id
    ORDER BY fan_in DESC
    LIMIT ?
  `).all(project, topN) as Array<{
    name: string;
    qualified_name: string;
    file_path: string;
    fan_in: number;
  }>;

  // Compute project-wide stats
  const stats = db.db
    .prepare(
      `SELECT
        COUNT(*) as total_nodes,
        AVG(json_extract(properties, '$.cyclomaticComplexity')) as avg_cyclomatic,
        AVG(json_extract(properties, '$.cognitiveComplexity')) as avg_cognitive,
        AVG(json_extract(properties, '$.loopDepth')) as avg_loop_depth
      FROM nodes WHERE project = ? AND kind IN ('Function', 'Method')`
    )
    .get(project) as {
    total_nodes: number;
    avg_cyclomatic: number;
    avg_cognitive: number;
    avg_loop_depth: number;
  };

  const hotspotResults = hotspots.map((h) => {
    const narrative = explainHotspot(h);

    return {
      name: h.name,
      qualified_name: h.qualifiedName,
      file_path: h.filePath,
      fan_in: h.fanIn,
      complexity: h.complexity,
      risk_level: narrative.riskLevel,
      summary: narrative.summary,
      details: narrative.details,
    };
  });

  const godResults = godComponents.map((g) => ({
    name: g.name,
    qualified_name: g.qualifiedName,
    file_path: g.filePath,
    lines: g.complexity,
    risk_level: 'GOD_COMPONENT',
    explanation: `Componente de ${g.complexity} lineas — extremadamente grande y dificil de mantener. Considera dividirlo en modulos mas pequenos.`,
  }));

  return {
    project,
    project_stats: {
      total_functions: stats.total_nodes,
      avg_cyclomatic: Math.round((stats.avg_cyclomatic || 0) * 100) / 100,
      avg_cognitive: Math.round((stats.avg_cognitive || 0) * 100) / 100,
      avg_loop_depth: Math.round((stats.avg_loop_depth || 0) * 100) / 100,
    },
    hotspots: hotspotResults,
    largest_files: largestFiles,
    most_complex: hotspotResults.map((hotspot) => ({
      name: hotspot.name,
      qualified_name: hotspot.qualified_name,
      file_path: hotspot.file_path,
      complexity: hotspot.complexity,
    })),
    tightest_coupling: tightestCoupling,
    god_components: godResults,
    summary: generateSummary(hotspotResults, godResults),
  };
}

function generateSummary(
  hotspots: Array<{ risk_level: string; summary: string }>,
  godComponents: Array<{ risk_level: string; explanation: string }>
): string {
  const critical = hotspots.filter((h) => h.risk_level === 'critico').length;
  const high = hotspots.filter((h) => h.risk_level === 'alto').length;
  const medium = hotspots.filter((h) => h.risk_level === 'medio').length;

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} hotspots CRÍTICOS requieren atención inmediata`);
  if (high > 0) parts.push(`${high} hotspots de riesgo ALTO`);
  if (medium > 0) parts.push(`${medium} hotspots de riesgo MEDIO`);
  if (godComponents.length > 0)
    parts.push(`${godComponents.length} god components detectados`);

  if (parts.length === 0) return 'El proyecto luce saludable — sin hotspots críticos detectados.';
  return parts.join('. ') + '.';
}
