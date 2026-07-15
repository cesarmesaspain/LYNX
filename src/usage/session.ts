/*
 * session.ts — Real token savings via session-level suggestion vs read tracking.
 *
 * When the PreToolUse hook intercepts a Grep/Glob, it saves the files LYNX
 * would have suggested. When it intercepts a Read, it checks whether the file
 * was already suggested. Suggested files that are never Read = real savings.
 *
 * Session files live under ~/.lynx/sessions/ and auto-expire after 2h idle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lynxHome } from '../config/runtime.js';
import { storedTimestampMs } from '../store/time.js';

// ── Types ────────────────────────────────────────────────────────

export interface SuggestionRecord {
  seq: number;
  ts: string;
  query: string;
  files: string[];
  candidates: string[];
}

export interface ReadRecord {
  seq: number;
  ts: string;
  file: string;
  matchedSuggestionSeq: number | null;
}

export interface RealSavings {
  /** Total files suggested across all tracked suggestions */
  totalFilesSuggested: number;
  /** Files that were actually read (matched a suggestion) */
  filesActuallyRead: number;
  /** Files suggested but never read */
  filesAvoided: number;
  /** Estimated tokens saved: sum(real file sizes / 4) for avoided files */
  tokensSaved: number;
  /** Number of suggestions that have been fully resolved (all reads recorded or timed out) */
  suggestionsResolved: number;
  /** Number of suggestions still pending (no reads recorded yet, may still happen) */
  suggestionsPending: number;
  lastComputed: string;
}

export interface SessionData {
  project: string;
  cwd: string;
  startedAt: string;
  lastUpdated: string;
  suggestions: SuggestionRecord[];
  reads: ReadRecord[];
  seqCounter: number;
}

