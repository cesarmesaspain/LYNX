import type { LynxDatabase } from './database.js';

// ── Evidence taxonomy (improvement #3) ─────────────────────────────

export const EVIDENCE_TYPES = [
  'CALL_EXPRESSION',
  'IMPORT_STATEMENT',
  'TYPE_REFERENCE',
  'TEST_REFERENCE',
  'INHERITANCE',
  'ROUTE_REFERENCE',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Contract shapes each evidence type MUST satisfy when populated as payload_json. */
export const EVIDENCE_CONTRACTS: Record<EvidenceType, Record<string, string>> = {
  CALL_EXPRESSION: {
    caller_line: 'number — line where the call expression appears',
    callee_name: 'string — name of the called function/method',
    syntax: 'string — the call syntax snippet (e.g. "openDb(config)")',
  },
  IMPORT_STATEMENT: {
    imported_symbol: 'string — symbol imported',
    imported_from: 'string — source module path',
    import_line: 'number — line of the import statement',
  },
  TYPE_REFERENCE: {
    type_name: 'string — referenced type name',
    context: 'string — where the type is used (e.g. "type annotation", "generic parameter")',
    context_line: 'number — line where the type reference appears',
  },
  TEST_REFERENCE: {
    test_name: 'string — test function name',
    test_file: 'string — path to the test file',
    test_line: 'number — line of the test reference',
  },
  INHERITANCE: {
    base_class: 'string — parent class name',
    derived_class: 'string — child class name',
    extends_line: 'number — line of the extends/implements clause',
  },
  ROUTE_REFERENCE: {
    route_path: 'string — URL path pattern',
    handler: 'string — handler function name',
    method: 'string — HTTP method (GET, POST, etc.)',
  },
};

export function isKnownEvidenceType(t: string): t is EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(t);
}

// ── Confidence tiers (improvement #4) ─────────────────────────────

/**
 * Confidence tier assigned to each evidence record.
 *
 *   exact_ast   0.98 — direct AST extraction (tsc, babel, tree-sitter)
 *   resolver    0.85 — inferred by the resolver from structural cues
 *   heuristic   0.60 — semantic / name-based / proximity guess
 */
export type ConfidenceTier = 'exact_ast' | 'resolver' | 'heuristic';

export const CONFIDENCE_TIERS: Record<ConfidenceTier, { strength: number; label: string }> = {
  exact_ast:   { strength: 0.98, label: 'Exact AST match — extractor confirmed the relationship directly from syntax.' },
  resolver:    { strength: 0.85, label: 'Resolver inference — relationship deduced from structural analysis (same file, import/export graph, scope resolution).' },
  heuristic:   { strength: 0.60, label: 'Semantic guess — relationship suggested by name similarity, proximity, or probabilistic heuristics.' },
};

export function classifyConfidence(extractor: string, strength: number): { tier: ConfidenceTier; strength: number } {
  const normalisedExtractor = extractor.toLowerCase();
  // AST-backed extractors get exact_ast
  if (/\b(tsc|babel|tree.sitter|swift.?syntax|clang|rust.?analyzer|gopls|php.?parser)\b/i.test(normalisedExtractor)) {
    return { tier: 'exact_ast', strength: CONFIDENCE_TIERS.exact_ast.strength };
  }
  // Resolver
  if (/\b(resolve|import.?graph|call.?graph|type.?resolve|dependency.?graph)\b/i.test(normalisedExtractor)) {
    return { tier: 'resolver', strength: CONFIDENCE_TIERS.resolver.strength };
  }
  // If the stored strength is near a known tier, use it as signal
  if (strength >= 0.95) return { tier: 'exact_ast', strength: CONFIDENCE_TIERS.exact_ast.strength };
  if (strength >= 0.80) return { tier: 'resolver', strength: CONFIDENCE_TIERS.resolver.strength };
  return { tier: 'heuristic', strength: CONFIDENCE_TIERS.heuristic.strength };
}

// ── Exported types ────────────────────────────────────────────────

export interface EdgeEvidenceSummary {
  type: string;
  direction: string;
  symbol: string;
  qualified_name: string;
  evidence_count: number;
  strongest_evidence: unknown;
}

export interface EdgeEvidenceRecord {
  id: number;
  evidence_type: string;
  source_kind: string;
  source_path: string | null;
  start_line: number | null;
  end_line: number | null;
  extractor: string;
  strength: number;
  payload_json: string;
  created_at: string;
  payload: unknown;
  confidence_tier?: string;
  confidence_label?: string;
}

// ── Semantic evidence (improvement #1) ────────────────────────────

