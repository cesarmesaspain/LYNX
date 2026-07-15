import { getDb } from '../server.js';
import { projectNotIndexed } from '../diagnostics.js';

const ALLOWED_KINDS = new Set(['Function', 'Method', 'Class']);

export async function handleFindDeadCode(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const limit = Math.max(1, Math.min(Number(args.limit || 30), 100));
  const pathPrefix = args.path ? String(args.path) : '';
  const requestedKinds = Array.isArray(args.kinds)
    ? args.kinds.map(String).filter((kind) => ALLOWED_KINDS.has(kind))
    : ['Function', 'Class'];
  const kinds = requestedKinds.length > 0
    ? [...new Set(requestedKinds)]
    : ['Function', 'Class'];

  const db = getDb(project);
  if (!db.getProject(project)) return projectNotIndexed(project);

  const kindPlaceholders = kinds.map(() => '?').join(', ');
  const pathClause = pathPrefix ? 'AND n.file_path LIKE ?' : '';
  const params: Array<string | number> = [project, ...kinds];
  if (pathPrefix) params.push(`${pathPrefix}%`);
  params.push(limit);

  const rows = db.db.prepare(`
    SELECT
      n.name,
      n.qualified_name,
      n.file_path,
      n.start_line,
      n.end_line,
      n.kind,
      n.is_exported,
      json_extract(n.properties, '$.signature') AS signature,
      EXISTS (
        SELECT 1 FROM edges ie
        JOIN nodes imported_file ON imported_file.id = ie.target_id AND imported_file.project = ie.project
        WHERE ie.project = n.project AND ie.type = 'IMPORTS' AND imported_file.kind = 'File' AND imported_file.file_path = n.file_path
      ) AS file_is_imported,
      SUM(CASE WHEN e.type = 'CALLS' THEN 1 ELSE 0 END) AS incoming_calls,
      SUM(CASE WHEN e.type = 'USAGE' THEN 1 ELSE 0 END) AS incoming_usages,
      SUM(CASE WHEN e.type = 'READS' THEN 1 ELSE 0 END) AS incoming_reads,
      SUM(CASE WHEN e.type IN ('TESTS', 'TESTS_FILE') THEN 1 ELSE 0 END) AS incoming_tests
    FROM nodes n
    LEFT JOIN edges e
      ON e.project = n.project
     AND e.target_id = n.id
     AND e.type IN ('CALLS', 'USAGE', 'READS', 'TESTS', 'TESTS_FILE')
    WHERE n.project = ?
      AND n.kind IN (${kindPlaceholders})
      AND COALESCE(n.is_test, 0) = 0
      AND COALESCE(n.is_entry_point, 0) = 0
      AND NOT (n.name = 'main' AND n.file_path LIKE '%.sh')
      AND (n.end_line - n.start_line) >= 2
      AND n.file_path NOT LIKE 'tests/%'
      AND n.file_path NOT LIKE '%/__tests__/%'
      AND n.file_path NOT LIKE '%.test.%'
      AND n.file_path NOT LIKE '%.spec.%'
      ${pathClause}
    GROUP BY n.id
    HAVING incoming_calls = 0
       AND incoming_usages = 0
       AND incoming_reads = 0
       AND incoming_tests = 0
    ORDER BY COALESCE(n.is_exported, 0) ASC,
             (n.end_line - n.start_line) DESC,
             n.file_path,
             n.start_line
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>;

  const candidates = rows.map((row) => {
    const rawSig = typeof row.signature === 'string' ? row.signature.trim() : '';
    // Embedded scripts and template literals are extraction artifacts, not real signatures
    const isBogusSignature = rawSig.length > 300
      || rawSig.includes('\n')
      || rawSig.startsWith('${')
      || rawSig.includes('<script');
    const hasCallableSignature = rawSig.length > 0 && !isBogusSignature;
    const fileIsImported = Number(row.file_is_imported || 0) === 1;
    const filePath = String(row.file_path || '');
    const dynamicallyDispatched = filePath.startsWith('src/mcp/handlers/');
    const moduleEntrypoint = filePath === 'src/mcp/server.ts' && ['runServer', 'main'].includes(String(row.name));
    // Extraction artifact: no real signature and name is a single short token
    const isExtractionNoise = !hasCallableSignature && String(row.name || '').length <= 2;
    const caveat = isExtractionNoise
      ? 'Extraction artifact — likely a minified bundle, embedded script, or local closure misclassified as a top-level function. Safe to ignore.'
      : dynamicallyDispatched
      ? 'MCP handlers may be invoked through the runtime tool registry; review the registry before removal.'
      : moduleEntrypoint
        ? 'Module startup functions may be invoked from a top-level entrypoint not represented by CALLS edges; review the entry module before removal.'
      : row.kind === 'Method'
      ? 'Methods may be reached through public class APIs or dynamic dispatch; review before removal.'
      : !hasCallableSignature
        ? 'No parsed callable signature is available; this may be a local value misclassified by extraction. Verify before removal.'
        : fileIsImported && Number(row.is_exported || 0) === 0
          ? 'The containing file is imported but this symbol was not marked exported; verify extraction metadata before removal.'
        : Number(row.is_exported || 0) === 0
          ? null
          : 'Exported symbols may be public API even when no internal references are indexed.';
    return {
      ...row,
      definition_verified: true,
      zero_incoming_references: true,
      line_count: Number(row.end_line) - Number(row.start_line) + 1,
      confidence: isExtractionNoise || dynamicallyDispatched || moduleEntrypoint || !hasCallableSignature || fileIsImported
        ? 'low'
        : Number(row.is_exported || 0) === 0 && row.kind !== 'Method' ? 'high' : 'medium',
      caveat,
    };
  });

  // Drop extraction artifacts (embedded scripts, minified bundles misclassified as functions)
  const cleaned = candidates.filter(c => {
    if (c.confidence !== 'low') return true;
    const cav = typeof c.caveat === 'string' ? c.caveat : '';
    return !cav.startsWith('Extraction artifact');
  });

  return {
    project,
    filters: {
      kinds,
      path: pathPrefix || null,
      excluded_tests: true,
      excluded_entry_points: true,
      methods_require_explicit_kind: !Array.isArray(args.kinds),
    },
    edge_types_checked: ['CALLS', 'USAGE', 'READS', 'TESTS', 'TESTS_FILE'],
    candidates: cleaned,
    total_returned: cleaned.length,
    verification_complete: true,
    guidance:
      'These are removal candidates, not deletion approvals. Definitions and zero incoming graph references are already verified; do not repeat search_code, get_code_snippet, or trace_path for every candidate. Methods require an explicit kind filter because they may be reachable through public class APIs or dynamic dispatch.',
  };
}
