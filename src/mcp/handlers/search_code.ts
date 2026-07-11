/*
 * search_code.ts — Graph-augmented code search.
 *
 * Phase 1: grep across indexed files for the pattern.
 * Phase 2: enrich matches with graph data — which function/class contains each match.
 * Phase 3: rank by structural importance (Functions first, tests last).
 *
 * Modes: compact (default, signatures only), full (with source), files (just paths).
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDb } from '../server.js';
import { search as graphSearch } from '../../store/search.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

interface SearchResult {
  node_id: number;
  node_name: string;
  qualified_name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  in_degree: number;
  out_degree: number;
  score: number;
  match_lines: number[];
  match_count: number;
}

export async function handleSearchCode(
  args: Record<string, unknown>
): Promise<unknown> {
  const started = Date.now();
  const pattern = String(args.pattern || '');
  const project = String(args.project || '');
  const filePattern = args.file_pattern ? String(args.file_pattern) : undefined;
  const pathFilter = args.path_filter ? String(args.path_filter) : undefined;
  const mode = String(args.mode || 'compact');
  const limit = args.limit ? Number(args.limit) : 10;
  const contextLines = args.context ? Number(args.context) : 0;
  const useRegex = args.regex === true;

  if (!pattern) return { error: 'pattern is required' };
  if (!project) return { error: 'project is required' };

  const db = getDb(project);
  const projInfo = db.getProject(project);
  if (!projInfo) return { error: `Project not found: ${project}` };

  // If pattern is not a regex and contains spaces, convert to ordered regex
  let searchPattern = pattern;
  let isRegex = useRegex;
  if (!isRegex && pattern.includes(' ')) {
    searchPattern = pattern
      .split(/\s+/)
      .map(w => w.replace(/[\\^$.|?*+(){}[\]]/g, '\\$&'))
      .join('.*');
    isRegex = true;
  }

  // Phase 1: grep across indexed files
  const allFiles = db.db
    .prepare('SELECT DISTINCT file_path FROM nodes WHERE project = ?')
    .all(project) as Array<{ file_path: string }>;

  if (allFiles.length === 0) {
    return { error: 'No indexed files found. Index the project first.', total_grep_matches: 0, total_results: 0, results: [] };
  }

  // Write indexed file paths to a temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-'));
  const fileListPath = path.join(tmpDir, 'files.txt');
  const patternFile = path.join(tmpDir, 'pattern.txt');

  const rootPath = projInfo.rootPath;
  const filesToSearch = allFiles
    .filter(f => {
      if (filePattern) {
        const glob = filePattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        try { return new RegExp(glob).test(f.file_path); } catch { return true; }
      }
      return true;
    })
    .map(f => f.file_path);

  if (filesToSearch.length === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: 'No files match file_pattern.', total_grep_matches: 0, total_results: 0, results: [] };
  }

  fs.writeFileSync(fileListPath, filesToSearch.join('\n'));
  fs.writeFileSync(patternFile, searchPattern);

  const grepFlag = isRegex ? '-E' : '-F';
  const cmd = `xargs grep -Hn ${grepFlag} -f '${patternFile}' < '${fileListPath}' 2>/dev/null`;

  let grepOutput = '';
  try {
    grepOutput = child_process.execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
    });
  } catch (e: any) {
    // grep exits 1 on no match, >1 on error
    if (e.status && e.status > 1) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { error: `grep failed: ${e.message}`, total_grep_matches: 0, total_results: 0, results: [] };
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Parse grep output: "relative/path:lineNumber:content"
  const rawMatches: GrepMatch[] = [];
  for (const line of grepOutput.split('\n')) {
    if (!line.trim()) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const file = line.substring(0, colonIdx);
    const rest = line.substring(colonIdx + 1);
    const secondColon = rest.indexOf(':');
    if (secondColon === -1) continue;
    const lineNum = parseInt(rest.substring(0, secondColon), 10);
    if (isNaN(lineNum)) continue;
    const content = rest.substring(secondColon + 1);
    rawMatches.push({ file, line: lineNum, content: content.trim().substring(0, 200) });
  }

  if (rawMatches.length === 0) {
    return { total_grep_matches: 0, total_results: 0, results: [], files: [] };
  }

  // Apply path_filter if provided
  const filteredMatches = pathFilter
    ? rawMatches.filter(m => { try { return new RegExp(pathFilter).test(m.file); } catch { return true; } })
    : rawMatches;

  // Phase 2: graph enrichment — find containing function/class for each match
  const resultsMap = new Map<string, SearchResult>();

  for (const gm of filteredMatches) {
    const filePath = gm.file;
    const matchLine = gm.line;

    // Find the smallest enclosing node (function first, then class, then file)
    const enclosingNode = db.db.prepare(
      `SELECT id, kind, name, qualified_name, start_line, end_line,
              (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as in_degree,
              (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as out_degree
       FROM nodes n
       WHERE n.project = ? AND n.file_path = ?
         AND n.start_line <= ? AND n.end_line >= ?
         AND n.kind IN ('Function', 'Method', 'Class', 'Interface', 'Variable')
       ORDER BY (n.end_line - n.start_line) ASC
       LIMIT 1`
    ).get(project, filePath, matchLine, matchLine) as {
      id: number; kind: string; name: string; qualified_name: string;
      start_line: number; end_line: number; in_degree: number; out_degree: number;
    } | undefined;

    if (enclosingNode) {
      const key = `${enclosingNode.id}`;
      const existing = resultsMap.get(key);
      if (existing) {
        existing.match_lines.push(matchLine);
        existing.match_count++;
      } else {
        resultsMap.set(key, {
          node_id: enclosingNode.id,
          node_name: enclosingNode.name,
          qualified_name: enclosingNode.qualified_name,
          kind: enclosingNode.kind,
          file: filePath,
          start_line: enclosingNode.start_line,
          end_line: enclosingNode.end_line,
          in_degree: enclosingNode.in_degree,
          out_degree: enclosingNode.out_degree,
          score: 0,
          match_lines: [matchLine],
          match_count: 1,
        });
      }
    } else {
      // Raw match — no enclosing graph node
      const fileKey = `file:${filePath}`;
      const existing = resultsMap.get(fileKey);
      if (existing) {
        existing.match_lines.push(matchLine);
        existing.match_count++;
      } else {
        resultsMap.set(fileKey, {
          node_id: 0,
          node_name: path.basename(filePath),
          qualified_name: filePath,
          kind: 'File',
          file: filePath,
          start_line: matchLine,
          end_line: matchLine,
          in_degree: 0,
          out_degree: 0,
          score: 0,
          match_lines: [matchLine],
          match_count: 1,
        });
      }
    }
  }

  // Phase 3: score and rank
  const results = Array.from(resultsMap.values());

  for (const r of results) {
    r.score = computeScore(r);
  }

  results.sort((a, b) => b.score - a.score);

  const limitedResults = results.slice(0, limit);

  // Phase 4: assemble output
  const outputResults = limitedResults.map(r => {
    const item: Record<string, unknown> = {
      name: r.node_name,
      qualified_name: r.qualified_name,
      kind: r.kind,
      file: r.file,
      start_line: r.start_line,
      end_line: r.end_line,
      in_degree: r.in_degree,
      out_degree: r.out_degree,
      match_lines: r.match_lines,
      match_count: r.match_count,
    };

    // Attach source or context
    if (mode === 'full') {
      const absPath = path.join(rootPath, r.file);
      try {
        const src = readLines(absPath, r.start_line, r.end_line);
        if (src) item.source = src;
      } catch { /* ignore */ }
    } else if (mode !== 'files' && contextLines > 0 && r.match_count > 0) {
      const ctxStart = Math.max(1, r.match_lines[0] - contextLines);
      const ctxEnd = r.match_lines[r.match_count - 1] + contextLines;
      const absPath = path.join(rootPath, r.file);
      try {
        const ctx = readLines(absPath, ctxStart, ctxEnd);
        if (ctx) {
          item.context = ctx;
          item.context_start = ctxStart;
        }
      } catch { /* ignore */ }
    }

    if (mode === 'compact') {
      // signature representation
      delete item.match_lines;
    }

    return item;
  });

  // Deduplicated file list
  const files = [...new Set(limitedResults.map(r => r.file))];

  const value = estimateTokensSaved(limitedResults.length, files.length);
  recordUsageEvent({
    type: 'search_graph',
    project,
    query: pattern,
    result_count: limitedResults.length,
    unique_files: files.length,
    files_avoided: value.filesAvoided,
    tokens_saved: value.tokensSaved,
    confidence: value.confidence,
    latency_ms: Date.now() - started,
    tool_hint: 'search_code',
  });

  return {
    total_grep_matches: filteredMatches.length,
    total_results: results.length,
    results: outputResults,
    files,
    value_metrics: {
      estimated_files_avoided: value.filesAvoided,
      estimated_tokens_saved: value.tokensSaved,
      confidence: value.confidence,
      latency_ms: Date.now() - started,
    },
  };
}

function computeScore(r: SearchResult): number {
  let score = r.in_degree;
  if (r.kind === 'Function' || r.kind === 'Method') score += 10;
  if (r.kind === 'Class') score += 5;
  if (r.kind === 'Route') score += 15;
  if (r.file.includes('vendored/') || r.file.includes('vendor/') || r.file.includes('node_modules/')) score -= 50;
  if (r.file.includes('test') || r.file.includes('spec') || r.file.includes('_test.')) score -= 5;
  return score;
}

function readLines(absPath: string, start: number, end: number): string | null {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(start - 1, end).join('\n');
  } catch {
    return null;
  }
}
