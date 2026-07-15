/*
 * instructions.ts — Managed markdown blocks for agent instruction files.
 *
 * Injects a "<!-- lynx:start -->" ... "<!-- lynx:end -->" block into
 * CLAUDE.md, AGENTS.md, GEMINI.md, etc.
 *
 * For `lynx init`, the block includes real project stats from the DB.
 * For `lynx install`, the block is generic (agent-level, not project-level).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const START_MARKER = '<!-- lynx:start -->';
const END_MARKER = '<!-- lynx:end -->';
const TOOLS_CATALOG_START = '<!-- lynx-tools:start -->';
const TOOLS_CATALOG_END = '<!-- lynx-tools:end -->';

const TOOLS_BY_CATEGORY: Record<string, string[]> = {
  'Busqueda': ['search_graph', 'semantic_search', 'search_code'],
  'Navegacion': ['trace_path', 'query_graph', 'get_code_snippet', 'batch_get_code', 'get_edge_evidence', 'investigate_symbol'],
  'Analisis': ['explain_symbol', 'smart_review', 'analyze_hotspots', 'find_tests', 'find_dead_code', 'assess_impact'],
  'Contexto': ['pack_context', 'pack_memory', 'get_architecture', 'get_graph_schema'],
  'Gestion': ['index_repository', 'index_status', 'list_projects', 'delete_project', 'diagnose'],
  'Cambios': ['detect_changes', 'compare_runs', 'watch_project'],
  'ADR': ['manage_adr'],
  'Trazas': ['ingest_traces'],
  'Utilidades': ['tool_catalog', 'usage_summary'],
};

function validatePath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const home = os.homedir();
  const rel = path.relative(home, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside home directory: ${filePath}`);
  }
}

// ── Block generation ───────────────────────────────────────────────

export interface ProjectStats {
  projectName: string;
  nodes: number;
  edges: number;
  languages: string[];       // e.g. ["TypeScript", "TSX"]
  topHotspots: string[];     // e.g. ["AdminPage (87)", "OperationsSection (76)"]
  fileCount: number;
  toolCount?: number;        // populated at runtime from TOOLS.length
}

function genericBlock(): string {
  return [
    START_MARKER,
    '# LYNX MCP — REGLA DE PRIORIDAD ABSOLUTA',
    '',
    '**REGLA BLOQUEANTE:** Para cualquier tarea de codigo, tu primera accion debe ser la consulta mas pequena de LYNX que aporte evidencia suficiente. ',
    'No puedes usar Bash, Read, Grep ni Glob antes de haber consultado LYNX. ',
    'El proyecto esta indexado — si no usas LYNX primero, estas perdiendo tokens y tiempo innecesariamente.',
    '',
    '**Excepcion unica:** solo despues de que una consulta LYNX no resuelva la duda, puedes caer a herramientas de archivo.',
    'Tambien puedes usar herramientas de archivo directamente para: configuracion, JSON, .env, Dockerfiles o literales que LYNX no indexa.',
    '',
    '**Criterio:** reutiliza la evidencia ya obtenida y amplia el alcance solo cuando la informacion sea insuficiente. ',
    'Si las herramientas LYNX no aparecen en el catalogo, usa `tool_search` para localizarlas antes de caer en Bash, Read, Grep o Glob.',
    '',
    '## Arranque',
    '1. Si el proyecto no esta indexado o esta desactualizado, ejecuta `index_repository` sin preguntar.',
    '2. No declares que LYNX no esta disponible. Si las tools no aparecen, usa `tool_search` para localizarlas.',
    '3. Si no hay proyecto resuelto, usa `list_projects` para encontrarlo.',
    '',
    '## Herramientas esenciales',
    '- `pack_context(task)` — obligatorio para tareas amplias o multisimbolo.',
    '- `search_graph` + `get_code_snippet` — definiciones y fuente exacta.',
    '- `trace_path` — callers, callees, flujo de datos.',
    '- `query_graph` — metricas, agregaciones, relaciones cruzadas.',
    '- `batch_get_code` — comparar varios simbolos en una sola llamada.',
    '- `find_tests` — cuando la cobertura de tests sea relevante.',
    END_MARKER,
  ].join('\n');
}

function projectStatsBlock(stats: ProjectStats): string {
  const langLine = stats.languages.length > 0
    ? stats.languages.slice(0, 3).join(', ')
    : 'unknown';

  const spotLines = stats.topHotspots.length > 0
    ? `Top hotspots: ${stats.topHotspots.slice(0, 5).join(', ')}.`
    : '';

  const projId = stats.projectName.replace(/[^a-zA-Z0-9_-]/g, '_');

  return [
    START_MARKER,
    '# LYNX MCP — REGLA DE PRIORIDAD ABSOLUTA',
    '',
    `Proyecto \`${projId}\`: **${stats.nodes.toLocaleString()} nodos**, **${stats.edges.toLocaleString()} aristas**, ${stats.fileCount.toLocaleString()} archivos, ${langLine}.`,
    spotLines,
    '',
    '**REGLA BLOQUEANTE:** Para cualquier tarea de codigo, tu primera accion debe ser la consulta mas pequena de LYNX que aporte evidencia suficiente. ',
    'No puedes usar Bash, Read, Grep ni Glob antes de haber consultado LYNX. ',
    'El proyecto esta indexado — si no usas LYNX primero, estas perdiendo tokens y tiempo innecesariamente.',
    '',
    '**Excepcion unica:** solo despues de que una consulta LYNX no resuelva la duda, puedes caer a herramientas de archivo.',
    'Tambien puedes usar herramientas de archivo directamente para: configuracion, JSON, .env, Dockerfiles o literales que LYNX no indexa.',
    '',
    '**Criterio:** reutiliza la evidencia ya obtenida y amplia el alcance solo cuando la informacion sea insuficiente. ',
    'Si las herramientas LYNX no aparecen en el catalogo, usa `tool_search` para localizarlas antes de caer en Bash, Read, Grep o Glob.',
    '',
    '## Arranque',
    '1. Si el proyecto no esta indexado o esta desactualizado, ejecuta `index_repository` sin preguntar.',
    '2. No declares que LYNX no esta disponible. Si las tools no aparecen, usa `tool_search` para localizarlas.',
    `3. Para tareas amplias, \`pack_context(task, "${projId}")\` es obligatorio.`,
    '',
    '## Herramientas esenciales',
    '- `search_graph` + `get_code_snippet` — definiciones y fuente exacta.',
    '- `trace_path` — callers, callees, flujo de datos.',
    '- `query_graph` — metricas, agregaciones, relaciones cruzadas.',
    '- `batch_get_code` — comparar varios simbolos en una sola llamada.',
    '- `find_tests` — cuando la cobertura de tests sea relevante.',
    END_MARKER,
  ].join('\n');
}

// ── Read / write ───────────────────────────────────────────────────

function readFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function writeFile(filePath: string, content: string): void {
  validatePath(filePath);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.copyFileSync(filePath, filePath + '.lynx-bak');
}

// ── Public API ─────────────────────────────────────────────────────

/** Inject or replace a LYNX managed block into a file. */
export function upsertBlock(
  filePath: string,
  block: string,
  dryRun: boolean,
  startMarker: string = START_MARKER,
  endMarker: string = END_MARKER,
): string {
  const original = readFile(filePath);

  const startIdx = original.indexOf(startMarker);
  const endIdx = original.indexOf(endMarker);

  let newContent: string;

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block — keep it in its current position
    const before = original.slice(0, startIdx);
    const after = original.slice(endIdx + endMarker.length);
    const trimmedBefore = before.trimEnd();
    const trimmedAfter = after.trimStart();
    const sepBefore = trimmedBefore.length > 0 ? '\n\n' : '';
    const sepAfter = trimmedAfter.length > 0 ? '\n\n' : '';
    newContent = trimmedBefore + sepBefore + block + sepAfter + trimmedAfter;
  } else {
    // Prepend block at the TOP of the file so it gets first priority in agent context
    const trimmed = original.trimStart();
    if (trimmed.length > 0) {
      newContent = block + '\n\n' + trimmed;
    } else {
      newContent = block + '\n';
    }
  }

  if (dryRun) {
    if (startIdx !== -1 && endIdx !== -1) {
      return `would update lynx block in ${filePath}`;
    }
    return `would add lynx block → ${filePath}`;
  }

  backupFile(filePath);
  writeFile(filePath, newContent);
  if (startIdx !== -1 && endIdx !== -1) {
    return `updated lynx block in ${filePath}`;
  }
  return `added lynx block → ${filePath}`;
}

