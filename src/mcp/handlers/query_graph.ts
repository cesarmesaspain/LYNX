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
import { projectNotIndexed } from '../diagnostics.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { readLynxConfig } from '../../config/runtime.js';

export async function handleQueryGraph(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const query = String(args.query || '');
  const project = String(args.project || '');
  const savingsMode = Boolean(readLynxConfig().agent_response?.enabled
    && readLynxConfig().agent_response?.budget === 'max_savings');
  const defaultRows = savingsMode ? 20 : 100;
  const requestedRows = args.max_rows !== undefined ? Number(args.max_rows) : defaultRows;
  const maxRows = Number.isFinite(requestedRows)
    ? Math.max(1, Math.min(Math.floor(requestedRows), 1000))
    : defaultRows;

  const db = getDb(project);
  if (!db.getProject(project)) return { ...projectNotIndexed(project) };

  if (!/^\s*(SELECT|MATCH|WITH)\s/i.test(query)) {
    return { error: 'Unrecognized query format. Use MATCH ... RETURN ... or SELECT.', query };
  }

  try {
    const scoped = translateCypher(query, project);
    const rows = db.db.prepare(scoped.sql).all(...scoped.parameters) as any[];
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

    const potential = estimateTokensSaved(limited.length, rows.length);
    const observedTokens = limited.length === 0 ? 0 : Math.min(1_200, 100 + limited.length * 90);
    recordUsageEvent({
      type: 'search_graph',
      project,
      query,
      result_count: limited.length,
      unique_files: 0,
      files_avoided: 0,
      tokens_saved: observedTokens,
      confidence: 'low',
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
        measurement: 'graph_query_result_context',
        estimated_files_avoided: 0,
        estimated_tokens_saved: observedTokens,
        full_file_potential_tokens: potential.tokensSaved,
        potential_basis: 'broader manual graph exploration; not observed savings',
        confidence: 'low',
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

/**
 * Wrap raw SQL so it only sees project-filtered data.
 *
 * Prefixes the query with common-table expressions that shadow graph tables,
 * scoped to the requested project. This is per statement, so concurrent MCP
 * requests cannot change one another's database view.
 */
interface ScopedQuery { sql: string; parameters: string[]; }

function scopeRawSql(query: string, project: string): ScopedQuery {
  const trimmed = query.trim();
  if (/;|--|\/\*|\*\/|\b(?:ATTACH|DETACH|PRAGMA|VACUUM|CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(trimmed)) {
    throw new Error('Raw SQL must be a single read-only graph query.');
  }
  if (/\b(?:main|temp|sqlite_master|sqlite_schema)\s*\./i.test(trimmed)) {
    throw new Error('Raw SQL cannot address database schemas directly.');
  }
  const tables = [...trimmed.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)/gi)].map(match => match[1].toLowerCase());
  const unsupported = tables.find(table => !['nodes', 'edges', 'projects'].includes(table));
  if (unsupported) throw new Error(`Raw SQL table '${unsupported}' is not available in query_graph.`);
  const scope = 'nodes AS (SELECT * FROM main.nodes WHERE project = ?), edges AS (SELECT * FROM main.edges WHERE project = ?), projects AS (SELECT * FROM main.projects WHERE name = ?)';
  return {
    sql: /^WITH\s+/i.test(trimmed) ? `WITH ${scope}, ${trimmed.replace(/^WITH\s+/i, '')}` : `WITH ${scope} ${trimmed}`,
    parameters: [project, project, project],
  };
}

function translateCypher(query: string, project: string): ScopedQuery {
  if (/^\s*SELECT\s/i.test(query)) {
    return scopeRawSql(query, project);
  }

  // Handle MATCH (a:Label)-[r:TYPE]->(b:Label)
  const pathMatch = query.match(
    /MATCH\s*\((\w+)(?::(\w+))?\)\s*-\[(\w*):?(\w*)\]\s*->\s*\((\w+)(?::(\w+))?\)/i
  );

  if (pathMatch) {
    return { sql: translatePathQuery(query, project, pathMatch), parameters: [] };
  }

  // Handle single MATCH (var:Label)
  const singleMatch = query.match(/MATCH\s*\((\w+):(\w+)\)/i);
  if (singleMatch) {
    return { sql: translateSingleMatch(query, project, singleMatch), parameters: [] };
  }

  // Handle MATCH (n) — match all
  const allMatch = query.match(/MATCH\s*\((\w+)\)/i);
  if (allMatch) {
    return { sql: translateAllMatch(query, project, allMatch), parameters: [] };
  }

  throw new Error('Only MATCH (var:Label), MATCH ()-[r]->(), or MATCH (n) is supported. For complex queries use SQL directly.');
}

function columnSql(expr: string, varName: string): string {
  // Convert aggregate(var) to aggregate(*) when bare variable reference (no property)
  const aggFixed = expr.replace(
    new RegExp(`\\b(COUNT|SUM|AVG|MIN|MAX)\\s*\\(\\s*${varName}\\s*\\)`, 'gi'),
    (_, fn) => `${fn}(*)`
  );
  return aggFixed.replace(new RegExp(`${varName}\\.(\\w+)`, 'g'), (_, prop) => {
    if (['name', 'qualified_name', 'file_path', 'kind', 'id', 'start_line', 'end_line',
      'is_exported', 'is_entry_point', 'is_test'].includes(prop)) {
      return `${varName}.${prop}`;
    }
    return `json_extract(${varName}.properties, '$.${prop}')`;
  });
}

function conditionSql(clause: string, varName: string): string {
  const result = clause
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*=\\s*'((?:[^'\\\\]|\\\\')+)'`, 'g'), (_, prop, val) => {
      // Convert Cypher \' escape to SQLite '' escape
      const sqlVal = val.replace(/\\'/g, "''");
      if (['name', 'qualified_name', 'file_path', 'kind', 'is_exported', 'is_entry_point', 'is_test'].includes(prop)) {
        return `${varName}.${prop} = '${sqlVal}'`;
      }
      return `json_extract(${varName}.properties, '$.${prop}') = '${sqlVal}'`;
    })
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*(>=|<=|>|<|<>)\\s*(\\d+)`, 'g'), (_, prop, op, val) => {
      const col = ['name', 'qualified_name', 'file_path', 'kind', 'start_line', 'end_line',
        'is_exported', 'is_entry_point', 'is_test']
        .includes(prop) ? `${varName}.${prop}` : `json_extract(${varName}.properties, '$.${prop}')`;
      return `${col} ${op} ${val}`;
    })
    .replace(new RegExp(`${varName}\\.(\\w+)\\s*=\\s*(\\w+)`, 'g'), (_, prop, val) => {
      if (['name', 'qualified_name', 'file_path', 'kind', 'is_exported', 'is_entry_point', 'is_test'].includes(prop)) {
        return `${varName}.${prop} = '${val}'`;
      }
      return `json_extract(${varName}.properties, '$.${prop}') = ${val}`;
    });

  // Reject SQL injection: OR lets untransformed tautologies (OR 1=1) bypass
  // the WHERE clause. UNION and ; enable multi-statement attacks. -- is a SQLite
  // line comment that would truncate the rest of the query. AND between
  // var.prop = 'value' conditions is legitimate and passes through safely.
  if (/\bOR\b/i.test(result) || /\bUNION\b/i.test(result) || /;/.test(result) || /--/.test(result)) {
    throw new Error(`Unsafe WHERE condition: "${clause}". OR, UNION, ;, and -- are not supported in WHERE. Use multiple var.prop = 'value' conditions joined by AND.`);
  }

  return result;
}

