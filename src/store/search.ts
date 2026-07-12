/*
 * search.ts — Graph-augmented code search.
 *
 * BM25-style relevance ranking with structural boosting:
 * Functions/Methods +10, Routes +8, Classes/Interfaces +5.
 * Falls back to LIKE-based text search for patterns when no FTS index exists.
 */

import type { LynxDatabase } from './database.js';
import type { LynxSearchParams, LynxSearchResult, LynxNodeKind } from '../types.js';

const STRUCTURAL_BOOST: Record<string, number> = {
  Function: 10,
  Method: 10,
  Route: 8,
  Class: 5,
  Interface: 5,
  Type: 3,
  Enum: 3,
  Variable: 1,
  File: 0,
  Module: 0,
  Folder: 0,
};

const QUERY_STOPWORDS = new Set([
  'a', 'al', 'algo', 'como', 'con', 'cual', 'cuando', 'de', 'del', 'donde',
  'el', 'en', 'es', 'esa', 'ese', 'esta', 'este', 'la', 'las', 'lo', 'los',
  'para', 'por', 'que', 'quien', 'se', 'su', 'sus', 'un', 'una', 'y', 'o',
  'how', 'what', 'where', 'who', 'when', 'the', 'is', 'are', 'to', 'of',
  'in', 'on', 'for', 'with', 'and', 'or',
]);

interface RawRow {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  is_exported: number;
  is_test: number;
  is_entry_point: number;
  in_degree: number;
  out_degree: number;
}

/**
 * Convert a regex-like pattern to a SQL LIKE pattern.
 * Uses placeholders so regex metacharacters are converted to LIKE wildcards
 * while literal underscores/percent signs that happen to be LIKE metacharacters
 * get escaped.
 *
 * Examples:
 *   extract_.*   → extract\_%
 *   handle\w+    → handle_%
 *   ^main$       → main
 *   \.\*test     → %test
 */
function regexToLike(pattern: string): string {
  const ANY = '\x00';  // placeholder for %
  const ONE = '\x01';  // placeholder for _

  let like = pattern
    // Strip regex anchors
    .replace(/^\^/, '').replace(/\$$/, '')
    // Escaped regex sequences: \.\* or \.\+ → any sequence
    .replace(/\\\.\\\*/g, ANY)
    .replace(/\\\.\\\+/g, ANY)
    // Unescaped regex sequences: .* or .+ → any sequence
    .replace(/\.\*/g, ANY)
    .replace(/\.\+/g, ANY)
    // Escaped dot \. → literal dot
    .replace(/\\\./g, '.')
    // \d+ or \w+ → single char + any sequence
    .replace(/\\d\+/g, ONE + ANY)
    .replace(/\\w\+/g, ONE + ANY)
    // Unescaped . → single char wildcard
    .replace(/\./g, ONE)
    // \d or \w → single char wildcard
    .replace(/\\d/g, ONE)
    .replace(/\\w/g, ONE);

  // Escape LIKE metacharacters that are literal in the original regex
  like = like.replace(/_/g, '\\_').replace(/%/g, '\\%');

  // Replace placeholders with actual LIKE wildcards
  like = like.replace(/\x00/g, '%').replace(/\x01/g, '_');

  // If no LIKE wildcards remain, wrap in %...% for substring match
  if (!/[%_]/.test(like)) like = `%${like}%`;

  return like;
}