/** Remove the LYNX managed block from a file. */
export function removeBlock(
  filePath: string,
  dryRun: boolean,
  startMarker: string = START_MARKER,
  endMarker: string = END_MARKER,
): string {
  const original = readFile(filePath);
  const startIdx = original.indexOf(startMarker);
  const endIdx = original.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    return dryRun
      ? `would skip (no lynx block in ${filePath})`
      : 'skipped (no lynx block)';
  }

  if (dryRun) {
    return `would remove lynx block from ${filePath}`;
  }

  backupFile(filePath);
  const before = original.slice(0, startIdx).trimEnd();
  const after = original.slice(endIdx + endMarker.length).trimStart();
  const newContent = before.length > 0 && after.length > 0
    ? before + '\n\n' + after + '\n'
    : before + after + '\n';
  writeFile(filePath, newContent);
  return `removed lynx block from ${filePath}`;
}

/** Generate a generic instruction block for `lynx install`. */
export function installInstructionsBlock(): string {
  return genericBlock();
}

/** Generate a project-specific instruction block for `lynx init`. */
export function initInstructionsBlock(stats: ProjectStats): string {
  return projectStatsBlock(stats);
}

/** Generate the tools catalog managed block. */
export function toolsCatalogBlock(toolCount: number): string {
  const lines = [
    TOOLS_CATALOG_START,
    `## MCP Tools (${toolCount})`,
    '',
  ];
  for (const [category, tools] of Object.entries(TOOLS_BY_CATEGORY)) {
    const toolList = tools.map(t => `\`${t}\``).join(', ');
    lines.push(`**${category}:** ${toolList}`);
    lines.push('');
  }
  lines.push(TOOLS_CATALOG_END);
  return lines.join('\n');
}

/** Check if a file has a LYNX managed block. */
export function hasBlock(
  filePath: string,
  startMarker: string = START_MARKER,
  endMarker: string = END_MARKER,
): boolean {
  const content = readFile(filePath);
  return content.includes(startMarker) && content.includes(endMarker);
}

/** Export markers for use by index.ts. */
export { TOOLS_CATALOG_START, TOOLS_CATALOG_END };
