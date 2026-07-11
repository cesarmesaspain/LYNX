/*
 * query_graph.ts — Execute Cypher queries against the graph store.
 *
 * Capabilities:
 *   - MATCH (a:Label)-[r:TYPE]->(b:Label) pattern support with edge traversal
 *   - WITH clause for pipelining
 *   - max_rows parameter
 *
 * Direct raw SQL is also accepted.
 */

import { getDb } from '../server.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';

export async function handleQueryGraph(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const query = String(args.query || '');
  const project = String(args.project || '');
  const maxRows = args.max_rows ? Number(args.max_rows) : 100;

  const db = getDb(project);

  if (!/^\s*(SELECT|MATCH|WITH)\s/i.test(query)) {
    return { error: 'Unrecognized query format. Use MATCH ... RETURN ... or SELECT.', query };
  }

  try {
    const sql = translateCypher(query, project);
    const rows = db.db.prepare(sql).all() as any[];
    const limited = rows.slice(0, maxRows);
    const relationshipEvidence = db.db.prepare(`
      SELECT
        n.id,
        SUM(CASE WHEN e.target_id = n.id AND e.type = 'CALLS' THEN 1 ELSE 0 END) AS incoming_calls,
        SUM(CASE WHEN e.target_id = n.id AND e.type = 'USAGE' THEN 1 ELSE 0 END) AS incoming_usages,
        SUM(CASE WHEN e.source_id = n.id AND e.type = 'USAGE' THEN 1 ELSE 0 END) AS outgoing_usages
      FROM nodes n
      LEFT JOIN edges e
        ON e.project = n.project
       AND (e.source_id = n.id OR e.target_id = n.id)
      WHERE n.project = ? AND n.qualified_name = ?
      GROUP BY n.id
    `);
    const rowEvidence = limited.flatMap((row) => {
      if (typeof row?.qualified_name !== 'string') return [];
      const counts = relationshipEvidence.get(project, row.qualified_name) as {
        id: number;
        incoming_calls: number;
        incoming_usages: number;
        outgoing_usages: number;
      } | undefined;
      if (!counts) return [];
      return [{
        qualified_name: row.qualified_name,
        definition_verified: true,
        file_path: typeof row.file_path === 'string' ? row.file_path : null,
        incoming_calls: Number(counts.incoming_calls || 0),
        incoming_usages: Number(counts.incoming_usages || 0),
        outgoing_usages: Number(counts.outgoing_usages || 0),
        zero_callers_and_usages:
          Number(counts.incoming_calls || 0) === 0 &&
          Number(counts.incoming_usages || 0) === 0 &&
          Number(counts.outgoing_usages || 0) === 0,
      }];
    });

    const value = estimateTokensSaved(limited.length, rows.length);
    recordUsageEvent({
      type: 'search_graph',
      project,
      query,
      result_count: limited.length,
      unique_files: 0,
      files_avoided: value.filesAvoided,
      tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
      tool_hint: 'query_graph',
    });

    return {
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows: limited,
      total: rows.length,
      truncated: rows.length > maxRows,
      row_evidence: rowEvidence,
      verification_complete:
        limited.length > 0 && rowEvidence.length === limited.length,
      verification_hint:
        rowEvidence.length > 0
          ? 'row_evidence verifies indexed definitions and relationship counts in this response; use zero_callers_and_usages directly instead of issuing per-symbol search_code or trace_path calls.'
          : 'Select qualified_name and file_path to receive per-row definition and relationship evidence.',
      value_metrics: {
        estimated_files_avoided: value.filesAvoided,
        estimated_tokens_saved: value.tokensSaved,
        confidence: value.confidence,
        latency_ms: Date.now() - started,
      },
    };
  } catch (err) {
    return {
      error: String(err),
      query,
      hint: 'The Cypher subset does not support negated relationship patterns or EXISTS subqueries. For callers/usages, use the raw SQL recovery template below instead of retrying equivalent Cypher.',
      recovery_queries: {
        no_callers_or_usages:
          "SELECT n.name, n.qualified_name, n.file_path, n.kind FROM nodes n WHERE n.kind IN ('Function', 'Class') AND NOT EXISTS (SELECT 1 FROM edges e WHERE (e.target_id = n.id OR e.source_id = n.id) AND e.type IN ('CALLS', 'USAGE')) LIMIT 50",
      },
    };
  }
}

function translateCypher(query: string, project: string): string {
  if (/^\s*SELECT\s/i.test(query)) {
    return query;
  }

  // Handle MATCH (a:Label)-[r:TYPE]->(b:Label)
  const pathMatch = query.match(
    /MATCH\s*\((\w+)(?::(\w+))?\)\s*-\[(\w*):?(\w*)\]\s*->\s*\((\w+)(?::(\w+))?\)/i
  );

  if (pathMatch) {
    return translatePathQuery(query, project, pathMatch);
  }

  // Handle single MATCH (var:Label)
  const singleMatch = query.match(/MATCH\s*\((\w+):(\w+)\)/i);
  if (singleMatch) {
    return translateSingleMatch(query, project, singleMatch);
  }

  // Handle MATCH (n) — match all
  const allMatch = query.match(/MATCH\s*\((\w+)\)/i);
  if (allMatch) {
    return translateAllMatch(query, project, allMatch);
  }

  throw new Error('Only MATCH (var:Label), MATCH ()-[r]->(), or MATCH (n) is supported. For complex queries use SQL directly.');
}

