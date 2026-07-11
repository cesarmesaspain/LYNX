/*
 * find_tests — Find test functions covering a given symbol.
 *
 * Queries TESTS edges (test function → production function) in reverse:
 * given a production symbol, returns all test functions that call it.
 * Saves ~4 round-trips vs grepping for test files manually.
 */

import { getDb } from '../server.js';
import { findNodeByQn } from '../../store/nodes.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { projectNotIndexed } from '../diagnostics.js';

export async function handleFindTests(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const qualifiedName = args.qualified_name ? String(args.qualified_name) : undefined;
  const name = args.name ? String(args.name) : undefined;

  if (!project) return { error: 'project is required' };
  if (!qualifiedName && !name) return { error: 'qualified_name or name is required' };

  const db = getDb(project);
  const projCheck = db.getProject(project);
  if (!projCheck) return { ...projectNotIndexed(project) };

  // Resolve the target symbol
  let node: any;
  if (qualifiedName) {
    node = findNodeByQn(db, project, qualifiedName);
  }
  if (!node && name) {
    node = db.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND name = ? LIMIT 1')
      .get(project, name);
  }

  if (!node) {
    return {
      project,
      query: { qualified_name: qualifiedName, name },
      tests: [],
      found: false,
      message: 'Symbol not found in the indexed graph.',
    };
  }

  // Find tests: TESTS edges go test_function → prod_function.
  // So tests are source_ids where target_id = our node.
  const testIdRows = db.db
    .prepare('SELECT source_id FROM edges WHERE project = ? AND target_id = ? AND type = ?')
    .all(project, node.id, 'TESTS') as { source_id: number }[];

  if (testIdRows.length === 0) {
    return {
      project,
      symbol: { name: node.name, qualified_name: node.qualified_name, kind: node.kind },
      tests: [],
      found: true,
      message: 'No tests found covering this symbol.',
    };
  }

  const testIds = testIdRows.map((r) => r.source_id);
  const placeholders = testIds.map(() => '?').join(',');

  const testNodes = db.db
    .prepare(
      `SELECT id, name, qualified_name, kind, file_path, start_line, end_line, is_exported
       FROM nodes WHERE project = ? AND id IN (${placeholders})
       LIMIT 30`
    )
    .all(project, ...testIds) as any[];

  // Read snippets for each test (first 8 lines to keep response tight)
  const projectMeta = db.getProject(project);
  const rootPath = projectMeta?.rootPath || process.cwd();

  const tests = testNodes.map((tn: any) => {
    let snippet: string | null = null;
    try {
      const filePath = path.join(rootPath, tn.file_path);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, tn.start_line - 1);
      const end = Math.min(lines.length, tn.end_line);
      // Show function signature + first few body lines (max 12 lines)
      const bodyLines = lines.slice(start, end);
      snippet = bodyLines.slice(0, 12).join('\n');
      if (bodyLines.length > 12) snippet += '\n  // ...';
    } catch {
      // file not readable
    }
    return {
      name: tn.name,
      qualified_name: tn.qualified_name,
      file_path: tn.file_path,
      kind: tn.kind,
      snippet,
    };
  });

  recordUsageEvent({
    type: 'search_graph',
    project,
    query: qualifiedName || name || '',
    result_count: tests.length,
    unique_files: new Set(tests.map(t => t.file_path)).size,
    files_avoided: tests.length > 0 ? tests.length * 2 : 1,
    tokens_saved: tests.length * 450,
    confidence: tests.length >= 4 ? 'high' : tests.length >= 2 ? 'medium' : 'low',
    latency_ms: Date.now() - started,
    tool_hint: 'find_tests',
  });

  return {
    project,
    symbol: {
      name: node.name,
      qualified_name: node.qualified_name,
      kind: node.kind,
      file_path: node.file_path,
    },
    tests,
    count: tests.length,
    found: true,
    value_metrics: {
      estimated_files_avoided: tests.length > 0 ? tests.length * 2 : 1,
      estimated_tokens_saved: tests.length * 450,
      confidence: tests.length >= 4 ? 'high' as const : tests.length >= 2 ? 'medium' as const : 'low' as const,
      latency_ms: Date.now() - started,
    },
  };
}
