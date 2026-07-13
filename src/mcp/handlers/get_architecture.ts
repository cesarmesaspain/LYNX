import { getDb } from '../server.js';
import type { LynxDatabase } from '../../store/database.js';
import { analyze } from '../../pipeline/phases/analyze.js';
import { explainArchitecture } from '../../intelligence/narrative.js';
import { getProjectBrief } from '../../intelligence/project-brief.js';

type Aspect =
  | 'languages' | 'hotspots' | 'clusters' | 'file_tree'
  | 'entry_points' | 'brief' | 'narrative' | 'node_labels' | 'edge_types';

const ALL_ASPECTS: Aspect[] = [
  'languages', 'hotspots', 'clusters', 'file_tree',
  'entry_points', 'brief', 'narrative', 'node_labels', 'edge_types',
];
// A first overview must be cheap enough to guide the next call, not replace
// it with a large cached essay. Ask for `brief` explicitly when needed.
const DEFAULT_ASPECTS: Aspect[] = ['languages', 'narrative'];

export async function handleGetArchitecture(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const scopePath = args.path ? String(args.path) : undefined;
  const aspects: Aspect[] | undefined = args.aspects
    ? (args.aspects as string[]).filter((a): a is Aspect => ALL_ASPECTS.includes(a as Aspect))
    : undefined;

  const requestedAspects = aspects || DEFAULT_ASPECTS;
  const db = getDb(project);

  const nodeCount = db.db
    .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
    .get(project) as { cnt: number };

  if (nodeCount.cnt === 0) {
    return { error: 'Project not indexed. Run index_repository first.', total_nodes: 0, total_edges: 0 };
  }

  const { architecture } = analyze(db, project);
  const result = buildAspectSections(db, project, architecture, requestedAspects, scopePath);

  // Omit message when aspects were filtered
  if (aspects && aspects.length > 0) {
    const omitted = ALL_ASPECTS.filter(a => !aspects.includes(a));
    if (omitted.length > 0) {
      result._omitted_aspects = omitted.join(', ');
      result._omit_note =
        `Usa aspects: [${omitted.map(a => `"${a}"`).join(', ')}] para incluir estas secciones si las necesitas.`;
    }
  }

  return result;
}

// ── Aspect assembly ────────────────────────────────────

function buildAspectSections(
  db: LynxDatabase,
  project: string,
  architecture: ReturnType<typeof analyze>['architecture'],
  requestedAspects: Aspect[],
  scopePath?: string,
): Record<string, unknown> {
  const inScope = scopePath
    ? (fp: string) => fp.startsWith(scopePath)
    : () => true;

  const result: Record<string, unknown> = {
    project,
    total_nodes: architecture.totalNodes,
    total_edges: architecture.totalEdges,
  };
  let tokenEstimate = 80;

  // Brief
  if (requestedAspects.includes('brief')) {
    const brief = getProjectBrief(db, project);
    if (brief) {
      try {
        result.brief = { text: JSON.parse(brief.brief), generated_at: brief.generated_at, cached: true };
      } catch {
        result.brief = { text: brief.brief, generated_at: brief.generated_at, cached: true };
      }
      tokenEstimate += Math.ceil(brief.brief.length / 4);
    }
  }

  // Languages
  if (requestedAspects.includes('languages')) {
    result.languages = architecture.languages;
    tokenEstimate += architecture.languages.length * 15;
  }

  // Entry points
  if (requestedAspects.includes('entry_points')) {
    const eps = scopePath
      ? architecture.entryPoints.filter(e => inScope(e.filePath))
      : architecture.entryPoints;
    result.entry_points = eps.slice(0, 30);
    tokenEstimate += eps.length * 25;
  }

  // Hotspots
  if (requestedAspects.includes('hotspots')) {
    const hots = architecture.hotspots.map(h => ({
      name: h.name, qualified_name: h.qualifiedName,
      fan_in: h.fanIn, file_path: h.filePath, complexity: h.complexity,
    }));
    const truncated = hots.length > 15;
    result.hotspots = hots.slice(0, 15);
    if (truncated) {
      result._hotspots_truncated = `${hots.length - 15} hotspots omitidos para control de tokens`;
      tokenEstimate += 60;
    }
    tokenEstimate += hots.length * 50;
  }

  // Clusters
  if (requestedAspects.includes('clusters')) {
    const clusts = architecture.clusters.map(c => ({
      id: c.id, label: c.label, members: c.members,
      cohesion: c.cohesion, top_nodes: c.topNodes.slice(0, 5),
    }));
    result.clusters = clusts;
    tokenEstimate += clusts.length * 80;
  }

  // File tree
  if (requestedAspects.includes('file_tree')) {
    const tree = scopePath
      ? architecture.fileTree.filter(f => inScope(f.path))
      : architecture.fileTree;
    const limit = 100;
    const truncated = tree.length > limit;
    result.file_tree = tree.slice(0, limit);
    if (truncated) {
      result._file_tree_truncated = `${tree.length - limit} entradas omitidas para control de tokens`;
      tokenEstimate += 50;
    }
    tokenEstimate += Math.min(tree.length, limit) * 12;
  }

  // Node labels
  if (requestedAspects.includes('node_labels')) {
    result.node_labels = architecture.nodeLabels;
    tokenEstimate += architecture.nodeLabels.length * 10;
  }

  // Edge types
  if (requestedAspects.includes('edge_types')) {
    result.edge_types = architecture.edgeTypes;
    tokenEstimate += architecture.edgeTypes.length * 10;
  }

  // Narrative (Spanish)
  if (requestedAspects.includes('narrative')) {
    const godComponents = architecture.hotspots.filter(h => h.complexity > 1000);
    const avgComplexity = architecture.hotspots.length > 0
      ? architecture.hotspots.reduce((sum, h) => sum + h.complexity, 0) / architecture.hotspots.length
      : 0;

    const narrative = explainArchitecture(
      architecture.totalNodes, architecture.totalEdges,
      architecture.hotspots.length, godComponents.length,
      avgComplexity, architecture.languages,
    );

    result.narrative = {
      summary: narrative.summary,
      risk_level: narrative.riskLevel,
      details: narrative.details,
    };
    tokenEstimate += narrative.details.reduce((s, d) => s + d.length, 0) / 4;
  }

  result.token_estimate = Math.round(tokenEstimate);
  return result;
}
