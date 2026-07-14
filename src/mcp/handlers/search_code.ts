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
import type { LynxDatabase } from '../../store/database.js';
import { estimateTokensSaved, recordUsageEvent } from '../../usage/metrics.js';
import { readLynxConfig } from '../../config/runtime.js';

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
  // Align with the discovery vocabulary used by search_graph and common MCP clients.
  const pattern = String(args.pattern || args.query || args.text || '');
  const project = String(args.project || '');
  const filePattern = args.file_pattern ? String(args.file_pattern) : args.glob ? String(args.glob) : undefined;
  const pathFilter = args.path_filter ? String(args.path_filter) : args.path_prefix ? String(args.path_prefix) : undefined;
  const mode = String(args.mode || 'compact');
  const savingsMode = readLynxConfig().agent_response?.enabled && readLynxConfig().agent_response?.budget === 'max_savings';
  const defaultLimit = savingsMode ? 5 : 10;
  const requestedLimit = args.limit !== undefined ? Number(args.limit) : args.max_results !== undefined ? Number(args.max_results) : defaultLimit;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.floor(requestedLimit), 1000))
    : 10;
  const contextLines = args.context ? Number(args.context) : 0;
  const useRegex = args.regex === true;

  if (!pattern) return { error: 'pattern is required' };
  if (!project) return { error: 'project is required' };

  const db = getDb(project);
  const projInfo = db.getProject(project);
  if (!projInfo) return { error: `Project not found: ${project}` };

  const rawMatches = runGrepSearch(db, project, pattern, useRegex, projInfo.rootPath, filePattern);
  if ('error' in rawMatches) return rawMatches;

  if (rawMatches.length === 0) {
    return { total_grep_matches: 0, total_results: 0, results: [], files: [] };
  }

  // Apply path_filter if provided
  const filteredMatches = pathFilter
    ? rawMatches.filter(m => { try { return new RegExp(pathFilter).test(m.file); } catch { return true; } })
    : rawMatches;

  // Phase 2: graph enrichment
  const resultsMap = enrichMatchesWithGraph(db, project, filteredMatches);

  // Phase 3: score and rank
  const results = Array.from(resultsMap.values());
  for (const r of results) r.score = computeScore(r);
  results.sort((a, b) => b.score - a.score);
  const limitedResults = results.slice(0, limit);

  // Phase 4: assemble output
  const outputResults = buildSearchOutput(limitedResults, mode, projInfo.rootPath, contextLines);
  const files = [...new Set(limitedResults.map(r => r.file))];

  const value = estimateTokensSaved({ resultCount: limitedResults.length, candidateFiles: files.length, files, rootPath: projInfo.rootPath });
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

// ── Phase 1: grep ──────────────────────────────────────

/** Detect whether a pattern looks like a regex rather than a literal search. */
function looksLikeRegex(pattern: string): boolean {
  // Common regex escape sequences: \. \d \w \s \b \n \t \r \+ \* \?
  if (/\\[.dwsbntrDWSNB+*?(){}[\]]/.test(pattern)) return true;
  // Character classes, alternation with grouping
  if (/\[.*\]/.test(pattern)) return true;
  if (/\(.+\|.+\)/.test(pattern)) return true;
  // Bare alternation (e.g. "foo|bar")
  if (/\|/.test(pattern)) return true;
  // Anchors at start/end
  if (/^\^/.test(pattern) || /\$$/.test(pattern)) return true;
  return false;
}

