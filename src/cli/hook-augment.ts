/*
 * hook-augment.ts — Claude PreToolUse augmenter. v5 — DECAY COUNTER.
 *
 * v6 — Project-scoped strict counter:
 * - Each project has its own counter for the current agent session.
 * - A successful LYNX tool resets that project's discovery budget.
 * - After LYNX_STRICT_THRESHOLD (default 4), emits permissionDecision: "deny".
 * - Mixed usage (70% LYNX, 30% filesystem) naturally stays below threshold.
 * - Bash targets on non-code files (.json/.md/.yaml/etc.) never count.
 *
 * v4 — Counter-based blocking.
 * v3 — Real token savings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LynxDatabase } from '../store/database.js';
import { searchFullText } from '../store/search.js';
import { findNearestProject } from '../discovery/project-scanner.js';
import { lynxHome } from '../config/runtime.js';
import {
  estimateTokensSaved,
  estimateTokensFromFiles,
  recordUsageEvent,
  summarizeUsage,
} from '../usage/metrics.js';
import {
  recordSuggestion,
  recordRead,
  computeRealSavings,
} from '../usage/session.js';
import type { LynxSearchResult } from '../types.js';

const MAX_STDIN_BYTES = 256 * 1024;
const DEADLINE_MS = 300;
const MAX_RESULTS = 5;
const STRICT_THRESHOLD = parseInt(process.env.LYNX_STRICT_THRESHOLD || '4', 10);
const COUNTER_RESET_MS = parseInt(process.env.LYNX_COUNTER_RESET_MS || '600000', 10); // 10 min
const NON_CODE_EXTS = /\.(json|md|ya?ml|toml|lock|gitignore|env|txt|csv|xml|svg|css|html|htm|ini|cfg|conf|editorconfig|prettierrc|eslintrc|babelrc|dockerignore|npmignore|gitattributes)$/i;
const NON_CODE_FILES = /(?:^|\/|\s)(?:README|CHANGELOG|LICENSE|Makefile|Dockerfile|\.(?:env|git|docker|editorconfig|prettier|eslint|babel))$/im;

interface HookPayload {
  cwd?: string;
  workspace?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

type HookTool = 'grep' | 'glob' | 'read' | 'bash' | 'unknown';

export async function runHookAugment(): Promise<void> {
  const timer = setTimeout(() => process.exit(0), DEADLINE_MS);
  timer.unref();

  try {
    const raw = await readStdin(MAX_STDIN_BYTES);
    if (!raw.trim()) return;

    const payload = JSON.parse(raw) as HookPayload;
    const toolInput = payload.tool_input || payload.toolInput || payload.input || {};
    const tool = detectTool(payload, toolInput);
    if (tool === 'unknown') return;

    const cwd = String(payload.cwd || payload.workspace || process.cwd());
    const detected = findNearestProject(cwd);
    if (!detected) return;

    const project = resolveProjectNameByRoot(detected.name, detected.rootPath);
    const strict = isStrictMode();

    const projectScoped = isProjectScopedAction(tool, toolInput, detected.rootPath, cwd);

    // ── Counter check (strict mode only) ──
    if (strict) {
      // Bash: only count exploratory commands (grep, find, cat, etc.), not build/infra
      const exploratory = tool !== 'bash' || isExploratoryBash(String(toolInput.command || ''), String(toolInput.file_path || ''));
      const shouldCount = projectScoped && exploratory;
      const counter = shouldCount ? touchCounter(project) : readCounter(project);
      // The first code-discovery action of a chat must be LYNX. Once a LYNX
      // call succeeds, normal strict-mode tolerance resumes for targeted
      // filesystem work. This prevents the expensive `ls/find/read` prelude
      // seen in fresh Claude sessions without blocking legitimate later work.
      const blocked = shouldCount && (!counter.lynxUsed || counter.count > STRICT_THRESHOLD);
      if (blocked) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: formatBlockMessage(tool, project, counter.count),
            },
          })
        );
        return;
      }
    }

    if (tool === 'read') {
      if (projectScoped) await handleReadHook(project, cwd, toolInput, detected.rootPath, strict);
    } else {
      if (projectScoped) await handleSearchHook(project, cwd, tool, toolInput, detected.rootPath, strict);
    }
  } catch {
    // Hook augmentation must never break or delay the user's tool call.
  } finally {
    clearTimeout(timer);
  }
}

// ── Session counter (strict mode) ──────────────────────────────

export interface SessionCounter {
  count: number;
  lastTouch: number; // Date.now()
  strictMode: boolean;
  /** Set by the MCP server after the session has made a LYNX call. */
  lynxUsed: boolean;
}

