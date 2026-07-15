import { getDb } from '../server.js';
import { getEdgeEvidence, semanticRelationship, classifyConfidence, CONFIDENCE_TIERS } from '../../store/edge-evidence.js';

interface SymbolInfo {
  id: number;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

interface PathHop {
  from: string;
  to: string;
  type: string;
  evidence_count: number;
  confidence_tier: string;
  confidence_score: number;
}

function findSymbol(db: ReturnType<typeof getDb>, project: string, name: string): SymbolInfo | undefined {
  return db.db.prepare(
    'SELECT id, name, qualified_name, kind, file_path, start_line, end_line FROM nodes WHERE project = ? AND (name = ? OR qualified_name = ?) LIMIT 1'
  ).get(project, name, name) as SymbolInfo | undefined;
}

// BFS to find shortest path between source and target through CALLS edges, max depth 3.
function findIndirectPath(
  db: ReturnType<typeof getDb>,
  project: string,
  sourceId: number,
  targetId: number,
  maxDepth: number = 3,
): PathHop[] | null {
  const visited = new Set<number>([sourceId]);
  const queue: Array<{ nodeId: number; path: PathHop[] }> = [{ nodeId: sourceId, path: [] }];

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;
    if (path.length >= maxDepth) continue;

    const edges = db.db.prepare(
      'SELECT e.id, e.type, e.target_id, n.name, n.qualified_name FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.project = ? AND e.source_id = ? AND e.type = ?'
    ).all(project, nodeId, 'CALLS') as Array<{ id: number; type: string; target_id: number; name: string; qualified_name: string }>;

    for (const edge of edges) {
      if (visited.has(edge.target_id)) continue;
      visited.add(edge.target_id);

      const evidenceRecords = getEdgeEvidence(db, project, edge.id);
      const strengths = evidenceRecords.map(e => e.strength);
      const confidenceScore = evidenceRecords.length > 0 ? Math.max(...strengths) : 0.8;
      const { tier } = classifyConfidence(
        evidenceRecords.length > 0 ? String(evidenceRecords[0].extractor || '') : '',
        confidenceScore,
      );

      const hop: PathHop = {
        from: edges.length > 0 ? '' : '',
        to: edge.name,
        type: edge.type,
        evidence_count: evidenceRecords.length,
        confidence_tier: tier,
        confidence_score: Math.round(confidenceScore * 100) / 100,
      };

      const newPath = [...path, hop];

      if (edge.target_id === targetId) {
        return newPath;
      }

      queue.push({ nodeId: edge.target_id, path: newPath });
    }
  }

  return null;
}

function buildDirectResponse(
  db: ReturnType<typeof getDb>,
  project: string,
  edge: Record<string, unknown>,
  source: SymbolInfo,
  target: SymbolInfo,
) {
  const edgeTypeStr = String(edge.type || '');
  const relationship = semanticRelationship(source, target, edgeTypeStr);
  const evidence = getEdgeEvidence(db, project, Number(edge.id));

  let confidenceScore = 0.8;
  let confidenceTier = 'resolver';
  if (evidence.length > 0) {
    const strengths = evidence.map(e => e.strength);
    confidenceScore = Math.max(...strengths);
    const { tier } = classifyConfidence(String(evidence[0].extractor || ''), confidenceScore);
    confidenceTier = tier;
  }

  const sourceLocation = {
    file: source.file_path,
    name: source.name,
    qualified_name: source.qualified_name,
    kind: source.kind,
    ...(source.start_line ? { lines: source.end_line && source.end_line !== source.start_line ? `${source.start_line}-${source.end_line}` : String(source.start_line) } : {}),
  };

  const targetLocation = {
    file: target.file_path,
    name: target.name,
    qualified_name: target.qualified_name,
    kind: target.kind,
    ...(target.start_line ? { lines: target.end_line && target.end_line !== target.start_line ? `${target.start_line}-${target.end_line}` : String(target.start_line) } : {}),
  };

  const evidenceChain = evidence.map(e => {
    const loc = e.source_path
      ? `${e.source_path}${e.start_line ? ` line ${e.start_line}${e.end_line && e.end_line !== e.start_line ? `-${e.end_line}` : ''}` : ''}`
      : null;
    return {
      why: loc ? `Found ${e.evidence_type} in ${loc}` : `${e.evidence_type} captured by ${e.extractor}`,
      evidence_type: e.evidence_type,
      extractor: e.extractor,
      source_kind: e.source_kind,
      strength: e.strength,
      location: loc,
      payload: e.payload,
    };
  });

  return {
    relationship,
    confidence: { score: Math.round(confidenceScore * 100) / 100, tier: confidenceTier, label: CONFIDENCE_TIERS[confidenceTier as keyof typeof CONFIDENCE_TIERS]?.label ?? '' },
    source_location: sourceLocation,
    target_location: targetLocation,
    evidence_chain: evidenceChain,
    edge: { ...edge, source, target },
    evidence,
    evidence_count: evidence.length,
    verified: evidence.length > 0,
    explanation: evidence.length > 0
      ? `${relationship} — verified by ${evidence.length} evidence record(s) at confidence ${confidenceTier} (${Math.round(confidenceScore * 100)}%).`
      : `Relationship ${relationship} exists but no captured evidence record was found.`,
  };
}