// ── Paths & expiry ───────────────────────────────────────────────

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function sessionDir(): string {
  const dir = path.join(lynxHome(), 'sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFileName(project: string, cwd: string): string {
  // Session key = project + abs(cwd), sanitized for filesystem
  const safe = `${project}__${cwd.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)}`;
  return `${safe}.json`;
}

function sessionFilePath(project: string, cwd: string): string {
  return path.join(sessionDir(), sessionFileName(project, cwd));
}

// ── Load / save ──────────────────────────────────────────────────

function loadSession(filePath: string): SessionData | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as SessionData;
    // Expire stale sessions
    const age = Date.now() - storedTimestampMs(data.lastUpdated);
    if (age > SESSION_TTL_MS) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveSession(filePath: string, data: SessionData): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getOrCreateSession(project: string, cwd: string): SessionData {
  const fp = sessionFilePath(project, cwd);
  const existing = loadSession(fp);
  if (existing) {
    existing.lastUpdated = new Date().toISOString();
    return existing;
  }
  const now = new Date().toISOString();
  return {
    project,
    cwd,
    startedAt: now,
    lastUpdated: now,
    suggestions: [],
    reads: [],
    seqCounter: 0,
  };
}

function commitSession(project: string, cwd: string, data: SessionData): void {
  data.lastUpdated = new Date().toISOString();
  saveSession(sessionFilePath(project, cwd), data);
}

// ── Public: record and query ─────────────────────────────────────

/** Record a suggestion from a Grep/Glob hook. */
export function recordSuggestion(
  project: string,
  cwd: string,
  query: string,
  files: string[],
  candidates: string[],
): number {
  const session = getOrCreateSession(project, cwd);
  const seq = session.seqCounter++;
  session.suggestions.push({
    seq,
    ts: new Date().toISOString(),
    query,
    files,
    candidates,
  });
  commitSession(project, cwd, session);
  return seq;
}

/**
 * Record a Read tool call. Returns whether it matched a previous suggestion.
 */
export function recordRead(
  project: string,
  cwd: string,
  filePath: string,
): { matched: boolean; matchedQuery?: string; matchedFiles?: string[] } {
  const fp = sessionFilePath(project, cwd);
  const session = loadSession(fp);
  if (!session) return { matched: false };

  // Find the most recent suggestion that includes this file
  let matchedSuggestion: SuggestionRecord | null = null;
  for (let i = session.suggestions.length - 1; i >= 0; i--) {
    const s = session.suggestions[i];
    const normalizedFiles = s.files.map((f) => f.replace(/\\/g, '/'));
    const normalizedRead = filePath.replace(/\\/g, '/');
    if (normalizedFiles.some((f) => normalizedRead.endsWith(f) || f.endsWith(normalizedRead))) {
      matchedSuggestion = s;
      break;
    }
  }

  const seq = session.seqCounter++;
  session.reads.push({
    seq,
    ts: new Date().toISOString(),
    file: filePath,
    matchedSuggestionSeq: matchedSuggestion?.seq ?? null,
  });
  commitSession(project, cwd, session);

  return {
    matched: matchedSuggestion !== null,
    matchedQuery: matchedSuggestion?.query,
    matchedFiles: matchedSuggestion?.files,
  };
}

/**
 * Compute real savings: which suggested files were never read.
 * Only resolves suggestions that are "settled" — either they have reads recorded
 * against them, or enough time has passed since the suggestion (>2 min without a matching read).
 */
export function computeRealSavings(
  project: string,
  cwd: string,
  rootPath?: string,
): RealSavings {
  const fp = sessionFilePath(project, cwd);
  const session = loadSession(fp);
  if (!session || session.suggestions.length === 0) {
    return {
      totalFilesSuggested: 0,
      filesActuallyRead: 0,
      filesAvoided: 0,
      tokensSaved: 0,
      suggestionsResolved: 0,
      suggestionsPending: 0,
      lastComputed: new Date().toISOString(),
    };
  }

  // Build a set of which suggestion files were read
  const readFiles = new Set<string>();
  const readSuggestionSeqs = new Set<number>();
  for (const r of session.reads) {
    const normalized = r.file.replace(/\\/g, '/');
    readFiles.add(normalized);
    if (r.matchedSuggestionSeq !== null) {
      readSuggestionSeqs.add(r.matchedSuggestionSeq);
    }
  }

  let totalSuggested = 0;
  let totalRead = 0;
  let resolved = 0;
  let pending = 0;
  const avoidedFiles: string[] = [];

  const now = Date.now();
  const SETTLE_MS = 2 * 60 * 1000; // 2 min to consider a suggestion settled

  for (const s of session.suggestions) {
    const suggestionAge = now - new Date(s.ts).getTime();
    const isSettled = readSuggestionSeqs.has(s.seq) || suggestionAge > SETTLE_MS;

    if (isSettled) {
      resolved++;
      totalSuggested += s.files.length;
      for (const f of s.files) {
        const normalized = f.replace(/\\/g, '/');
        const wasRead = [...readFiles].some((rf) =>
          rf.endsWith(normalized) || normalized.endsWith(rf),
        );
        if (wasRead) {
          totalRead++;
        } else {
          avoidedFiles.push(f);
        }
      }
    } else {
      pending++;
    }
  }

  // Compute real tokens saved from avoided file sizes
  let tokensSaved = 0;
  const resolvedRoot = rootPath || cwd;
  for (const f of avoidedFiles) {
    try {
      const fullPath = path.join(resolvedRoot, f);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          tokensSaved += Math.round(stat.size / 4);
        }
      }
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  // For pending suggestions, estimate potential additional savings
  // (not included in tokensSaved but reported separately)

  return {
    totalFilesSuggested: totalSuggested,
    filesActuallyRead: totalRead,
    filesAvoided: totalSuggested - totalRead,
    tokensSaved,
    suggestionsResolved: resolved,
    suggestionsPending: pending,
    lastComputed: new Date().toISOString(),
  };
}

/** Get summary stats without computing full savings. */
export function getSessionStats(
  project: string,
  cwd: string,
): { suggestions: number; reads: number; age: number } | null {
  const fp = sessionFilePath(project, cwd);
  const session = loadSession(fp);
  if (!session) return null;
  const age = Date.now() - storedTimestampMs(session.startedAt);
  return {
    suggestions: session.suggestions.length,
    reads: session.reads.length,
    age,
  };
}

/** Clear session files for a project, or all if no project given. */
export function clearSessions(project?: string, cwd?: string): number {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(dir, file);
    if (project && cwd) {
      if (file === sessionFileName(project, cwd)) {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } else if (project) {
      if (file.startsWith(`${project}__`)) {
        fs.unlinkSync(fullPath);
        removed++;
      }
    } else {
      fs.unlinkSync(fullPath);
      removed++;
    }
  }
  return removed;
}