interface CounterStore {
  version: 2;
  projects: Record<string, SessionCounter>;
}

function counterPath(): string {
  return path.join(lynxHome(), 'session-counter.json');
}

function defaultCounter(): SessionCounter {
  return { count: 0, lastTouch: Date.now(), strictMode: false, lynxUsed: false };
}

function readCounterStore(): CounterStore {
  try {
    const raw = JSON.parse(fs.readFileSync(counterPath(), 'utf-8')) as Partial<CounterStore & SessionCounter>;
    if (raw.version === 2 && raw.projects && typeof raw.projects === 'object') {
      return { version: 2, projects: raw.projects };
    }
    // Migrate the former single counter lazily. It is intentionally not
    // attributed to a project, so it cannot contaminate the next project.
    return { version: 2, projects: {} };
  } catch {
    return { version: 2, projects: {} };
  }
}

function writeCounterStore(store: CounterStore): void {
  try {
    fs.writeFileSync(counterPath(), JSON.stringify(store) + '\n');
  } catch {
    // Best-effort
  }
}

function readCounter(project: string): SessionCounter {
  return readCounterStore().projects[project] || defaultCounter();
}

function writeCounter(project: string, counter: SessionCounter): void {
  const store = readCounterStore();
  store.projects[project] = counter;
  writeCounterStore(store);
}

function isStrictMode(): boolean {
  return process.env.LYNX_STRICT === '1';
}

/** Called every time the hook fires. Returns the updated session state. */
function touchCounter(project: string): SessionCounter {
  const now = Date.now();
  const c = readCounter(project);

  // Auto-reset after inactivity
  if (now - c.lastTouch > COUNTER_RESET_MS) {
    c.count = 0;
  }

  c.count++;
  c.lastTouch = now;
  c.strictMode = isStrictMode();
  writeCounter(project, c);

  return c;
}

/** A successful LYNX request completes the discovery step for this project. */
export function decayCounter(project: string): void {
  const c = readCounter(project);
  c.count = 0;
  c.lastTouch = Date.now();
  c.strictMode = isStrictMode();
  c.lynxUsed = true;
  writeCounter(project, c);
}

/** Reset counter to 0 (kept for CLI). */
export function resetCounter(project: string): void {
  decayCounter(project);
}

/** Read current counter state (for CLI display). */
export function readCounterState(project: string): SessionCounter {
  const c = readCounter(project);
  const now = Date.now();
  if (now - c.lastTouch > COUNTER_RESET_MS) {
    return { count: 0, lastTouch: now, strictMode: isStrictMode(), lynxUsed: false };
  }
  return c;
}

function pathIsInside(rootPath: string, candidate: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(candidate);
  return target === root || target.startsWith(root + path.sep);
}

/** Whether this hook action actually explores the project resolved from cwd. */
export function isProjectScopedAction(
  tool: HookTool,
  toolInput: Record<string, unknown>,
  rootPath: string,
  cwd: string,
): boolean {
  const explicit = String(toolInput.file_path || toolInput.path || '');
  if (explicit) {
    return pathIsInside(rootPath, path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit));
  }
  if (tool === 'bash') {
    const target = extractFileTarget(String(toolInput.command || ''));
    if (target && path.isAbsolute(target)) return pathIsInside(rootPath, target);
  }
  // Grep/Glob without an explicit path and shell exploration without an
  // absolute target operate from cwd, which is how the project was resolved.
  return pathIsInside(rootPath, cwd);
}

// ── Tool detection ──────────────────────────────────────────────

function detectTool(payload: HookPayload, input: Record<string, unknown>): HookTool {
  // Explicit tool_name from Claude Code hook payload
  const name = (payload.tool_name || payload.toolName || '').toLowerCase();
  if (name === 'read' || name === 'grep' || name === 'glob' || name === 'bash') {
    return name as HookTool;
  }

  // Fallback: detect by input shape
  if (typeof input.file_path === 'string' && input.file_path.length > 0) return 'read';
  if (typeof input.command === 'string') return 'bash';
  if (typeof input.pattern === 'string') return 'grep';

  return 'unknown';
}

// ── Bash classification (strict mode) ────────────────────────────