export function search(db: LynxDatabase, params: LynxSearchParams): {
  results: LynxSearchResult[];
  total: number;
} {
  const conditions: string[] = ['n.project = ?'];
  const bindings: (string | number)[] = [params.project];

  if (params.label) {
    conditions.push('n.kind = ?');
    bindings.push(params.label);
  }

  if (params.namePattern) {
    const like = regexToLike(params.namePattern);
    conditions.push("n.name LIKE ? ESCAPE '\\'");
    bindings.push(like);
  }

  if (params.qnPattern) {
    const like = regexToLike(params.qnPattern);
    conditions.push("n.qualified_name LIKE ? ESCAPE '\\'");
    bindings.push(like);
  }

  if (params.filePattern) {
    // Convert glob to LIKE
    const like = params.filePattern.replace(/\*/g, '%').replace(/\?/g, '_');
    conditions.push("n.file_path LIKE ? ESCAPE '\\'");
    bindings.push(`%${like}%`);
  }

  if (params.minDegree !== undefined && params.minDegree >= 0) {
    conditions.push(
      `(SELECT COUNT(*) FROM edges e2 WHERE e2.source_id = n.id OR e2.target_id = n.id) >= ?`
    );
    bindings.push(params.minDegree);
  }

  if (params.excludeEntryPoints) {
    conditions.push('n.is_entry_point = 0');
  }

  if (params.textSearchTokens && params.textSearchTokens.length > 0) {
    const tokenClauses = params.textSearchTokens.map(() =>
      '(LOWER(n.name) LIKE ? OR LOWER(n.qualified_name) LIKE ?)'
    );
    conditions.push(`(${tokenClauses.join(' OR ')})`);
    for (const token of params.textSearchTokens) {
      bindings.push(`%${token.toLowerCase()}%`, `%${token.toLowerCase()}%`);
    }
  }

  if (params.relationship) {
    conditions.push(
      `EXISTS (SELECT 1 FROM edges e2 WHERE (e2.source_id = n.id OR e2.target_id = n.id) AND e2.type = ?)`
    );
    bindings.push(params.relationship);
  }

  const whereClause = conditions.join(' AND ');

  // Count total
  const countRow = db.db
    .prepare(`SELECT COUNT(*) as cnt FROM nodes n WHERE ${whereClause}`)
    .get(...bindings) as { cnt: number };

  // Query with degree subqueries
  let orderClause: string;
  switch (params.sortBy) {
    case 'name':
      orderClause = 'n.name ASC';
      break;
    case 'degree':
      orderClause = '(in_deg + out_deg) DESC';
      break;
    default: // relevance — boost by kind
      orderClause = 'boost DESC, n.name ASC';
  }

  const boostExpr = Object.entries(STRUCTURAL_BOOST)
    .map(([kind, boost]) => `WHEN '${kind}' THEN ${boost}`)
    .join(' ');
  const boostCase = `CASE n.kind ${boostExpr} ELSE 0 END`;

  const limit = Math.min(params.limit || 10, 200);
  const offset = params.offset || 0;

  const rows = db.db
    .prepare(
      `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line,
              n.is_exported, n.is_test, n.is_entry_point,
              (SELECT COUNT(*) FROM edges e2 WHERE e2.target_id = n.id) as in_degree,
              (SELECT COUNT(*) FROM edges e2 WHERE e2.source_id = n.id) as out_degree,
              ${boostCase} as boost
       FROM nodes n
       WHERE ${whereClause}
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(...bindings, limit, offset) as RawRow[];

  // Filter noise labels (Folder, Module, File) unless explicitly requested
  const noiseLabels: LynxNodeKind[] = ['Folder', 'Module'];
  const filtered = params.label
    ? rows
    : rows.filter((r) => !noiseLabels.includes(r.kind as LynxNodeKind));

  const results: LynxSearchResult[] = filtered.map((r) => ({
    node: {
      id: r.id,
      project: params.project,
      kind: r.kind as LynxNodeKind,
      name: r.name,
      qualifiedName: r.qualified_name,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      isExported: r.is_exported === 1,
      isTest: r.is_test === 1,
      isEntryPoint: r.is_entry_point === 1,
    },
    inDegree: r.in_degree,
    outDegree: r.out_degree,
    score: STRUCTURAL_BOOST[r.kind] ?? 0,
    tokenScore: 0,
  }));

  return { results, total: countRow.cnt };
}

// ── Full-text search (BM25-like token matching) ─────────────────

export function searchFullText(
  db: LynxDatabase,
  project: string,
  query: string,
  limit = 10
): LynxSearchResult[] {
  // Tokenize query: split on whitespace + camelCase
  const tokens = expandQuery(query);
  if (tokens.length === 0) return [];

  // Build a scoring query: each matched token adds weighted points.
  const likeClauses = tokens.map(() => `(LOWER(n.name) LIKE ? OR LOWER(n.qualified_name) LIKE ? OR LOWER(n.file_path) LIKE ?)`);
  const tokenScore = tokens
    .map(
      () =>
        `(CASE WHEN LOWER(n.name) LIKE ? THEN 8 ELSE 0 END +
          CASE WHEN LOWER(n.qualified_name) LIKE ? THEN 4 ELSE 0 END +
          CASE WHEN LOWER(n.file_path) LIKE ? THEN 3 ELSE 0 END)`
    )
    .join(' + ');
  const whereClause = `n.project = ? AND n.kind NOT IN ('Folder', 'Module') AND (${likeClauses.join(' OR ')})`;

  const whereBindings: (string | number)[] = [project];
  for (const token of tokens) {
    whereBindings.push(`%${token}%`, `%${token}%`, `%${token}%`);
  }
  const scoreBindings: (string | number)[] = [];
  for (const token of tokens) {
    scoreBindings.push(`%${token}%`, `%${token}%`, `%${token}%`);
  }
  const rows = db.db
    .prepare(
      `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line,
              n.is_exported, n.is_test, n.is_entry_point,
              (SELECT COUNT(*) FROM edges e2 WHERE e2.target_id = n.id) as in_degree,
              (SELECT COUNT(*) FROM edges e2 WHERE e2.source_id = n.id) as out_degree,
              (${tokenScore}) as token_score,
              (CASE n.kind WHEN 'Function' THEN 10 WHEN 'Method' THEN 10 WHEN 'Route' THEN 8
                           WHEN 'Class' THEN 5 WHEN 'Interface' THEN 5 WHEN 'Type' THEN 3
                           WHEN 'Enum' THEN 3 ELSE 0 END) as structural_boost
       FROM nodes n
       WHERE ${whereClause}
       ORDER BY (token_score + structural_boost) DESC,
                (in_degree + out_degree) DESC,
                n.name ASC
       LIMIT ?`
    )
    .all(...scoreBindings, ...whereBindings, limit) as RawRow[];

  return rows.map((r) => ({
    node: {
      id: r.id,
      project,
      kind: r.kind as LynxNodeKind,
      name: r.name,
      qualifiedName: r.qualified_name,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      isExported: r.is_exported === 1,
      isTest: r.is_test === 1,
      isEntryPoint: r.is_entry_point === 1,
    },
    inDegree: r.in_degree,
    outDegree: r.out_degree,
    score: STRUCTURAL_BOOST[r.kind] ?? 0,
    tokenScore: (r as unknown as Record<string, unknown>).token_score as number,
  }));
}

// ── Spanish-English bilingual synonym dictionary ─────────────
// Maps Spanish terms to their common English code equivalents so
// "buscar usuario" finds findUser/getUser/fetchUser even though the
// Search is English-only. Also includes English synonym groups.

const ES_TO_EN: Record<string, string[]> = {
  // Auth / session
  autenticar: ['authenticate', 'auth', 'login', 'signin'],
  autenticacion: ['auth', 'authentication', 'login'],
  sesion: ['session', 'login', 'auth'],
  credenciales: ['credentials', 'password', 'secret'],
  contraseña: ['password', 'passphrase', 'secret', 'pwd'],
  token: ['token', 'jwt', 'bearer'],
  permiso: ['permission', 'role', 'acl', 'authorize'],
  rol: ['role', 'permission', 'access'],
  // CRUD
  buscar: ['find', 'search', 'query', 'lookup', 'get'],
  crear: ['create', 'new', 'add', 'insert', 'make', 'build'],
  actualizar: ['update', 'edit', 'modify', 'patch', 'set'],
  eliminar: ['delete', 'remove', 'destroy', 'drop', 'clear'],
  listar: ['list', 'findAll', 'getAll', 'fetch', 'query'],
  obtener: ['get', 'fetch', 'retrieve', 'find', 'read'],
  guardar: ['save', 'persist', 'store', 'write', 'commit'],
  // Actions
  enviar: ['send', 'email', 'dispatch', 'post', 'submit'],
  validar: ['validate', 'validation', 'check', 'verify', 'assert', 'test'],
  valida: ['validate', 'validation', 'check', 'verify'],
  validacion: ['validate', 'validation', 'check', 'verify', 'audit'],
  calcular: ['calculate', 'compute', 'evaluate', 'process', 'run'],
  procesar: ['process', 'handle', 'execute', 'run', 'apply'],
  configurar: ['configure', 'config', 'configuration', 'setup', 'settings', 'init'],
  configuracion: ['config', 'configuration', 'settings', 'runtime', 'policy'],
  ajustes: ['settings', 'config', 'configuration', 'preferences'],
  notificar: ['notify', 'alert', 'send', 'email', 'push'],
  exportar: ['export', 'download', 'generate', 'render'],
  importar: ['import', 'upload', 'parse', 'load'],
  gestionar: ['manage', 'handle', 'control', 'admin'],
  generar: ['generate', 'create', 'build', 'produce', 'render'],
  asignar: ['assign', 'set', 'allocate', 'put'],
  cancelar: ['cancel', 'abort', 'stop', 'reject'],
  // Entities
  usuario: ['user', 'account', 'profile', 'member'],
  cliente: ['client', 'customer', 'lead', 'contact', 'account'],
  caso: ['case', 'lead', 'ticket', 'incident', 'issue'],
  propuesta: ['proposal', 'quote', 'budget', 'offer', 'estimate'],
  pago: ['payment', 'pay', 'transaction', 'billing', 'invoice'],
  factura: ['invoice', 'bill', 'receipt', 'payment'],
  producto: ['product', 'item', 'sku', 'good'],
  pedido: ['order', 'request', 'purchase', 'cart'],
  archivo: ['file', 'document', 'attachment', 'upload'],
  imagen: ['image', 'photo', 'picture', 'media', 'file'],
  mensaje: ['message', 'msg', 'chat', 'text', 'notification'],
  plantilla: ['template', 'layout', 'pattern', 'boilerplate'],
  escenario: ['scenario', 'flow', 'workflow', 'runtime', 'pipeline', 'case'],
  escenarios: ['scenario', 'scenarios', 'flow', 'workflow', 'runtime', 'pipeline'],
  runtime: ['runtime', 'scenarioRuntime', 'execution', 'executor', 'run'],
  flujo: ['flow', 'workflow', 'scenario', 'runtime'],
  flujos: ['flow', 'workflow', 'scenario', 'runtime'],
  director: ['director', 'manager', 'orchestrator', 'controller'],
  especialista: ['specialist', 'expert', 'worker'],
  agente: ['agent', 'agents', 'opsAgent', 'routingAgent', 'specialist'],
  agentes: ['agent', 'agents', 'opsAgent', 'routingAgent', 'specialist'],
  programa: ['schedule', 'plan', 'calendar', 'timeline'],
  // Status
  pendiente: ['pending', 'waiting', 'queued', 'scheduled'],
  completado: ['completed', 'done', 'finished', 'success'],
  error: ['error', 'fail', 'failure', 'exception', 'fault'],
  // Misc
  resumen: ['summary', 'resume', 'overview', 'abstract'],
  informe: ['report', 'analysis', 'audit', 'review'],
  estadistica: ['stats', 'statistics', 'metrics', 'analytics'],
  auditoria: ['audit', 'review', 'check', 'inspection'],
  presupuesto: ['budget', 'estimate', 'quote', 'cost'],
  contrato: ['contract', 'agreement', 'deal', 'terms'],
  comercial: ['commercial', 'sales', 'business', 'marketing'],
  config: ['config', 'configuration', 'settings', 'runtime', 'policy'],
  settings: ['settings', 'config', 'configuration', 'preferences'],
  agent: ['agent', 'agents', 'routingAgent', 'opsAgent', 'specialist'],
  validate: ['validate', 'validation', 'check', 'verify', 'audit'],
  tecnico: ['technical', 'tech', 'engineering'],
  salud: ['health', 'status', 'wellness'],
  // English synonym groups (existing + expanded)
  send: ['send', 'email', 'mail', 'resend', 'deliver', 'dispatch'],
  sent: ['sent', 'email', 'mail', 'resend'],
  email: ['email', 'mail', 'resend', 'smtp', 'send'],
  client: ['client', 'customer', 'lead', 'contact', 'account'],
  customer: ['customer', 'client', 'lead', 'contact', 'account'],
  approve: ['approve', 'approval', 'approved', 'accept', 'confirm'],
  approved: ['approved', 'approval', 'approve', 'accepted', 'confirmed'],
  proposal: ['proposal', 'propuesta', 'quote', 'budget', 'offer'],
  task: ['task', 'work', 'job', 'todo', 'action'],
  case: ['case', 'lead', 'ticket', 'incident', 'customer'],
  schedule: ['schedule', 'plan', 'calendar', 'cron', 'timer'],
};

const ES_ROOTS_TO_EN: Array<[string, string[]]> = [
  ['aprob', ['approve', 'approved', 'approval', 'accepted', 'confirm']],
  ['envi', ['send', 'email', 'mail', 'dispatch', 'deliver']],
  ['configur', ['config', 'configuration', 'settings', 'runtime', 'policy']],
  ['guard', ['save', 'persist', 'store', 'write', 'commit']],
  ['valid', ['validate', 'validation', 'check', 'verify', 'audit']],
  ['escenar', ['scenario', 'scenarios', 'flow', 'workflow', 'runtime']],
  ['recuper', ['recover', 'recovery', 'retry', 'restore']],
  ['pend', ['pending', 'queued', 'waiting']],
  ['fall', ['failed', 'failure', 'error']],
  ['client', ['client', 'customer', 'lead', 'contact', 'account']],
  ['agent', ['agent', 'agents', 'opsAgent', 'routingAgent', 'specialist']],
];

/** Light Spanish stemming — remove common suffixes to match root forms. */
function stemSpanish(word: string): string[] {
  const stems: string[] = [word];
  // Noun plurals
  if (word.endsWith('es')) stems.push(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) stems.push(word.slice(0, -1));
  // Verb conjugations
  for (const suffix of ['ando', 'iendo', 'aron', 'ieron', 'aban', 'ían', 'ará', 'erá', 'iré']) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      stems.push(word.slice(0, -suffix.length) + 'ar');
      stems.push(word.slice(0, -suffix.length) + 'er');
      stems.push(word.slice(0, -suffix.length) + 'ir');
    }
  }
  // Adjective/noun suffixes
  for (const suffix of ['ción', 'sión', 'dad', 'miento', 'mente', 'able', 'ible']) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      stems.push(word.slice(0, -suffix.length));
    }
  }
  for (const suffix of ['ados', 'adas', 'ido', 'ida', 'idos', 'idas', 'ado', 'ada']) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      stems.push(word.slice(0, -suffix.length));
    }
  }
  return [...new Set(stems)];
}

function normalizeSpanish(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U');
}

export function expandTokens(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const raw of tokens) {
    const token = normalizeSpanish(raw);
    if (QUERY_STOPWORDS.has(token)) continue;
    // 1. Direct token
    if (token.length >= 2 && !expanded.includes(token)) expanded.push(token);
    // 2. English synonyms
    for (const syn of ES_TO_EN[token] || []) {
      if (!expanded.includes(syn)) expanded.push(syn);
    }
    // 3. Spanish stems → map each stem through dictionary
    for (const stem of stemSpanish(token)) {
      if (stem !== token && !expanded.includes(stem)) expanded.push(stem);
      for (const syn of ES_TO_EN[stem] || []) {
        if (!expanded.includes(syn)) expanded.push(syn);
      }
      for (const [root, synonyms] of ES_ROOTS_TO_EN) {
        if (stem.startsWith(root)) {
          for (const syn of synonyms) {
            if (!expanded.includes(syn)) expanded.push(syn);
          }
        }
      }
    }
  }
  return expanded.slice(0, 36);
}

export function expandQuery(query: string): string[] {
  const tokens = expandTokens(tokenize(query));
  for (const term of inferIntentTerms(query)) {
    if (!tokens.includes(term)) tokens.push(term);
  }
  return tokens.slice(0, 48);
}

function inferIntentTerms(query: string): string[] {
  const q = normalizeSpanish(query.toLowerCase());
  const terms: string[] = [];

  const add = (...items: string[]) => {
    for (const item of items) {
      if (!terms.includes(item)) terms.push(item);
    }
  };

  if (hasAll(q, ['configuracion', 'agente']) || hasAll(q, ['ajustes', 'agente'])) {
    add('agent', 'agents', 'opsAgent', 'runtimeConfig', 'config', 'settings', 'policy', 'route');
  }
  if (hasAll(q, ['runtime', 'escenario']) || hasAll(q, ['valid', 'runtime']) || hasAll(q, ['escenario', 'valid'])) {
    add('scenarioRuntime', 'runtime', 'validate', 'validation', 'nodeRegistry', 'nodeHandlers', 'flowSimulation');
  }
  if (hasAny(q, ['email', 'correo', 'mail']) && hasAny(q, ['aprob', 'cliente', 'enviar'])) {
    add('email', 'send', 'approved', 'approval', 'client', 'customer', 'smtp', 'resend');
  }
  if (hasAny(q, ['propuesta', 'presupuesto']) && hasAny(q, ['aprob', 'comercial'])) {
    add('proposal', 'approval', 'commercial', 'budget', 'quote', 'accepted');
  }
  if (hasAny(q, ['pendiente', 'fallido', 'recuper'])) {
    add('recover', 'pending', 'workResult', 'directorWorkRecovery', 'retry', 'failed');
  }

  return terms;
}

function hasAll(text: string, needles: string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  // Split on whitespace, underscores, hyphens, dots
  const parts = query.split(/[\s_\-.:/\\]+/);
  for (const part of parts) {
    if (part.length === 0) continue;
    const lower = part.toLowerCase();
    const normalized = normalizeSpanish(lower);
    if (QUERY_STOPWORDS.has(normalized)) continue;
    // Split camelCase
    const camelTokens = lower.split(/(?=[A-Z])/).filter((t) => t.length > 0);
    for (const ct of camelTokens) {
      const normalizedCamel = normalizeSpanish(ct);
      if (ct.length >= 2 && !QUERY_STOPWORDS.has(normalizedCamel) && !tokens.includes(ct)) {
        tokens.push(ct);
      }
    }
    // Also add the full part as-is (for compound words)
    if (lower.length >= 2 && !QUERY_STOPWORDS.has(normalized) && !tokens.includes(lower)) tokens.push(lower);
  }
  return tokens;
}
