/*
 * install/index.ts — Orchestration layer for install / init / uninstall.
 *
 * Ties together agent detection, MCP config injection, instruction blocks,
 * and hook installation. All operations support --dry-run and are idempotent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { detectAgents, detectProjectInstructionPaths, getLynxCommand } from './agents.js';
import { writeMcpEntry, removeMcpEntry } from './mcp-config.js';
import {
  upsertBlock,
  removeBlock,
  installInstructionsBlock,
  initInstructionsBlock,
  type ProjectStats,
} from './instructions.js';
import { LynxDatabase } from '../store/database.js';
import { findNearestProject } from '../discovery/project-scanner.js';
import { lynxConfigPath, detectSystemLocale, readLynxConfig, upsertLynxConfig } from '../config/runtime.js';
import { verifyMcpServer } from './mcp-verify.js';
import {
  installAntigravityHooks, installClaudeHooks, installCodexHook, installGeminiHooks,
  removeAntigravityHooks, removeClaudeHooks, removeCodexHook, removeGeminiHooks,
} from './hooks.js';


const HOME = os.homedir();
const LYNX_HOME = path.join(HOME, '.lynx');
const STRICT_THRESHOLD = 4;

// ── Helpers ────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function lynxDiscoveryReminder(): string {
  return [
    'LYNX code discovery guidance:',
    '1. For any analyze, review, explore, or understand-code request, use LYNX before shell/file tools. Start broad work with pack_context(task).',
    '2. If tools are not visible, run tool_search for: lynx pack_context search_graph trace_path get_code_snippet query_graph index_repository.',
    '3. Establish the project with list_projects/index_status; run index_repository automatically if the active project is missing or stale.',
    '4. Use pack_context for broad multi-symbol tasks, search_graph for relationships, trace_path for callers/callees, get_code_snippet for exact source, and query_graph for metrics.',
    '5. Use find_tests when coverage is material to the intended change; use batch_get_code when comparing multiple candidates.',
    '6. Use shell search/read when it is more direct for docs, configs, literals, or when LYNX has no useful result. Reuse evidence and stop when it is sufficient.',
  ].join(' ');
}

// ── Claude Code MCP auto-approval ──────────────────────────────────

/**
 * Locate the `claude` CLI binary.
 *
 * Searches VSCode extension dirs first (most users install via the
 * extension and don't add it to PATH), then falls back to PATH lookup.
 */