const EXPLORATORY_BASH_RE = /(?:^|\s|[|&;`])(?:grep|rg|ag|ack|find|fd|locate|cat|head|tail|less|more|ls|tree|read|wc|file|stat|bat|rgrep)(?:\s|$)/;
const NON_EXPLORATORY_BASH_RE = /^(?:npm|yarn|pnpm|npx|node|bun|deno|tsc|vitest|jest|mocha|git\b(?!\s+grep)|docker|kubectl|curl|wget|echo|mkdir|rm|cp|mv|cd|pwd|export|source|python|go\b|cargo|make|gh\b|brew|pip|gem|cargo|rustc|java|javac|dotnet|cmake|meson|ninja|gcc|clang|g\+\+|cc)\b/;

function isExploratoryBash(command: string, filePath: string): boolean {
  // If the command is clearly infrastructure (npm run, node dist, etc.), skip
  if (/^(?:npm run|npm test|npm ci|npm install|npx |node dist|node \S+\.(?:mjs|js|cjs))(?:$|\s)/.test(command.trim())) return false;
  // Build/test/package manager commands that are definitely NOT code exploration
  if (NON_EXPLORATORY_BASH_RE.test(command.trim())) return false;
  // If the command touches a non-code file, skip
  if (filePath && (NON_CODE_EXTS.test(filePath) || NON_CODE_FILES.test(filePath))) return false;
  // Also detect non-code targets from the command args (cat file.json, tail file.md, etc.)
  const cmdTarget = extractFileTarget(command);
  if (cmdTarget && (NON_CODE_EXTS.test(cmdTarget) || NON_CODE_FILES.test(cmdTarget))) return false;
  // Catch non-code filenames without extensions (Dockerfile, Makefile, etc.)
  if (!cmdTarget && NON_CODE_FILES.test(command.trim())) return false;
  // If it contains exploratory commands (grep, find, cat, etc.), count it
  return EXPLORATORY_BASH_RE.test(command);
}

/** Extract likely file path target from a shell command. */
function extractFileTarget(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] && !parts[i].startsWith('-') && /[./]/.test(parts[i]) && /\.[a-z]{1,10}$/i.test(parts[i])) {
      return parts[i];
    }
  }
  return null;
}

// ── Read hook handler ───────────────────────────────────────────

async function handleReadHook(
  project: string,
  cwd: string,
  toolInput: Record<string, unknown>,
  rootPath: string,
  strict: boolean,
): Promise<void> {
  const filePath = String(toolInput.file_path || '');
  if (!filePath) return;

  const result = recordRead(project, cwd, filePath);

  // ── Strict mode: look up symbols in this file ──
  if (strict) {
    try {
      const db = LynxDatabase.openProject(project);
      try {
        // Get relative path from the read path
        const relPath = filePath.startsWith(rootPath)
          ? path.relative(rootPath, filePath)
          : filePath;

        const symbols = db.db
          .prepare(
            `SELECT name, qualified_name, kind, start_line
             FROM nodes WHERE project = ? AND file_path = ?
             AND kind IN ('Function', 'Method', 'Class', 'Interface', 'Variable', 'Route')
             LIMIT ${MAX_RESULTS}`
          )
          .all(project, relPath) as Array<{ name: string; qualified_name: string; kind: string; start_line: number }>;

        if (symbols.length > 0) {
          const counter = readCounter(project);
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: formatReadRedirect(filePath, symbols, counter.count),
              },
            })
          );
          return;
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to regular behaviour
    }
  }

  if (!result.matched) return; // Not a file LYNX suggested — nothing to say

  const realSavings = computeRealSavings(project, cwd, rootPath);
  const counter = readCounter(project);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: formatReadWarning(
          filePath,
          result.matchedQuery || '',
          result.matchedFiles || [],
          realSavings,
          counter.count,
        ),
      },
    })
  );
}

// ── Search hook handler (Grep/Glob) ─────────────────────────────

async function handleSearchHook(
  project: string,
  cwd: string,
  tool: HookTool,
  toolInput: Record<string, unknown>,
  rootPath: string,
  strict: boolean,
): Promise<void> {
  const query = extractSearchText(toolInput);
  const token = extractUsefulToken(query);
  if (!token) return;

  const db = LynxDatabase.openProject(project);
  try {
    const results = searchFullText(db, project, token, MAX_RESULTS);
    if (results.length === 0) return;

    const files = results.map((r) => r.node.filePath);
    const candidates = results.map((r) => r.node.qualifiedName);

    // ── Session tracking: save suggestion for later comparison ──
    recordSuggestion(project, cwd, token, files, candidates);

    // ── Estimated savings (formula, same as before) ─────────────
    const uniqueFiles = new Set(files).size;
    const estimated = estimateTokensSaved({ resultCount: results.length, candidateFiles: results.length * 4, files, rootPath, project });

    recordUsageEvent({
      type: 'hook_augment',
      project,
      query: token,
      result_count: results.length,
      unique_files: uniqueFiles,
      files_avoided: estimated.filesAvoided,
      tokens_saved: estimated.tokensSaved,
      confidence: estimated.confidence,
      files,
      tool_hint: `PreToolUse ${tool}`,
    });

    // ── Real savings: suggested files that were never Read ──────
    const real = computeRealSavings(project, cwd, rootPath);
    if (real.tokensSaved > 0) {
      recordUsageEvent({
        type: 'real_savings',
        project,
        query: `session:${project}`,
        files_avoided: real.filesAvoided,
        tokens_saved: real.tokensSaved,
        confidence: real.suggestionsResolved >= 2 ? 'high' : real.suggestionsResolved >= 1 ? 'medium' : 'low',
        files: [], // real savings from session, not per-query files
        tool_hint: 'session_real_savings',
      });
    }

    const usage = summarizeUsage(project, 500);
    const counter = readCounter(project);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: formatSearchContext(
            token,
            project,
            results,
            estimated.tokensSaved,
            estimated.confidence,
            usage.tokens_saved,
            usage.unique_files_avoided,
            real,
            strict,
            counter.count,
          ),
        },
      })
    );
  } finally {
    db.close();
  }
}

// ── Stdin ───────────────────────────────────────────────────────

function readStdin(maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        process.stdin.destroy();
        resolve('');
        return;
      }
      chunks.push(chunk);
    });

    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function extractSearchText(input: Record<string, unknown>): string {
  const values = [input.pattern, input.query, input.glob, input.path, input.include];
  return values.filter((value): value is string => typeof value === 'string').join(' ');
}

function extractUsefulToken(text: string): string | null {
  const tokens = text.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) || [];
  if (tokens.length === 0) return null;
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0] ?? null;
}

// ── Project resolution ──────────────────────────────────────────

function resolveProjectNameByRoot(defaultName: string, rootPath: string): string {
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (!fs.existsSync(dbsDir)) return defaultName;

  let bestName = defaultName;
  let bestNodes = -1;
  for (const file of fs.readdirSync(dbsDir)) {
    if (!file.endsWith('.db')) continue;
    const candidate = file.replace(/\.db$/, '');
    try {
      const db = LynxDatabase.openProject(candidate);
      try {
        const row = db.db
          .prepare('SELECT root_path FROM projects WHERE name = ?')
          .get(candidate) as { root_path: string } | undefined;
        if (!row || row.root_path !== rootPath) continue;

        const count =
          (
            db.db
              .prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?')
              .get(candidate) as { cnt: number } | undefined
          )?.cnt ?? 0;
        if (count > bestNodes) {
          bestName = candidate;
          bestNodes = count;
        }
      } finally {
        db.close();
      }
    } catch {
      // Ignore unreadable stale DBs.
    }
  }
  return bestName;
}

// ── Output formatters ───────────────────────────────────────────

function formatBlockMessage(tool: string, project: string, count: number): string {
  const header = count >= 8
    ? '🚨🚨 BLOQUEO LYNX STRICT 🚨🚨'
    : '🚨 LYNX: Tool bloqueada por modo strict';

  return [
    header,
    '',
    `Has usado ${count} herramientas de archivo (${tool}) consecutivas SIN usar ninguna tool de LYNX.`,
    `Proyecto indexado: ${project}.`,
    '',
    'Usa la tool MCP de LYNX mas pequena que aporte la evidencia estructural necesaria:',
    '- search_graph para definiciones y relaciones indexadas',
    '- get_code_snippet o batch_get_code para fuente exacta de simbolos conocidos',
    '- trace_path cuando callers, callees o flujo sean relevantes',
    '- query_graph para metricas o relaciones cruzadas',
    '',
    'Una llamada MCP de LYNX desbloquea la exploracion local dirigida para este chat.',
  ].join('\n');
}

function formatReadRedirect(
  filePath: string,
  symbols: Array<{ name: string; qualified_name: string; kind: string; start_line: number }>,
  count: number,
): string {
  const lines = [
    `⚠️ LYNX STRICT: Estas leyendo \`${filePath}\` que tiene ${symbols.length} simbolos indexados.`,
    '',
    'Para fuente exacta de los simbolos indexados, considera:',
  ];

  // Single symbol → suggest get_code_snippet
  if (symbols.length === 1) {
    const s = symbols[0];
    lines.push(`get_code_snippet("${s.qualified_name}") — ${s.kind} en linea ${s.start_line}`);
  } else {
    // Multiple symbols → suggest batch_get_code
    const qns = symbols.map(s => `"${s.qualified_name}"`).join(', ');
    lines.push(`batch_get_code([${qns}])`);
    lines.push('');
    lines.push('Simbolos en este archivo:');
    for (const s of symbols) {
      lines.push(`  - ${s.kind} \`${s.name}\` (linea ${s.start_line}) → \`${s.qualified_name}\``);
    }
  }

  if (count >= 2) {
    lines.push('');
    lines.push(`Llevas ${count} tools de archivo sin usar LYNX. A la ${STRICT_THRESHOLD + 1} se bloquearan.`);
  }

  return lines.join('\n');
}

