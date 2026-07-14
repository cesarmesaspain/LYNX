import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../server.js';
import { projectNotIndexed } from '../diagnostics.js';
import { findNodeByQn } from '../../store/nodes.js';
import { getNeighborNames } from '../../store/traverse.js';
import { searchFullText } from '../../store/search.js';
import { narrateSnippet } from '../../intelligence/narrative.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { readLynxConfig } from '../../config/runtime.js';

function enrichNeighbors(
  db: ReturnType<typeof getDb>,
  project: string,
  rootPath: string,
  names: string[]
): Array<{ name: string; file_path?: string; signature?: string }> {
  if (names.length === 0) return [];
  // Batch lookup: get file_path + start_line for each neighbor name
  const placeholders = names.map(() => '?').join(',');
  const rows = db.db.prepare(
    `SELECT name, file_path, start_line FROM nodes WHERE project = ? AND name IN (${placeholders})`
  ).all(project, ...names) as Array<{ name: string; file_path: string; start_line: number }>;
  const infoMap = new Map<string, { file_path: string; start_line: number }>();
  for (const row of rows) {
    if (!infoMap.has(row.name)) infoMap.set(row.name, { file_path: row.file_path, start_line: row.start_line });
  }
  // Read signatures grouped by file
  const sigMap = new Map<string, string>();
  const byFile = new Map<string, { name: string; line: number }[]>();
  for (const [name, info] of infoMap) {
    if (!byFile.has(info.file_path)) byFile.set(info.file_path, []);
    byFile.get(info.file_path)!.push({ name, line: info.start_line });
  }
  for (const [fp, entries] of byFile) {
    try {
      const source = fs.readFileSync(path.join(rootPath, fp), 'utf-8');
      const lines = source.split('\n');
      for (const e of entries) {
        const idx = Math.max(0, e.line - 1);
        if (idx < lines.length) sigMap.set(e.name, lines[idx].trim());
      }
    } catch { /* skip */ }
  }
  return names.map(name => {
    const info = infoMap.get(name);
    return {
      name,
      file_path: info?.file_path,
      signature: sigMap.get(name),
    };
  });
}

export async function handleGetCodeSnippet(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const qualifiedName = String(args.qualified_name || '');
  const project = String(args.project || '');
  const includeNeighbors = args.include_neighbors === true;

  const db = getDb(project);
  if (!db.getProject(project)) return { ...projectNotIndexed(project) };

  // Find node
  let node = findNodeByQn(db, project, qualifiedName);
  if (!node) {
    const results = searchFullText(db, project, qualifiedName, 1);
    if (results.length === 0) {
      return { error: `Symbol not found: ${qualifiedName}` };
    }
    // Only accept fuzzy fallback if the result is a plausible match: the
    // requested QN or its last segment must appear in the found qualified name.
    const matchedQn = results[0].node.qualifiedName;
    const lastSegment = qualifiedName.split('.').pop() || '';
    if (!matchedQn.includes(qualifiedName) && !matchedQn.includes(lastSegment)) {
      return { error: `Symbol not found: ${qualifiedName}` };
    }
    node = findNodeByQn(db, project, matchedQn);
    if (!node) {
      return { error: `Symbol not found: ${qualifiedName}` };
    }
  }

  // Get project root path
  const projectMeta = db.getProject(project);
  const rootPath = projectMeta?.rootPath || process.cwd();

  // Read source file
  const filePath = path.join(rootPath, node.file_path);
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { error: `Cannot read file: ${node.file_path}` };
  }

  // Extract the relevant lines
  const lines = source.split('\n');
  const start = Math.max(0, node.start_line - 1);
  let end = Math.min(lines.length, node.end_line);
  if (end - start <= 1 && start < lines.length) {
    end = Math.min(lines.length, start + 20);
  }
  const savingsMode = readLynxConfig().agent_response?.enabled && readLynxConfig().agent_response?.budget === 'max_savings';
  const requestedMaxLines = Number(args.max_lines);
  const maxLines = Number.isFinite(requestedMaxLines) && requestedMaxLines > 0
    ? Math.floor(requestedMaxLines)
    : (savingsMode ? 120 : Number.POSITIVE_INFINITY);
  const truncated = end - start > maxLines;
  if (truncated) end = start + maxLines;
  const snippet = lines.slice(start, end).join('\n');

  const result: Record<string, unknown> = {
    name: node.name,
    qualified_name: node.qualified_name,
    file_path: node.file_path,
    start_line: node.start_line,
    end_line: node.end_line,
    kind: node.kind,
    is_exported: node.is_exported === 1,
    source: snippet,
    ...(truncated ? { source_truncated: true, next_step: 'Request max_lines to expand this snippet.' } : {}),
  };

  let callers: string[] = [];
  let callees: string[] = [];

  if (includeNeighbors) {
    const neighbors = getNeighborNames(db, node.id, 10);
    callers = neighbors.callers;
    callees = neighbors.callees;
    // Enrich neighbors with file_path + 1-line signature to eliminate follow-up calls
    result.callers = enrichNeighbors(db, project, rootPath, callers);
    result.callees = enrichNeighbors(db, project, rootPath, callees);
  } else {
    // Always get neighbors for narrative context, even if not included in response
    const neighbors = getNeighborNames(db, node.id, 10);
    callers = neighbors.callers;
    callees = neighbors.callees;
  }

  // Include test coverage — eliminates separate find_tests call
  try {
    const testRows = db.db.prepare(
      'SELECT n.name FROM edges e JOIN nodes n ON n.id = e.source_id WHERE e.project = ? AND e.target_id = ? AND e.type = ? LIMIT 5'
    ).all(project, node.id, 'TESTS') as Array<{ name: string }>;
    if (testRows.length > 0) {
      result.tested_by = testRows.map(r => r.name);
    }
  } catch { /* TESTS edges may not exist */ }

  // Complexity from properties JSON
  let complexity: number | undefined;
  try {
    const props = JSON.parse((node as unknown as Record<string, unknown>).properties as string || '{}');
    if (props.cyclomaticComplexity !== undefined) {
      complexity = Number(props.cyclomaticComplexity);
    }
  } catch { /* ignore */ }

  const narrative = narrateSnippet(
    {
      id: node.id,
      project: '',
      kind: node.kind as never,
      name: node.name,
      qualifiedName: node.qualified_name,
      filePath: node.file_path,
      startLine: node.start_line,
      endLine: node.end_line,
      isExported: node.is_exported === 1,
      isTest: false,
      isEntryPoint: false,
    },
    callers,
    callees,
    complexity
  );

  result.narrative = { role: narrative.role };
  if (narrative.complexityNote) {
    result.complexity_note = narrative.complexityNote;
  }

  const value = estimateTokensSaved({ resultCount: 1, candidateFiles: 1, files: [node.file_path], rootPath });
  (result as Record<string, unknown>).value_metrics = {
    estimated_files_avoided: value.filesAvoided,
    estimated_tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
  };
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: qualifiedName,
    result_count: 1,
    unique_files: 1,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
    tool_hint: 'get_code_snippet',
  });

  return result;
}
