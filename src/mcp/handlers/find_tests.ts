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
import { readLynxConfig } from '../../config/runtime.js';

export async function handleFindTests(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const qualifiedName = args.qualified_name ? String(args.qualified_name) : undefined;
  const name = args.name ? String(args.name) : undefined;
  const savingsMode = Boolean(readLynxConfig().agent_response?.enabled
    && readLynxConfig().agent_response?.budget === 'max_savings');

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
  let testIdRows = db.db
    .prepare('SELECT source_id FROM edges WHERE project = ? AND target_id = ? AND type = ?')
    .all(project, node.id, 'TESTS') as { source_id: number }[];

  // Function-level TESTS edges are preferred. When the resolver only has
  // file-level evidence, return that evidence instead of claiming no tests.
  // This makes find_tests useful for handlers whose test calls are indirect.
  let coverageLevel: 'symbol' | 'file' | 'text' = 'symbol';
  if (testIdRows.length === 0 && node.file_path) {
    testIdRows = db.db.prepare(`
      SELECT DISTINCT e.source_id
      FROM edges e
      JOIN nodes target_file ON target_file.id = e.target_id AND target_file.project = e.project
      JOIN nodes test_file ON test_file.id = e.source_id AND test_file.project = e.project
      WHERE e.project = ?
        AND e.type = 'TESTS_FILE'
        AND target_file.kind = 'File'
        AND target_file.file_path = ?
        AND (test_file.is_test = 1 OR test_file.file_path LIKE '%test%' OR test_file.file_path LIKE '%spec%')
    `).all(project, node.file_path) as { source_id: number }[];
    coverageLevel = 'file';
  }

  // Dynamic imports and factory helpers can hide a real test dependency from
  // the static resolver. As a final, explicitly lower-confidence fallback,
  // look for the requested symbol name in indexed test files. Do not present
  // this as graph-confirmed coverage: the response labels it as text evidence.
  if (testIdRows.length === 0 && node.name) {
    const escapedName = node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const symbolPattern = new RegExp(`\\b${escapedName}\\b`);
    const testFiles = db.db.prepare(`
      SELECT id, file_path
      FROM nodes
      WHERE project = ?
        AND kind = 'File'
        AND (is_test = 1 OR file_path LIKE '%test%' OR file_path LIKE '%spec%')
      LIMIT 500
    `).all(project) as { id: number; file_path: string }[];
    const projectMeta = db.getProject(project);
    const rootPath = projectMeta?.rootPath || process.cwd();
    testIdRows = testFiles.flatMap((testFile) => {
      try {
        const content = fs.readFileSync(path.join(rootPath, testFile.file_path), 'utf-8');
        return symbolPattern.test(content) ? [{ source_id: testFile.id }] : [];
      } catch {
        return [];
      }
    });
    if (testIdRows.length > 0) coverageLevel = 'text';
  }

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
       LIMIT ${savingsMode ? 10 : 30}`
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
      // Show function signature + first few body lines.
      const bodyLines = lines.slice(start, end);
      const snippetLines = savingsMode ? 6 : 12;
      snippet = bodyLines.slice(0, snippetLines).join('\n');
      if (bodyLines.length > snippetLines) snippet += '\n  // ...';
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

  const testFiles = [...new Set(tests.map(t => t.file_path))];
  const value = estimateTokensSaved({ resultCount: tests.length, candidateFiles: testFiles.length, files: testFiles, rootPath });
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: qualifiedName || name || '',
    result_count: tests.length,
    unique_files: new Set(tests.map(t => t.file_path)).size,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
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
    coverage_level: coverageLevel,
    coverage_note: coverageLevel === 'text'
      ? 'Text evidence only: verify the test call before treating this as confirmed coverage.'
      : undefined,
    found: true,
    value_metrics: {
      estimated_files_avoided: value.filesAvoided,
      estimated_tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
    },
  };
}