// ── Formatters v3 ───────────────────────────────────────────────

function formatSearchContext(
  token: string,
  project: string,
  results: LynxSearchResult[],
  estimatedTokens: number,
  confidence: string,
  sessionTokens: number,
  sessionUniqueFiles: number,
  real: ReturnType<typeof computeRealSavings>,
  strict: boolean,
  count: number,
): string {
  const lines: string[] = [];

  if (strict) {
    lines.push(`⚠️ LYNX STRICT: Para evidencia estructural indexada, prueba search_graph("${token}", "${project}").`);
    if (count > 0) {
      lines.push(`Llevas ${count} tools de archivo sin LYNX. Bloqueo a la ${STRICT_THRESHOLD + 1}.`);
    }
    lines.push('');
  }

  lines.push(
    `[LYNX] Graph context for "${token}" in ${project}:`,
    ...results.map((r) => {
      const n = r.node;
      const degree = r.inDegree + r.outDegree;
      return `- ${n.kind} ${n.qualifiedName} (${n.filePath}:${n.startLine}, degree ${degree})`;
    }),
    `Estimated context saved: ~${estimatedTokens.toLocaleString()} tokens (${confidence} confidence).`,
  );

  if (sessionTokens > estimatedTokens) {
    lines.push(
      `Session total: ${sessionTokens.toLocaleString()} tokens saved across ${sessionUniqueFiles} unique files.`
    );
  }

  if (real.filesAvoided > 0) {
    lines.push(
      `[REAL] Session tracking: ${real.filesAvoided} file(s) suggested by LYNX were NEVER read — ~${real.tokensSaved.toLocaleString()} real tokens saved.`
    );
  }

  lines.push(
    'LYNX STRICT: elige la tool de grafo mas pequena que resuelva la pregunta; usa herramientas directas cuando sean la via adecuada.'
  );
  return lines.join('\n');
}

function formatReadWarning(
  filePath: string,
  matchedQuery: string,
  matchedFiles: string[],
  real: ReturnType<typeof computeRealSavings>,
  count: number,
): string {
  const lines = [
    `⚠️ LYNX: \`${filePath}\` fue sugerido por LYNX para "${matchedQuery}".`,
    'Para archivos ya cubiertos por el grafo, considera get_code_snippet o batch_get_code cuando necesites fuente exacta de simbolos conocidos.',
  ];

  if (matchedFiles.length > 0) {
    const otherFiles = matchedFiles.filter((f) => !filePath.endsWith(f.replace(/\\/g, '/')));
    if (otherFiles.length > 0) {
      lines.push(`Archivos relacionados sugeridos: ${otherFiles.join(', ')}`);
    }
  }

  if (real.filesAvoided > 0) {
    lines.push(
      `Ahorro real en esta sesion: ${real.filesAvoided} archivos evitados, ~${real.tokensSaved.toLocaleString()} tokens.`
    );
  }

  if (count > 0) {
    lines.push(`No-LYNX consecutivas: ${count}/${STRICT_THRESHOLD + 1}.`);
  }

  return lines.join('\n');
}