// ── Shared clause helpers ──────────────────────────────────

function appendPagination(sql: string, query: string): string {
  let result = sql;
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  result += limitMatch ? ` LIMIT ${limitMatch[1]}` : ' LIMIT 100';
  const skipMatch = query.match(/SKIP\s+(\d+)/i);
  if (skipMatch) result += ` OFFSET ${skipMatch[1]}`;
  return result;
}

function appendOrderBy(sql: string, query: string, varName: string): string {
  const orderMatch = query.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+SKIP|\s*$)/i);
  if (!orderMatch) return sql;
  const orderParts = orderMatch[1].trim().split(',').map(p => {
    const trimmed = p.trim();
    const dirMatch = trimmed.match(/^(.+?)\s+(ASC|DESC)$/i);
    const col = dirMatch ? dirMatch[1] : trimmed;
    const dir = dirMatch ? ` ${dirMatch[2].toUpperCase()}` : '';
    const translated = columnSql(col, varName);
    const bareMatch = translated.match(/^(\w+)$/);
    if (bareMatch) return `"${bareMatch[1]}"${dir}`;
    return translated + dir;
  });
  return sql + ` ORDER BY ${orderParts.join(', ')}`;
}

function appendGroupBy(
  sql: string,
  query: string,
  returnExpr: string,
  column: (expr: string) => string,
): string {
  const groupMatch = query.match(/GROUP\s+BY\s+(.+?)(?:\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (groupMatch) {
    return `${sql} GROUP BY ${groupMatch[1].trim().split(',').map(group => column(group.trim())).join(', ')}`;
  }

  // Cypher groups non-aggregate RETURN expressions implicitly. SQLite does
  // not, and otherwise returns one arbitrary row alongside the total count.
  if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(returnExpr)) {
    const inferred = returnExpr.split(',')
      .filter(expr => !/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(expr))
      .map(expr => expr.replace(/\s+AS\s+\w+\s*$/i, '').trim())
      .filter(Boolean);
    if (inferred.length > 0) return `${sql} GROUP BY ${inferred.map(column).join(', ')}`;
  }
  return sql;
}

// ── MATCH (a:Label)-[r:TYPE]->(b:Label) ────────────────────

function translatePathQuery(
  query: string, project: string, m: RegExpMatchArray
): string {
  const aVar = m[1];
  const aLabel = m[2] || '';
  const rVar = m[3] || 'r';
  const rType = m[4] || '';
  const bVar = m[5];
  const bLabel = m[6] || '';

  // RETURN — stop at GROUP BY, LIMIT, ORDER, SKIP, or end of string
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+GROUP\s+BY|\s+LIMIT(?=\s+\d+|\s*$)|\s+ORDER\s+BY|\s+SKIP(?=\s+\d+|\s*$)|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : '*';

  const columns = returnExpr === '*'
    ? ['a.name as a_name', 'a.qualified_name as a_qualified_name', 'a.kind as a_kind',
       'r.type as edge_type',
       'b.name as b_name', 'b.qualified_name as b_qualified_name', 'b.kind as b_kind']
    : returnExpr.split(',').map(c => {
        // Map Cypher variable names to SQL aliases (f→a, t→b, r stays r)
        // and add AS aliases so columns don't collide (e.g. a.name AS f_name)
        let expr = c.trim();
        const asMatch = expr.match(/^(.*)\s+AS\s+(\w+)$/i);
        const hasExplicitAlias = !!asMatch;
        const coreExpr = hasExplicitAlias ? asMatch![1].trim() : expr;
        const explicitAlias = hasExplicitAlias ? asMatch![2] : null;

        let mapped = coreExpr;
        mapped = mapped.replace(new RegExp(`\\b${aVar}\\.`, 'g'), 'a.');
        if (bVar !== aVar) mapped = mapped.replace(new RegExp(`\\b${bVar}\\.`, 'g'), 'b.');
        if (rVar !== aVar && rVar !== bVar) mapped = mapped.replace(new RegExp(`\\b${rVar}\\.`, 'g'), 'r.');

        const colSql = columnSql(mapped, 'a');

        // Auto-alias: if no explicit AS, generate one from the Cypher var + prop
        if (!hasExplicitAlias && coreExpr !== '*' && coreExpr !== 'count(*)') {
          let alias = coreExpr.trim();
          alias = alias.replace(new RegExp(`\\b${aVar}\\.`, 'g'), `${aVar}_`);
          if (bVar !== aVar) alias = alias.replace(new RegExp(`\\b${bVar}\\.`, 'g'), `${bVar}_`);
          if (rVar !== aVar && rVar !== bVar) alias = alias.replace(new RegExp(`\\b${rVar}\\.`, 'g'), `${rVar}_`);
          return `${colSql} AS "${alias}"`;
        }
        if (hasExplicitAlias) {
          return `${colSql} AS "${explicitAlias}"`;
        }
        return colSql;
      });

  let sql = `SELECT ${columns.join(', ')} FROM edges r JOIN nodes a ON r.source_id = a.id JOIN nodes b ON r.target_id = b.id WHERE r.project = '${project}' AND a.project = '${project}' AND b.project = '${project}'`;

  if (aLabel) sql += ` AND a.kind = '${aLabel}'`;
  if (bLabel) sql += ` AND b.kind = '${bLabel}'`;
  if (rType) sql += ` AND r.type = '${rType}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+GROUP\s+BY|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    let cond = conditionSql(whereMatch[1].trim(), aVar);
    // Map Cypher variable names to SQL table aliases (same as RETURN columns)
    cond = cond.replace(new RegExp(`\\b${aVar}\\.`, 'g'), 'a.');
    if (bVar !== aVar) cond = cond.replace(new RegExp(`\\b${bVar}\\.`, 'g'), 'b.');
    if (rVar !== aVar && rVar !== bVar) cond = cond.replace(new RegExp(`\\b${rVar}\\.`, 'g'), 'r.');
    sql += ` AND (${cond})`;
  }

  // WITH (pipeline only — just pass-through for now)
  const withMatch = query.match(/WITH\s+(.+?)(?:\s+MATCH|\s*$)/i);

  // GROUP BY
  const groupMatch = query.match(/GROUP\s+BY\s+(.+?)(?:\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (groupMatch) {
    sql += ` GROUP BY ${groupMatch[1].trim()}`;
  }

  // ORDER BY — quote bare identifiers (RETURN aliases) to protect reserved words
  const orderMatch = query.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+SKIP|\s*$)/i);
  if (orderMatch) {
    const orderParts = orderMatch[1].trim().split(',').map(p => {
      const trim = p.trim();
      const m = trim.match(/^(\w+)(\s+(?:ASC|DESC))?$/i);
      if (m) return `"${m[1]}"${m[2] || ''}`;
      return trim;
    });
    sql += ` ORDER BY ${orderParts.join(', ')}`;
  }

  sql = appendPagination(sql, query);
  return sql;
}

// ── MATCH (var:Label) ──────────────────────────────────────

function translateSingleMatch(
  query: string, project: string, m: RegExpMatchArray
): string {
  const varName = m[1];
  const label = m[2];

  // RETURN — stop at GROUP BY, LIMIT, ORDER, SKIP, or end of string
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+GROUP\s+BY|\s+LIMIT(?=\s+\d+|\s*$)|\s+ORDER\s+BY|\s+SKIP(?=\s+\d+|\s*$)|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : `${varName}.*`;

  const columns = returnExpr
    .split(',')
    .map((c) => c.trim())
    .map((c) => {
      return columnSql(c, varName);
    });

  let sql = `SELECT ${columns.join(', ')} FROM nodes ${varName} WHERE ${varName}.project = '${project}' AND ${varName}.kind = '${label}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+GROUP\s+BY|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    const cond = conditionSql(whereMatch[1].trim(), varName);
    sql += ` AND (${cond})`;
  }

  sql = appendGroupBy(sql, query, returnExpr, expr => columnSql(expr, varName));

  // ORDER BY — quote bare identifiers to protect reserved words
  sql = appendOrderBy(sql, query, varName);

  sql = appendPagination(sql, query);
  return sql;
}

