/*
 * prompts.ts — Prompt templates for each LLM task.
 *
 * All prompts are in Spanish (LYNX's target language).
 * Designed to be short and token-efficient for DeepSeek V4 Flash.
 */

import type { LynxNode } from '../types.js';

// ── Summarize module ────────────────────────────────────────

export function summarizeModulePrompt(
  source: string,
  relPath: string,
  language: string,
  exports: string[]
): string {
  const header = source.slice(0, Math.min(source.length, 2000));
  const exportsList = exports.length > 0
    ? `Exporta: ${exports.slice(0, 10).join(', ')}.`
    : 'No tiene exports.';
  return `Archivo: ${relPath} (${language})\n${exportsList}\n\n${header}\n\nResume en UNA frase en español qué hace este archivo. Solo la frase, sin prefacios.`;
}

// ── Detect entry point ───────────────────────────────────────

export function detectEntryPointPrompt(
  source: string,
  relPath: string,
  nodes: LynxNode[]
): string {
  const header = source.slice(0, Math.min(source.length, 1500));
  const funcs = nodes
    .filter(n => n.kind === 'Function' || n.kind === 'Method')
    .map(n => n.name)
    .slice(0, 10);
  const funcList = funcs.length > 0 ? `Funciones: ${funcs.join(', ')}.` : '';
  return `Archivo: ${relPath}\n${funcList}\n\n${header}\n\n¿Es este archivo un punto de entrada (API endpoint, CLI command, event handler, cron job, queue worker)? Responde solo "si" o "no", seguido de una razón corta en español. Formato: "si|no: razón"`;
}

// ── Detect test file ─────────────────────────────────────────

export function detectTestPrompt(
  source: string,
  relPath: string
): string {
  const header = source.slice(0, Math.min(source.length, 1200));
  return `Archivo: ${relPath}\n\n${header}\n\n¿Es este archivo un test? Responde solo "si" o "no". Formato: "si|no: razón"`;
}

// ── Classify code smell ──────────────────────────────────────

export function classifyCodeSmellPrompt(
  funcSource: string,
  funcName: string,
  metrics: { cyclomatic: number; lineCount: number; loopDepth: number }
): string {
  return `Función: ${funcName}\nComplejidad: ${metrics.cyclomatic}, Líneas: ${metrics.lineCount}, Loop depth: ${metrics.loopDepth}\n\n${funcSource.slice(0, 1500)}\n\nClasifica esta función: "tech_debt", "over_engineered", "complex_but_necessary", o "fine". Solo la clasificación y una razón corta en español.`;
}

// ── Assess change risk ───────────────────────────────────────

export function assessChangeRiskPrompt(
  funcName: string,
  funcSource: string,
  callers: string[],
  fanIn: number,
  changeDescription: string
): string {
  const callerList = callers.slice(0, 10).join(', ');
  const sourceSnippet = funcSource.slice(0, 1500);
  return `Función modificada: ${funcName}
Callers directos: ${fanIn} (${callerList || 'ninguno conocido'})

CAMBIO REALIZADO:
${changeDescription.slice(0, 1000)}

Código actual de la función:
\`\`\`
${sourceSnippet}
\`\`\`

Evalúa el riesgo de este cambio considerando: ¿rompe la firma? ¿cambia el contrato de salida? ¿introduce nueva superficie de fallo (red, archivos, APIs externas)? ¿es solo un refactor interno seguro?

Responde EXACTAMENTE en este formato (dos líneas):
RISK: critical|high|medium|low
WHY: razón en español (una frase)`;}

// ── Re-rank search results ────────────────────────────────────

export function reRankSearchPrompt(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): string {
  const items = candidates.map(c =>
    `[${c.index}] ${c.kind}: ${c.name}\n   ${c.snippet.slice(0, 150)}`
  ).join('\n');
  return `Query: "${query}"\n\nCandidatos:\n${items}\n\nReordena los índices del más relevante al menos relevante para la query. Responde solo con los números separados por comas. Ejemplo: "3,1,5,2,4,0"`;
}