function columnSql(expr: string, varName: string): string {
  return expr.replace(new RegExp(`${varName}\\.(\\w+)`, 'g'), (_, prop) => {
    if (['name', 'qualified_name', 'file_path', 'kind', 'id', 'start_line', 'end_line'].includes(prop)) {
      return `${varName}.${prop}`;
    }
    return `json_extract(${varName}.properties, '$.${prop}')`;
  });
}

function conditionSql(clause: string, varName: string): string {
  return clause
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*=\\s*'([^']+)'`, 'g'), (_, prop, val) => {
      if (['name', 'qualified_name', 'file_path', 'kind', 'is_exported', 'is_entry_point', 'is_test'].includes(prop)) {
        return `${varName}.${prop} = '${val}'`;
      }
      return `json_extract(${varName}.properties, '$.${prop}') = '${val}'`;
    })
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*(>=|<=|>|<|<>)\\s*(\\d+)`, 'g'), (_, prop, op, val) => {
      const col = ['name', 'qualified_name', 'file_path', 'kind', 'start_line', 'end_line']
        .includes(prop) ? `${varName}.${prop}` : `json_extract(${varName}.properties, '$.${prop}')`;
      return `${col} ${op} ${val}`;
    })
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*=\\s*(\\w+)`, 'g'), (_, prop, val) => {
      if (['name', 'qualified_name', 'file_path', 'kind'].includes(prop)) {
        return `${varName}.${prop} = '${val}'`;
      }
      return `json_extract(${varName}.properties, '$.${prop}') = ${val}`;
    });
}

function translatePathQuery(
  query: string, project: string, m: RegExpMatchArray
): string {
  const aVar = m[1];
  const aLabel = m[2] || '';
  const rVar = m[3] || 'r';
  const rType = m[4] || '';
  const bVar = m[5];
  const bLabel = m[6] || '';

  // RETURN
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : '*';

  const columns = returnExpr === '*'
    ? ['a.name as a_name', 'a.qualified_name as a_qualified_name', 'a.kind as a_kind',
       'r.type as edge_type',
       'b.name as b_name', 'b.qualified_name as b_qualified_name', 'b.kind as b_kind']
    : returnExpr.split(',').map(c => columnSql(c.trim(), aVar));

  let sql = `SELECT ${columns.join(', ')} FROM edges r JOIN nodes a ON r.source_id = a.id JOIN nodes b ON r.target_id = b.id WHERE r.project = '${project}' AND a.project = '${project}' AND b.project = '${project}'`;

  if (aLabel) sql += ` AND a.kind = '${aLabel}'`;
  if (bLabel) sql += ` AND b.kind = '${bLabel}'`;
  if (rType) sql += ` AND r.type = '${rType}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    const cond = conditionSql(whereMatch[1].trim(), aVar);
    sql += ` AND (${cond})`;
  }

  // WITH (pipeline only — just pass-through for now)
  const withMatch = query.match(/WITH\s+(.+?)(?:\s+MATCH|\s*$)/i);

  // ORDER BY
  const orderMatch = query.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+SKIP|\s*$)/i);
  if (orderMatch) {
    sql += ` ORDER BY ${orderMatch[1].trim()}`;
  }

  // SKIP
  const skipMatch = query.match(/SKIP\s+(\d+)/i);
  if (skipMatch) sql += ` OFFSET ${skipMatch[1]}`;

  // LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  sql += limitMatch ? ` LIMIT ${limitMatch[1]}` : ' LIMIT 100';

  return sql;
}

function translateSingleMatch(
  query: string, project: string, m: RegExpMatchArray
): string {
  const varName = m[1];
  const label = m[2];

  // RETURN
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : `${varName}.*`;

  const columns = returnExpr
    .split(',')
    .map((c) => c.trim())
    .map((c) => {
      if (/COUNT\s*\(/i.test(c) || /SUM\s*\(/i.test(c) || /AVG\s*\(/i.test(c) || /MIN\s*\(/i.test(c) || /MAX\s*\(/i.test(c)) {
        return columnSql(c, varName);
      }
      return columnSql(c, varName);
    });

  let sql = `SELECT ${columns.join(', ')} FROM nodes ${varName} WHERE ${varName}.project = '${project}' AND ${varName}.kind = '${label}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    const cond = conditionSql(whereMatch[1].trim(), varName);
    sql += ` AND (${cond})`;
  }

  // ORDER BY
  const orderMatch = query.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+SKIP|\s*$)/i);
  if (orderMatch) {
    sql += ` ORDER BY ${columnSql(orderMatch[1].trim(), varName)}`;
  }

  // SKIP
  const skipMatch = query.match(/SKIP\s+(\d+)/i);
  if (skipMatch) sql += ` OFFSET ${skipMatch[1]}`;

  // LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  sql += limitMatch ? ` LIMIT ${limitMatch[1]}` : ' LIMIT 100';

  return sql;
}

function translateAllMatch(
  query: string, project: string, m: RegExpMatchArray
): string {
  const varName = m[1];

  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : `${varName}.*`;

  const columns = returnExpr === '*'
    ? ['*']
    : returnExpr.split(',').map((c) => columnSql(c.trim(), varName));

  let sql = `SELECT ${columns.join(', ')} FROM nodes ${varName} WHERE ${varName}.project = '${project}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    const cond = conditionSql(whereMatch[1].trim(), varName);
    sql += ` AND (${cond})`;
  }

  // ORDER BY
  const orderMatch = query.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+SKIP|\s*$)/i);
  if (orderMatch) {
    sql += ` ORDER BY ${columnSql(orderMatch[1].trim(), varName)}`;
  }

  // LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  sql += limitMatch ? ` LIMIT ${limitMatch[1]}` : ' LIMIT 100';

  return sql;
}
