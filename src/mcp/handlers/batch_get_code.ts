/*
 * batch_get_code — Read source for N symbols in one call.
 *
 * Avoids N sequential get_code_snippet round-trips when search_graph
 * returns multiple candidates and you need to compare them.
 * Each snippet is capped at 60 lines. Total response capped at 30 symbols.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import { projectNotIndexed } from '../diagnostics.js';
import { findNodeByQn } from '../../store/nodes.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { readLynxConfig } from '../../config/runtime.js';

interface BatchSnippet {
  name: string;
  qualified_name: string;
  file_path: string;
  kind: string;
  start_line: number;
  end_line: number;
  source: string;
  source_truncated?: boolean;
}

export async function handleBatchGetCode(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const project = String(args.project || '');
  const qualifiedNames: string[] = Array.isArray(args.qualified_names)
    ? (args.qualified_names as string[]).map(String)
    : [];
  const savingsMode = readLynxConfig().agent_response?.enabled
    && readLynxConfig().agent_response?.budget === 'max_savings';
  const limit = typeof args.limit === 'number' && args.limit > 0
    ? Math.min(args.limit, 30)
    : (savingsMode ? 8 : 20);
  const maxLinesPerSnippet = savingsMode ? 40 : 60;

  if (!project) return { error: 'project is required' };
  if (qualifiedNames.length === 0) return { error: 'qualified_names (array) is required' };

  const db = getDb(project);
  const projectMeta = db.getProject(project);
  if (!projectMeta) return { ...projectNotIndexed(project) };
  const rootPath = projectMeta?.rootPath || process.cwd();

  // Deduplicate and respect limit
  const unique = [...new Set(qualifiedNames)].slice(0, limit);

  // Cache file contents so we don't re-read the same file
  const fileCache = new Map<string, string>();

  const results: (BatchSnippet | { qualified_name: string; error: string })[] = [];

  for (const qn of unique) {
    // Exact QN lookup + fuzzy fallback by exact name match
    const node = findNodeByQn(db, project, qn)
      ?? (db.db.prepare(
        `SELECT id, name, qualified_name, file_path, kind, start_line, end_line
         FROM nodes WHERE project = ? AND LOWER(name) = LOWER(?)
         AND kind IN ('Function', 'Method', 'Class') LIMIT 1`
      ).get(project, qn) as {
        id: number; name: string; qualified_name: string;
        file_path: string; kind: string; start_line: number; end_line: number;
      } | undefined);

    if (!node) {
      results.push({ qualified_name: qn, error: 'Symbol not found' });
      continue;
    }

    try {
      let content = fileCache.get(node.file_path);
      if (!content) {
        content = fs.readFileSync(path.join(rootPath, node.file_path), 'utf-8');
        fileCache.set(node.file_path, content);
      }
      const lines = content.split('\n');
      const start = Math.max(0, node.start_line - 1);
      let end = Math.min(lines.length, node.end_line);
      // When the extractor only captured a 1-line range, expand to show context
      if (end - start <= 1 && start < lines.length) {
        end = Math.min(lines.length, start + 20);
      }
      const sourceTruncated = end - start > maxLinesPerSnippet;
      const source = lines.slice(start, end).slice(0, maxLinesPerSnippet).join('\n');

      results.push({
        name: node.name,
        qualified_name: node.qualified_name,
        file_path: node.file_path,
        kind: node.kind,
        start_line: node.start_line,
        end_line: node.end_line,
        source,
        ...(sourceTruncated ? { source_truncated: true } : {}),
      });
    } catch {
      results.push({ qualified_name: qn, error: `Cannot read file: ${node.file_path}` });
    }
  }

  const returned = results.filter((r) => 'name' in r).length;
  const value = estimateTokensSaved({ resultCount: returned, candidateFiles: unique.length, files: unique, rootPath });
  recordUsageEvent({
    type: 'search_graph', // batch_get_code is a search_graph variant
    project,
    query: unique.join(', '),
    result_count: returned,
    unique_files: new Set(results.filter(r => 'name' in r).map(r => (r as BatchSnippet).file_path)).size,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
    tool_hint: 'batch_get_code',
  });

  return {
    project,
    requested: unique.length,
    returned,
    results,
    ...(qualifiedNames.length > unique.length || results.some((result) => 'source_truncated' in result)
      ? { next_step: 'Pass an explicit limit or request the individual symbol with max_lines to expand context.' }
      : {}),
    value_metrics: {
      estimated_files_avoided: value.filesAvoided,
      estimated_tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
    },
  };
}