// ── MATCH (n) — match all ──────────────────────────────────

function translateAllMatch(
  query: string, project: string, m: RegExpMatchArray
): string {
  const varName = m[1];

  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+GROUP\s+BY|\s+LIMIT(?=\s+\d+|\s*$)|\s+ORDER\s+BY|\s+SKIP(?=\s+\d+|\s*$)|\s*$)/i);
  const returnExpr = returnMatch ? returnMatch[1].trim() : `${varName}.*`;

  const columns = returnExpr === '*'
    ? ['*']
    : returnExpr.split(',').map((c) => columnSql(c.trim(), varName));

  let sql = `SELECT ${columns.join(', ')} FROM nodes ${varName} WHERE ${varName}.project = '${project}'`;

  // WHERE
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+RETURN|\s+GROUP\s+BY|\s+LIMIT|\s+ORDER|\s+SKIP|\s*$)/i);
  if (whereMatch) {
    const cond = conditionSql(whereMatch[1].trim(), varName);
    sql += ` AND (${cond})`;
  }

  sql = appendGroupBy(sql, query, returnExpr, expr => columnSql(expr, varName));

  // ORDER BY — quote bare identifiers to protect reserved words
  sql = appendOrderBy(sql, query, varName);

  sql = appendPagination(sql, query);
  return sql;
}