function findClaudeBinary(): string | null {
  // 1. VSCode extension installs (multi-version safe)
  const vscodeExtDir = path.join(HOME, '.vscode', 'extensions');
  if (fs.existsSync(vscodeExtDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(vscodeExtDir);
    } catch {
      entries = [];
    }
    const ccEntry = entries
      .filter((e) => e.startsWith('anthropic.claude-code-'))
      .sort()
      .pop(); // latest installed version
    if (ccEntry) {
      const binPath = path.join(vscodeExtDir, ccEntry, 'resources', 'native-binary', 'claude');
      if (fs.existsSync(binPath)) return binPath;
    }
  }

  // 2. CLI installs: npm / homebrew / direct download on PATH
  try {
    const result = execFileSync('which', ['claude'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    /* not on PATH */
  }

  return null;
}

/**
 * Auto-approve the LYNX MCP server by calling `claude mcp add`.
 *
 * Writing to `.mcp.json` alone leaves the server in "pending approval"
 * state for Claude Code.  VSCode extension users may never see the
 * approval prompt, so we eagerly register the server via the CLI which
 * auto-approves it in `.claude.json`.
 */
function claudeAutoApproveMcp(command: string, args: string[], dryRun: boolean): void {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    log('claude binary not found — skip MCP auto-approval (approve manually in Claude Code)');
    return;
  }

  // Claude defaults to `local`, which makes an MCP server disappear as soon
  // as the user opens a different folder in the VS Code extension. LYNX is a
  // cross-project service, so only a user-scoped registration is sufficient.
  const claudeUserConfig = path.join(HOME, '.claude.json');
  try {
    const userConfig = JSON.parse(fs.readFileSync(claudeUserConfig, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    if (userConfig.mcpServers?.lynx) {
      log('lynx MCP already registered for every Claude project (skipped)');
      return;
    }
  } catch {
    /* no user-scoped config yet */
  }

  if (dryRun) {
    log('would auto-approve lynx MCP server via claude mcp add');
    return;
  }

  // Collect env vars the MCP server needs at runtime
  const envFlags: string[] = [];
  for (const key of ['LYNX_DEEPSEEK_KEY', 'LYNX_API_URL', 'LYNX_API_KEY']) {
    const val = process.env[key];
    if (val) envFlags.push('-e', `${key}=${val}`);
  }

  // Remove the old local registration from the install workspace. It is not
  // used as the source of truth, but keeping it would mask this regression.
  try {
    execFileSync(claudeBin, ['mcp', 'remove', '-s', 'local', 'lynx'], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    /* ok */
  }

  try {
    execFileSync(claudeBin, ['mcp', 'add', '-s', 'user', 'lynx', ...envFlags, '--', command, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    log('auto-approved lynx MCP server');
  } catch (err: unknown) {
    const stderr = String((err as any)?.stderr || (err as any)?.message || err || '');
    log(`MCP auto-approval note: ${stderr.slice(0, 120)}`);
    log('(you can approve manually the first time you run Claude Code)');
  }
}

function claudeRemoveMcpApproval(dryRun: boolean): void {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) return;

  if (dryRun) {
    log('would remove lynx from claude mcp registry');
    return;
  }

  try {
    execFileSync(claudeBin, ['mcp', 'remove', 'lynx'], { stdio: 'ignore', timeout: 5_000 });
    log('removed lynx from claude mcp registry');
  } catch {
    /* already gone */
  }
}

// ── Install ────────────────────────────────────────────────────────

export interface InstallOptions {
  dryRun?: boolean;
  planOnly?: boolean;
  autoIndex?: boolean;
  strict?: boolean;
}

export async function runInstall(options: boolean | InstallOptions): Promise<void> {
  const opts: InstallOptions = typeof options === 'boolean' ? { dryRun: options } : options;
  const dryRun = opts.dryRun === true || opts.planOnly === true;
  const planOnly = opts.planOnly === true;
  const autoIndex = opts.autoIndex !== false;
  const strict = opts.strict === true;
  const agents = detectAgents();

  if (agents.length === 0) {
    console.log('No supported coding agents detected.');
    console.log('Supported: Claude Code, Codex CLI, VS Code, Cursor, Zed, Gemini CLI, OpenCode, Antigravity, Aider, KiloCode, OpenClaw, Kiro');
    console.log('Install one of these and re-run: lynx install');
    return;
  }

  const { command, args } = getLynxCommand();

  if (dryRun) {
    console.log(planOnly ? 'PLAN — no files will be modified.\n' : 'DRY RUN — no files will be modified.\n');
  }

  console.log(`LYNX install\n`);
  console.log(`Detected ${agents.length} agent(s): ${agents.map(a => a.label).join(', ')}\n`);
  console.log('Install receipt:');
  console.log(JSON.stringify(buildInstallPlan(agents, command, args, autoIndex), null, 2));

  if (planOnly) {
    console.log('\nPlan complete. Run: lynx install');
    return;
  }

  // Phase 1: MCP config entries
  console.log('MCP config:');
  for (const agent of agents) {
    const result = writeMcpEntry(agent, command, args, dryRun);
    log(result);
  }

  // Phase 1b: auto-approve Claude Code MCP so users don't need to
  // approve manually (especially VSCode extension users who never see
  // the prompt).
  {
    const claudeForMcp = agents.find(a => a.key === 'claude-code');
    if (claudeForMcp?.mcpConfigPath) {
      claudeAutoApproveMcp(command, args, dryRun);
    }
  }

  // Phase 2: Instruction blocks for agents that support them
  console.log('\nInstructions:');
  const block = installInstructionsBlock();
  for (const agent of agents) {
    if (!agent.instructionsPath) {
      log(`${agent.label}: no instruction file needed`);
      continue;
    }
    ensureDir(path.dirname(agent.instructionsPath));
    const result = upsertBlock(agent.instructionsPath, block, dryRun);
    log(result);
  }

  // Phase 3: Hooks
  console.log('\nHooks:');
  const claude = agents.find(a => a.key === 'claude-code');
  if (claude && claude.hooksSupported) {
    installClaudeHooks(command, args, dryRun, strict);
  }
  const codex = agents.find(a => a.key === 'codex');
  if (codex) {
    installCodexHook(codex.configDir, dryRun);
  }
  const gemini = agents.find(a => a.key === 'gemini');
  if (gemini) {
    installGeminiHooks(gemini.configDir, dryRun);
  }
  const antigravity = agents.find(a => a.key === 'antigravity');
  if (antigravity) {
    installAntigravityHooks(antigravity.configDir, dryRun);
  }
  if (!claude && !codex && !gemini && !antigravity) {
    log('no hook-capable agent detected');
  }

  // Phase 4: SKILL.md for Claude Code — always refresh (idempotent, content from skillMarkdown())
  if (claude) {
    const skillDir = path.join(claude.configDir, 'skills', 'lynx');
    const skillPath = path.join(skillDir, 'SKILL.md');
    const newContent = skillMarkdown();
    const existing = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf-8') : '';
    if (existing === newContent) {
      log('SKILL.md already up to date (skipped)');
    } else if (dryRun) {
      log(existing ? `would refresh SKILL.md → ${skillPath}` : `would create SKILL.md → ${skillPath}`);
    } else {
      ensureDir(skillDir);
      fs.writeFileSync(skillPath, newContent);
      log(existing ? `refreshed SKILL.md → ${skillPath}` : `created SKILL.md → ${skillPath}`);
    }
  }

  // Phase 5: Runtime config for safe automatic project discovery.
  console.log('\nRuntime config:');
  // Installation must preserve an explicit user choice to disable the watcher.
  // Fresh installs still inherit the runtime default (true).
  const autoWatch = readLynxConfig().auto_watch;
  if (dryRun) {
    log(`would write ${lynxConfigPath()} (auto_index=${autoIndex}, auto_index_limit=50000, auto_watch=${autoWatch}, auto_dashboard=true)`);
  } else {
    const cfg = upsertLynxConfig({
      auto_index: autoIndex,
      auto_index_limit: 50_000,
      auto_watch: autoWatch,
      auto_dashboard: true,
      locale: detectSystemLocale(),
    });
    log(`wrote ${lynxConfigPath()} (auto_index=${cfg.auto_index}, limit=${cfg.auto_index_limit}, locale=${cfg.locale})`);
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to apply changes.');
  } else {
    console.log('\nMCP runtime verification:');
    const verification = await verifyMcpServer(command, args);
    if (verification.ok) {
      log(`✓ ${verification.discovered}/${verification.expected} tools available`);
      console.log('\nDone. Restart your agent to pick up the changes.');
    } else {
      log(`✗ ${verification.discovered}/${verification.expected} tools available`);
      if (verification.missing.length > 0) log(`missing: ${verification.missing.join(', ')}`);
      if (verification.error) log(`error: ${verification.error}`);
      console.log('\nInstallation wrote the configuration, but MCP verification failed. Run: lynx doctor');
    }
  }
}

function buildInstallPlan(
  agents: ReturnType<typeof detectAgents>,
  command: string,
  args: string[],
  autoIndex: boolean
): Record<string, unknown> {
  return {
    type: 'lynx.install.plan.v1',
    agents_detected: agents.map((a) => a.key),
    agents_selected: agents.map((a) => a.key),
    mcp_configs_planned: agents
      .filter((a) => a.mcpConfigPath != null)
      .map((a) => a.mcpConfigPath),
    instruction_files_planned: agents
      .map((a) => a.instructionsPath)
      .filter((p): p is string => typeof p === 'string'),
    hooks_planned: [
      ...agents.some((a) => a.key === 'claude-code')
        ? [
            { agent: 'claude-code', event: 'SessionStart', blocking: false, command_source: 'lynx-session-start' },
            { agent: 'claude-code', event: 'PreToolUse', matcher: 'Grep|Glob', blocking: false, command_source: 'lynx-code-discovery-augment' },
          ]
        : [],
      ...agents.some((a) => a.key === 'codex')
        ? [{ agent: 'codex', event: 'SessionStart', blocking: false, command_source: 'managed config.toml echo reminder' }]
        : [],
      ...agents.some((a) => a.key === 'gemini')
        ? [
            { agent: 'gemini', event: 'SessionStart', blocking: false, command_source: 'echo reminder' },
            { agent: 'gemini', event: 'BeforeTool', matcher: '', blocking: false, command_source: 'echo reminder' },
          ]
        : [],
      ...agents.some((a) => a.key === 'antigravity')
        ? [{ agent: 'antigravity', event: 'SessionStart', blocking: false, command_source: 'echo reminder' }]
        : [],
    ],
    skill_files_planned: agents.some((a) => a.key === 'claude-code')
      ? [path.join(HOME, '.claude', 'skills', 'lynx', 'SKILL.md')]
      : [],
    runtime_config_planned: {
      file: lynxConfigPath(),
      auto_index: autoIndex,
      auto_index_limit: 50_000,
      auto_watch: readLynxConfig().auto_watch,
      auto_dashboard: true,
    },
    mcp_command: { command, args },
    writes_started: false,
    network_after_install: false,
  };
}

// ── Init ───────────────────────────────────────────────────────────

export function runInit(dryRun: boolean): void {
  if (dryRun) {
    console.log('DRY RUN — no files will be modified.\n');
  }

  console.log('LYNX init\n');

  // Step 1: Detect project
  const cwd = process.cwd();
  const detected = findNearestProject(cwd);
  if (!detected) {
    console.log('No project detected in current directory.');
    console.log('Run inside a project, or use: lynx index /path/to/project');
    return;
  }

  let projectName = detected.name;
  console.log(`Project detected: ${projectName}`);
  console.log(`  Language:  ${detected.language}`);
  if (detected.frameworks.length > 0) {
    console.log(`  Frameworks: ${detected.frameworks.join(', ')}`);
  }

  // Step 2: Check if already indexed
  let dbPath = path.join(LYNX_HOME, 'dbs', `${projectName}.db`);
  let stats: ProjectStats;

  if (!fs.existsSync(dbPath)) {
    const resolved = resolveProjectByNameOrRoot(projectName, detected.rootPath);
    if (resolved) {
      projectName = resolved;
      dbPath = path.join(LYNX_HOME, 'dbs', `${projectName}.db`);
    }
  }

  if (fs.existsSync(dbPath)) {
    console.log(`\nAlready indexed. Reading stats from ${projectName}...`);
    stats = readStats(projectName);
    console.log(`  Nodes: ${stats.nodes.toLocaleString()}, Edges: ${stats.edges.toLocaleString()}, Files: ${stats.fileCount.toLocaleString()}`);
  } else {
    console.log(`\nNot yet indexed (db: ${projectName}.db not found).`);
    console.log(`Index with: lynx index --mode fast --name "${projectName}"`);
    console.log(`(Indexing is not run automatically — it may take 10-30s on large projects.)`);
    return;
  }

  // Step 3: Generate block with real stats and inject into instruction files
  const block = initInstructionsBlock(stats);
  const instructionPaths = detectProjectInstructionPaths(detected.rootPath);

  console.log('\nInstructions:');
  if (instructionPaths.length === 0) {
    console.log('  No CLAUDE.md or AGENTS.md found in project root.');
    console.log('  Create a CLAUDE.md file and re-run lynx init.');
  } else {
    for (const p of instructionPaths) {
      const result = upsertBlock(p, block, dryRun);
      log(result);
    }
  }

  // Step 4: .mcp.json for project-level MCP (VSCode extension needs this)
  console.log('\nMCP config (project-level):');
  const { command, args } = getLynxCommand();
  const projectMcpPath = path.join(detected.rootPath, '.mcp.json');
  const existingMcp = (() => {
    try { return JSON.parse(fs.readFileSync(projectMcpPath, 'utf-8')); } catch { return {}; }
  })();
  const mcpServers = (existingMcp.mcpServers as Record<string, unknown>) || {};

  if (mcpServers['lynx']) {
    log(`lynx entry already present in ${projectMcpPath} (skipped)`);
  } else {
    const newEntry: Record<string, unknown> = { command };
    if (args.length > 0) newEntry.args = args;
    mcpServers['lynx'] = newEntry;
    existingMcp.mcpServers = mcpServers;

    if (dryRun) {
      log(`would add lynx → ${projectMcpPath}`);
    } else {
      const tmp = projectMcpPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(existingMcp, null, 2) + '\n');
      fs.renameSync(tmp, projectMcpPath);
      log(`added lynx → ${projectMcpPath}`);
    }
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to apply changes.');
  } else {
    console.log('\nDone. The project now has .mcp.json + instruction blocks.');
    console.log('Restart your agent to pick up the changes.');
  }
}

// ── Uninstall ──────────────────────────────────────────────────────

export function runUninstall(dryRun: boolean): void {
  const agents = detectAgents();

  if (dryRun) {
    console.log('DRY RUN — no files will be removed.\n');
  }

  console.log('LYNX uninstall\n');
  console.log(`Detected ${agents.length} agent(s): ${agents.map(a => a.label).join(', ')}\n`);

  // Phase 1: Remove MCP entries
  console.log('MCP config:');
  for (const agent of agents) {
    const result = removeMcpEntry(agent, dryRun);
    log(result);
  }
  // Also remove from claude mcp registry (auto-approved entry)
  if (agents.some(a => a.key === 'claude-code')) {
    claudeRemoveMcpApproval(dryRun);
  }

  // Phase 2: Remove instruction blocks
  console.log('\nInstructions:');
  for (const agent of agents) {
    if (!agent.instructionsPath) continue;
    const result = removeBlock(agent.instructionsPath, dryRun);
    log(result);
  }

  // Phase 3: Remove hooks
  console.log('\nHooks:');
  const claude = agents.find(a => a.key === 'claude-code');
  if (claude) {
    removeClaudeHooks(dryRun);
  }
  const codex = agents.find(a => a.key === 'codex');
  if (codex) {
    removeCodexHook(codex.configDir, dryRun);
  }
  const gemini = agents.find(a => a.key === 'gemini');
  if (gemini) {
    removeGeminiHooks(gemini.configDir, dryRun);
  }
  const antigravity = agents.find(a => a.key === 'antigravity');
  if (antigravity) {
    removeAntigravityHooks(antigravity.configDir, dryRun);
  }

  // Phase 4: Remove SKILL.md
  if (claude) {
    const skillPath = path.join(claude.configDir, 'skills', 'lynx', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      if (dryRun) {
        log(`would remove ${skillPath}`);
      } else {
        fs.unlinkSync(skillPath);
        const skillDir = path.dirname(skillPath);
        try { fs.rmdirSync(skillDir); } catch { /* not empty, ok */ }
        log(`removed ${skillPath}`);
      }
    }
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to remove files.');
  } else {
    console.log('\nDone. LYNX has been removed from agent configs.');
    console.log('Your indexed projects remain in ~/.lynx/dbs/');
  }
}

// ── SKILL.md content ───────────────────────────────────────────────

function skillMarkdown(): string {
  return [
    '---',
    'name: lynx',
    'description: LYNX MCP code intelligence — semantic search, dependency tracing, and code review for this project.',
    '---',
    '',
    '# LYNX -- GUIA DE DESCUBRIMIENTO PROPORCIONAL',
    '',
    'Para analizar, revisar, explorar o comprender codigo, usa LYNX como primera accion; no enumeres ni leas archivos locales antes.',
    'Usa herramientas directas de archivos solo despues de LYNX o para configuracion, documentacion y literales concretos.',
    '',
    'Criterio: elige la consulta mas pequena y el conjunto minimo de herramientas que aporten evidencia suficiente.',
    'Reutiliza resultados previos y amplia el alcance solo cuando falte evidencia.',
    '',
    '## Disponibilidad global',
    'LYNX es global: no depende de la carpeta abierta. No concluyas que no esta disponible solo porque sus tools no aparezcan inicialmente.',
    'Antes de usar un fallback local, busca/carga las tools MCP bajo demanda con `tool_search` para `lynx pack_context search_graph trace_path get_code_snippet query_graph index_status`.',
    'En tareas amplias, ejecuta primero `pack_context(task)`. Si no hay proyecto resuelto, usa `list_projects` y selecciona el que coincide con la carpeta activa; despues consulta `index_status`.',
    'Si falta o esta desactualizado, ejecuta `index_repository` para el indice local sin pedir al usuario. Falta de indice no equivale a falta de LYNX.',
    '',
    '## Herramientas segun la necesidad',
    '',
    '| Tool | Uso recomendado |',
    '|----|------------|',
    '| pack_context | tareas amplias que abarcan varios simbolos o archivos |',
    '| search_graph | relaciones estructurales y candidatos |',
    '| get_code_snippet | fuente exacta de funciones o clases |',
    '| batch_get_code | comparar varios simbolos conocidos |',
    '| trace_path | callers, callees y flujo cuando sean relevantes |',
    '| query_graph | metricas y relaciones cruzadas |',
    '| find_tests | cobertura material para el cambio previsto |',
    '| semantic_search | busqueda conceptual en lenguaje natural |',
    '| explain_symbol | analisis profundo de un simbolo |',
    '| smart_review | revision automatizada cuando aporte valor |',
    '| search_code | busqueda textual enriquecida con grafo |',
    '',
    '## Eficiencia',
    '',
    '1. Usa batch_get_code cuando ya conozcas varios qualified_names que debas comparar.',
    '2. Usa find_tests cuando la cobertura pueda cambiar la implementacion o la verificacion.',
    '3. Detente cuando la evidencia sea suficiente para responder o actuar con seguridad.',
    '',
    '## Usa grep/Read/Glob cuando sean la via mas directa',
    '- Documentacion, configuracion, JSON, variables de entorno o Dockerfiles.',
    '- Busquedas literales o casos que LYNX no cubra de forma util.',
    '- Proyecto no indexado o indice desactualizado.',
  ].join('\n');
}

// ── Project name resolution ────────────────────────────────────────

function resolveProjectByNameOrRoot(projectName: string, rootPath: string): string | null {
  const dbsDir = path.join(LYNX_HOME, 'dbs');
  if (!fs.existsSync(dbsDir)) return null;

  const candidates = fs.readdirSync(dbsDir).filter(f => f.endsWith('.db'));

  for (const file of candidates) {
    const candidateName = file.replace(/\.db$/, '');
    if (candidateName !== projectName) continue;
    try {
      const db = LynxDatabase.openProject(candidateName);
      try {
        const row = db.db.prepare(
          'SELECT root_path FROM projects WHERE name = ?'
        ).get(candidateName) as { root_path: string } | undefined;
        if (row && row.root_path === rootPath) {
          return candidateName;
        }
      } finally {
        db.close();
      }
    } catch { /* skip */ }
  }

  let bestName: string | null = null;
  let bestCount = 0;
  for (const file of candidates) {
    const candidateName = file.replace(/\.db$/, '');
    try {
      const db = LynxDatabase.openProject(candidateName);
      try {
        const row = db.db.prepare(
          'SELECT root_path FROM projects WHERE name = ?'
        ).get(candidateName) as { root_path: string } | undefined;
        if (!row || row.root_path !== rootPath) continue;

        const cnt = (db.db.prepare(
          'SELECT COUNT(*) as cnt FROM nodes WHERE project = ?'
        ).get(candidateName) as { cnt: number } | undefined)?.cnt ?? 0;

        if (cnt > bestCount) {
          bestCount = cnt;
          bestName = candidateName;
        }
      } finally {
        db.close();
      }
    } catch { /* skip */ }
  }
  return bestName;
}

// ── Stats reader (for init) ────────────────────────────────────────

function readStats(projectName: string): ProjectStats {
  const db = LynxDatabase.openProject(projectName);
  try {
    const nodeCount = (db.db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE project = ?'
    ).get(projectName) as { cnt: number } | undefined)?.cnt ?? 0;

    const edgeCount = (db.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE project = ?'
    ).get(projectName) as { cnt: number } | undefined)?.cnt ?? 0;

    const fileCount = (db.db.prepare(
      "SELECT COUNT(DISTINCT file_path) as cnt FROM nodes WHERE project = ?"
    ).get(projectName) as { cnt: number } | undefined)?.cnt ?? 0;

    const extRows = db.db.prepare(
      "SELECT DISTINCT file_path FROM nodes WHERE project = ?"
    ).all(projectName) as Array<{ file_path: string }>;

    const extCounts = new Map<string, number>();
    for (const r of extRows) {
      const ext = r.file_path.split('.').pop()?.toLowerCase() || '';
      if (ext && ext.length <= 10) {
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
    }
    const sortedExts = [...extCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext]) => ext);
    const languages = sortedExts.length > 0 ? sortedExts : ['unknown'];

    const hotspotRows = db.db.prepare(
      "SELECT name, properties FROM nodes WHERE project = ? AND kind IN ('Function', 'Method') AND properties IS NOT NULL AND properties != '{}' LIMIT 200"
    ).all(projectName) as Array<{ name: string; properties: string }>;

    const withComplexity: Array<{ name: string; complexity: number }> = [];
    for (const r of hotspotRows) {
      try {
        const props = JSON.parse(r.properties) as Record<string, unknown>;
        const c = typeof props.complexity === 'number' ? props.complexity : 0;
        if (c > 0) withComplexity.push({ name: r.name, complexity: c });
      } catch { /* skip malformed JSON */ }
    }
    withComplexity.sort((a, b) => b.complexity - a.complexity);
    const topHotspots = withComplexity.slice(0, 5).map(r => `${r.name} (${r.complexity})`);

    return { projectName, nodes: nodeCount, edges: edgeCount, languages, topHotspots, fileCount };
  } finally {
    db.close();
  }
}