export async function handleGetEdgeEvidence(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const project = String(args.project || '');
  const edgeId = Number(args.edge_id || 0);
  const sourceName = String(args.source_name || '');
  const targetName = String(args.target_name || '');
  const edgeType = String(args.type || '');

  if (!project) return { error: 'project is required' };
  if (!edgeId && (!sourceName || !targetName)) return { error: 'edge_id or source_name and target_name are required' };

  const db = getDb(project);

  // Direct edge lookup by ID
  if (edgeId) {
    const edge = db.db.prepare('SELECT id, source_id, target_id, type, properties FROM edges WHERE id = ? AND project = ?').get(edgeId, project) as Record<string, unknown> | undefined;
    if (!edge) return { error: 'edge not found', edge_id: edgeId };
    const source = db.db.prepare('SELECT name, qualified_name, kind, file_path, start_line, end_line FROM nodes WHERE id = ?').get(edge.source_id) as SymbolInfo | undefined;
    const target = db.db.prepare('SELECT name, qualified_name, kind, file_path, start_line, end_line FROM nodes WHERE id = ?').get(edge.target_id) as SymbolInfo | undefined;
    if (!source || !target) return { error: 'source or target node not found' };
    return buildDirectResponse(db, project, edge, source, target);
  }

  // Resolve symbols
  const source = findSymbol(db, project, sourceName);
  const target = findSymbol(db, project, targetName);

  if (!source || !target) {
    const missing = !source ? sourceName : targetName;
    return {
      error: `Symbol not found: ${missing}`,
      source_found: !!source,
      target_found: !!target,
      hint: 'Check spelling or try lynx search to find the correct qualified_name.',
    };
  }

  // Try direct edge
  const sql = 'SELECT id, source_id, target_id, type, properties FROM edges WHERE project = ? AND source_id = ? AND target_id = ?' + (edgeType ? ' AND type = ?' : '') + ' LIMIT 1';
  const params = edgeType ? [project, source.id, target.id, edgeType] : [project, source.id, target.id];
  const directEdge = db.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;

  if (directEdge) {
    return buildDirectResponse(db, project, directEdge, source, target);
  }

  // No direct edge — search for indirect path
  const indirectPath = findIndirectPath(db, project, source.id, target.id, 3);

  // Also list all direct edges from source and to target for context
  const outgoingEdges = db.db.prepare(
    'SELECT e.type, n.name, n.qualified_name, n.kind FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.project = ? AND e.source_id = ? LIMIT 10'
  ).all(project, source.id) as Array<{ type: string; name: string; qualified_name: string; kind: string }>;

  const incomingEdges = db.db.prepare(
    'SELECT e.type, n.name, n.qualified_name, n.kind FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.project = ? AND e.target_id = ? LIMIT 10'
  ).all(project, target.id) as Array<{ type: string; name: string; qualified_name: string; kind: string }>;

  return {
    relationship: `No direct edge found between ${source.name} and ${target.name}`,
    direct_edge: false,
    source_location: {
      file: source.file_path,
      name: source.name,
      qualified_name: source.qualified_name,
      kind: source.kind,
      ...(source.start_line ? { lines: `${source.start_line}-${source.end_line}` } : {}),
    },
    target_location: {
      file: target.file_path,
      name: target.name,
      qualified_name: target.qualified_name,
      kind: target.kind,
    },
    indirect_path: indirectPath
      ? {
          hops: indirectPath,
          summary: [source.name, ...indirectPath.map(h => h.to), target.name].join(' → '),
          total_hops: indirectPath.length + 1,
        }
      : null,
    closest_evidence: {
      outgoing_from_source: outgoingEdges.map(e => ({ type: e.type, target: e.name, qualified_name: e.qualified_name })),
      incoming_to_target: incomingEdges.map(e => ({ type: e.type, source: e.name, qualified_name: e.qualified_name })),
    },
    hint: indirectPath
      ? 'Indirect path found. Use lynx evidence on intermediate hops for full evidence details.'
      : 'No path found within 3 hops. Try broadening the search scope or verify the symbols are in the same project.',
  };
}