/**
 * Build a human-readable relationship phrase for an edge, e.g.
 * "readConfig calls openDb" or "Config is imported by App".
 */
export function semanticRelationship(
  source: { name: string; qualified_name: string; kind: string } | undefined,
  target: { name: string; qualified_name: string; kind: string } | undefined,
  edgeType: string,
): string {
  const src = source?.name ?? '?';
  const tgt = target?.name ?? '?';
  switch (edgeType) {
    case 'CALLS':        return `${src} calls ${tgt}`;
    case 'HTTP_CALLS':   return `${src} makes HTTP request to ${tgt}`;
    case 'ASYNC_CALLS':  return `${src} awaits ${tgt}`;
    case 'IMPORTS':      return `${src} imports ${tgt}`;
    case 'USAGE':        return `${src} uses ${tgt}`;
    case 'READS':        return `${src} reads ${tgt}`;
    case 'WRITES':       return `${src} writes ${tgt}`;
    case 'TESTS':        return `${src} tests ${tgt}`;
    case 'INHERITS':     return `${src} inherits from ${tgt}`;
    case 'IMPLEMENTS':   return `${src} implements ${tgt}`;
    case 'REFERENCES':   return `${src} references ${tgt}`;
    default:             return `${src} ${edgeType.toLowerCase()} ${tgt}`;
  }
}

// ── Query functions ───────────────────────────────────────────────

export function getNodeEdgeEvidence(db: LynxDatabase, project: string, nodeId: number, limit = 5): EdgeEvidenceSummary[] {
  const sql = 'SELECT e.type, CASE WHEN e.source_id = ? THEN ' + String.fromCharCode(39) + 'outgoing' + String.fromCharCode(39) + ' ELSE ' + String.fromCharCode(39) + 'incoming' + String.fromCharCode(39) + ' END AS direction, n.name, n.qualified_name, COUNT(ev.id) AS evidence_count, MAX(ev.strength) AS strongest_strength FROM edges e JOIN nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END LEFT JOIN edge_evidence ev ON ev.edge_id = e.id AND ev.project = e.project WHERE e.project = ? AND (e.source_id = ? OR e.target_id = ?) GROUP BY e.id ORDER BY evidence_count DESC, strongest_strength DESC LIMIT ?'; return db.db.prepare(sql).all(nodeId,nodeId,project,nodeId,nodeId,limit).map((row:any)=>({type:row.type,direction:row.direction,symbol:row.name,qualified_name:row.qualified_name,evidence_count:Number(row.evidence_count||0),strongest_evidence:row.strongest_strength}));
}

export function getEdgeEvidence(db: LynxDatabase, project: string, edgeId: number): EdgeEvidenceRecord[] {
  const sql = 'SELECT id, evidence_type, source_kind, source_path, start_line, end_line, extractor, strength, payload_json, created_at FROM edge_evidence WHERE edge_id = ? AND project = ? ORDER BY strength DESC, id ASC';
  return db.db.prepare(sql).all(edgeId, project).map((row: any) => {
    let payload: unknown = {};
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    const { tier } = classifyConfidence(row.extractor, row.strength);
    return {
      ...row,
      payload,
      confidence_tier: tier,
      confidence_label: CONFIDENCE_TIERS[tier].label,
    };
  });
}

/**
 * Bulk-fetch evidence for multiple edges. Used by trace_path with include_evidence.
 * Returns a Map keyed by edge id.
 */
export function getBulkEdgeEvidence(
  db: LynxDatabase,
  project: string,
  edgeIds: number[],
): Map<number, EdgeEvidenceRecord[]> {
  const result = new Map<number, EdgeEvidenceRecord[]>();
  if (edgeIds.length === 0) return result;
  const placeholders = edgeIds.map(() => '?').join(',');
  const sql = `SELECT id, edge_id, evidence_type, source_kind, source_path, start_line, end_line, extractor, strength, payload_json, created_at FROM edge_evidence WHERE project = ? AND edge_id IN (${placeholders}) ORDER BY strength DESC, id ASC`;
  const rows = db.db.prepare(sql).all(project, ...edgeIds) as Array<EdgeEvidenceRecord & { edge_id: number }>;
  for (const row of rows) {
    let payload: unknown = {};
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    const { tier } = classifyConfidence(row.extractor, row.strength);
    const enriched = { ...row, payload, confidence_tier: tier, confidence_label: CONFIDENCE_TIERS[tier].label };
    const list = result.get(row.edge_id) || [];
    list.push(enriched);
    result.set(row.edge_id, list);
  }
  return result;
}
