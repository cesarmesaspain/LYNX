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
}

function genericBlock(): string {
  return [
    START_MARKER,
    '# LYNX MCP — GUIA DE DESCUBRIMIENTO',
    '',
    'Prioriza las herramientas de LYNX cuando la tarea necesite evidencia estructural del codigo.',
    'Las herramientas directas del sistema de archivos siguen siendo validas cuando sean la via mas precisa o eficiente.',
    '',
    'Criterio de seleccion: elige la consulta mas pequena y el conjunto minimo de herramientas que aporten evidencia suficiente;',
    'reutiliza resultados previos y amplia el alcance solo cuando falte evidencia.',
    '',
    '## Protocolo recomendado',
    '1. Usa `pack_context(task)` cuando una tarea amplia necesite contexto coordinado de varios simbolos o archivos.',
    '2. Usa `search_graph` para relaciones estructurales y `get_code_snippet` cuando necesites fuente exacta.',
    '3. Usa `trace_path` cuando necesites evidencia de callers, callees o flujo.',
    '4. Usa `query_graph` para metricas o relaciones cruzadas que el grafo pueda resolver directamente.',
    '5. Usa `batch_get_code` para comparar varios simbolos en una sola llamada.',
    '6. Usa `find_tests` cuando la cobertura sea material para el cambio.',
    '',
    '## Usa grep/Read/Glob cuando sean la via mas directa',
    '- Documentacion, configuracion, JSON, variables de entorno o Dockerfiles.',
    '- Busquedas literales o casos que LYNX no cubra de forma util.',
    '- El proyecto no este indexado o el indice este desactualizado.',
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
    '# LYNX MCP — GUIA DE DESCUBRIMIENTO',
    '',
    'Prioriza LYNX cuando necesites comprender estructura, dependencias o impacto en este proyecto.',
    'Las herramientas de archivos tambien son validas cuando ofrecen evidencia mas directa.',
    '',
    `Proyecto \`${projId}\`: **${stats.nodes.toLocaleString()} nodos**, **${stats.edges.toLocaleString()} aristas**, ${stats.fileCount.toLocaleString()} archivos, ${langLine}.`,
    spotLines,
    '',
    '**Criterio:** elige la consulta mas pequena que resuelva la incertidumbre y reutiliza la evidencia obtenida.',
    '',
    '## Protocolo recomendado',
    `1. Usa \`pack_context(task, "${projId}")\` cuando la tarea requiera contexto amplio y coordinado.`,
    '2. Usa `search_graph` para relaciones y `get_code_snippet` para fuente exacta.',
    '3. Usa `trace_path` cuando necesites callers, callees o flujo.',
    '4. Usa `query_graph` para metricas o relaciones cruzadas.',
    '5. Usa `batch_get_code` para comparar varios simbolos en una sola llamada.',
    '6. Usa `find_tests` cuando la cobertura sea relevante para el cambio.',
    '',
    '## Usa grep/Read/Glob cuando sean la via mas directa',
    '- Documentacion, configuracion, JSON, variables de entorno o Dockerfiles.',
    '- Busquedas literales o casos que LYNX no cubra de forma util.',
    '- El proyecto no este indexado o el indice este desactualizado.',
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

/** Inject or replace the LYNX managed block into a file. */
export function upsertBlock(
  filePath: string,
  block: string,
  dryRun: boolean,
): string {
  const original = readFile(filePath);

  const startIdx = original.indexOf(START_MARKER);
  const endIdx = original.indexOf(END_MARKER);

  let newContent: string;

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block — keep it in its current position
    const before = original.slice(0, startIdx);
    const after = original.slice(endIdx + END_MARKER.length);
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
export function removeBlock(filePath: string, dryRun: boolean): string {
  const original = readFile(filePath);
  const startIdx = original.indexOf(START_MARKER);
  const endIdx = original.indexOf(END_MARKER);

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
  const after = original.slice(endIdx + END_MARKER.length).trimStart();
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

/** Check if a file has a LYNX managed block. */
export function hasBlock(filePath: string): boolean {
  const content = readFile(filePath);
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}