export function runGrepSearch(
  db: LynxDatabase,
  project: string,
  pattern: string,
  useRegex: boolean,
  rootPath: string,
  filePattern?: string,
): GrepMatch[] | { error: string; total_grep_matches: number; total_results: number; results: never[] } {
  let searchPattern = pattern;
  let isRegex = useRegex;
  // Auto-detect regex intent: common regex escape sequences or metacharacters
  // that are unlikely to appear in a literal code search.
  if (!isRegex && looksLikeRegex(pattern)) {
    isRegex = true;
  }
  if (!isRegex && pattern.includes(' ')) {
    searchPattern = pattern
      .split(/\s+/)
      .map(w => w.replace(/[\\^$.|?*+(){}[\]]/g, '\\$&'))
      .join('.*');
    isRegex = true;
  }

  const allFiles = db.db
    .prepare('SELECT DISTINCT file_path FROM nodes WHERE project = ?')
    .all(project) as Array<{ file_path: string }>;

  if (allFiles.length === 0) {
    return { error: 'No indexed files found. Index the project first.', total_grep_matches: 0, total_results: 0, results: [] };
  }

  const searchableExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
    '.c', '.h', '.cpp', '.hpp', '.rb', '.swift', '.kt', '.scala',
    '.sql', '.sh', '.bash', '.yaml', '.yml', '.toml', '.xml',
    '.css', '.scss', '.html', '.vue', '.svelte', '.php', '.cs',
    '.m', '.mm',
  ]);

  const filesToSearch = allFiles
    .filter(f => {
      const fp = f.file_path;
      if (!fp) return false;
      // Must match filePattern if provided
      if (filePattern) {
        const glob = filePattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        try { if (!new RegExp(glob).test(fp)) return false; } catch { return false; }
      }
      // Must have a searchable extension
      const ext = fp.includes('.') ? fp.slice(fp.lastIndexOf('.')) : '';
      return searchableExtensions.has(ext);
    })
    .map(f => f.file_path);

  if (filesToSearch.length === 0) {
    return { error: 'No searchable code files found.', total_grep_matches: 0, total_results: 0, results: [] };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-'));
  const patternFile = path.join(tmpDir, 'pattern.txt');
  fs.writeFileSync(patternFile, searchPattern + '\n');

  const grepFlag = isRegex ? '-E' : '-F';
  // Run grep in batches to avoid ARG_MAX on macOS (~256KB). Each batch: 500 files max.
  const BATCH = 500;
  try {
    let allOutput = '';
    for (let i = 0; i < filesToSearch.length; i += BATCH) {
      const batch = filesToSearch.slice(i, i + BATCH);
      try {
        const out = child_process.execFileSync('grep', ['-Hn', grepFlag, '-f', patternFile, '--', ...batch], {
          cwd: rootPath,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024,
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (out) allOutput += out;
      } catch (e: any) {
        // grep exit 1 = no matches in this batch (not an error), exit 2+ = real error
        if (e.status && e.status > 1) {
          return { error: `grep failed: ${e.message}`, total_grep_matches: 0, total_results: 0, results: [] };
        }
        // status 1: no matches in batch, continue
      }
    }
    return parseGrepOutput(allOutput);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseGrepOutput(grepOutput: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
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
    matches.push({ file, line: lineNum, content: content.trim().substring(0, 200) });
  }
  return matches;
}

// ── Phase 2: graph enrichment ──────────────────────────

function enrichMatchesWithGraph(
  db: LynxDatabase,
  project: string,
  matches: GrepMatch[],
): Map<string, SearchResult> {
  const resultsMap = new Map<string, SearchResult>();

  const stmt = db.db.prepare(
    `SELECT id, kind, name, qualified_name, start_line, end_line,
            (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as in_degree,
            (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as out_degree
     FROM nodes n
     WHERE n.project = ? AND n.file_path = ?
       AND n.start_line <= ? AND n.end_line >= ?
       AND n.kind IN ('Function', 'Method', 'Class', 'Interface', 'Variable')
     ORDER BY (n.end_line - n.start_line) ASC
     LIMIT 1`
  );

  for (const gm of matches) {
    const enclosingNode = stmt.get(project, gm.file, gm.line, gm.line) as {
      id: number; kind: string; name: string; qualified_name: string;
      start_line: number; end_line: number; in_degree: number; out_degree: number;
    } | undefined;

    if (enclosingNode) {
      const key = `${enclosingNode.id}`;
      const existing = resultsMap.get(key);
      if (existing) {
        existing.match_lines.push(gm.line);
        existing.match_count++;
      } else {
        resultsMap.set(key, {
          node_id: enclosingNode.id,
          node_name: enclosingNode.name,
          qualified_name: enclosingNode.qualified_name,
          kind: enclosingNode.kind,
          file: gm.file,
          start_line: enclosingNode.start_line,
          end_line: enclosingNode.end_line,
          in_degree: enclosingNode.in_degree,
          out_degree: enclosingNode.out_degree,
          score: 0,
          match_lines: [gm.line],
          match_count: 1,
        });
      }
    } else {
      const fileKey = `file:${gm.file}`;
      const existing = resultsMap.get(fileKey);
      if (existing) {
        existing.match_lines.push(gm.line);
        existing.match_count++;
      } else {
        resultsMap.set(fileKey, {
          node_id: 0,
          node_name: path.basename(gm.file),
          qualified_name: gm.file,
          kind: 'File',
          file: gm.file,
          start_line: gm.line,
          end_line: gm.line,
          in_degree: 0,
          out_degree: 0,
          score: 0,
          match_lines: [gm.line],
          match_count: 1,
        });
      }
    }
  }

  return resultsMap;
}

// ── Phase 4: assemble output ───────────────────────────

function buildSearchOutput(
  results: SearchResult[],
  mode: string,
  rootPath: string,
  contextLines: number,
): Record<string, unknown>[] {
  return results.map(r => {
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
      delete item.match_lines;
    }

    return item;
  });
}

// ── Helpers ─────────────────────────────────────────────

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
