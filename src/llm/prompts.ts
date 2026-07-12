/*
 * prompts.ts — Prompt templates for each LLM task.
 *
 * All prompts are locale-aware (en/es) via the locale parameter.
 * Designed to be short and token-efficient for DeepSeek V4 Flash.
 */

import type { LynxNode } from '../types.js';
import { readLynxConfig } from '../config/runtime.js';
import { getPricingConfig } from '../config/runtime.js';

type Locale = 'es' | 'en';

function localeLabels(locale: Locale) {
  if (locale === 'en') {
    return {
      file: 'File',
      functions: 'Functions',
      exports: 'Exports',
      noExports: 'No exports.',
      summarizeInstruction: 'Summarize in ONE English sentence what this file does. Just the sentence, no prefaces.',
      isEntryPoint: 'Is this file an entry point (API endpoint, CLI command, event handler, cron job, queue worker)? Answer only "yes" or "no", followed by a short reason in English. Format: "yes|no: reason"',
      isTest: 'Is this file a test? Answer only "yes" or "no". Format: "yes|no: reason"',
      classifyInstruction: 'Classify this function: "tech_debt", "over_engineered", "complex_but_necessary", or "fine". Only the classification and a short reason in English.',
      modifiedFunction: 'Modified function',
      directCallers: 'Direct callers',
      noneKnown: 'none known',
      changeMade: 'CHANGE MADE',
      currentCode: 'Current function code',
      riskEvaluation: `Evaluate the risk of this change: does it break the signature? Does it change the output contract? Does it introduce new failure surface (network, files, external APIs)? Is it just a safe internal refactor?`,
      riskFormat: 'Respond EXACTLY in this format (two lines):\nRISK: critical|high|medium|low\nWHY: reason in English (one sentence)',
      complexity: 'Complexity',
      lines: 'Lines',
      rerankInstruction: 'Reorder indices from most to least relevant for the query. Respond only with numbers separated by commas. Example: "3,1,5,2,4,0"',
      candidates: 'Candidates',
    };
  }
  return {
    file: 'Archivo',
    functions: 'Funciones',
    exports: 'Exporta',
    noExports: 'No tiene exports.',
    summarizeInstruction: 'Resume en UNA frase en español qué hace este archivo. Solo la frase, sin prefacios.',
    isEntryPoint: '¿Es este archivo un punto de entrada (API endpoint, CLI command, event handler, cron job, queue worker)? Responde solo "si" o "no", seguido de una razón corta en español. Formato: "si|no: razón"',
    isTest: '¿Es este archivo un test? Responde solo "si" o "no". Formato: "si|no: razón"',
    classifyInstruction: 'Clasifica esta función: "tech_debt", "over_engineered", "complex_but_necessary", o "fine". Solo la clasificación y una razón corta en español.',
    modifiedFunction: 'Función modificada',
    directCallers: 'Callers directos',
    noneKnown: 'ninguno conocido',
    changeMade: 'CAMBIO REALIZADO',
    currentCode: 'Código actual de la función',
    riskEvaluation: `Evalúa el riesgo de este cambio considerando: ¿rompe la firma? ¿cambia el contrato de salida? ¿introduce nueva superficie de fallo (red, archivos, APIs externas)? ¿es solo un refactor interno seguro?`,
    riskFormat: 'Responde EXACTAMENTE en este formato (dos líneas):\nRISK: critical|high|medium|low\nWHY: razón en español (una frase)',
    complexity: 'Complejidad',
    lines: 'Líneas',
    rerankInstruction: 'Reordena los índices del más relevante al menos relevante para la query. Responde solo con los números separados por comas. Ejemplo: "3,1,5,2,4,0"',
    candidates: 'Candidatos',
  };
}

function getLocale(): Locale {
  try { return readLynxConfig().locale; } catch { return 'en'; }
}

// ── Summarize module ────────────────────────────────────────

export function summarizeModulePrompt(
  source: string,
  relPath: string,
  language: string,
  exports: string[]
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  const header = source.slice(0, Math.min(source.length, 2000));
  const exportsList = exports.length > 0
    ? `${L.exports}: ${exports.slice(0, 10).join(', ')}.`
    : L.noExports;
  return `${L.file}: ${relPath} (${language})\n${exportsList}\n\n${header}\n\n${L.summarizeInstruction}`;
}

// ── Detect entry point ───────────────────────────────────────

export function detectEntryPointPrompt(
  source: string,
  relPath: string,
  nodes: LynxNode[]
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  const header = source.slice(0, Math.min(source.length, 1500));
  const funcs = nodes
    .filter(n => n.kind === 'Function' || n.kind === 'Method')
    .map(n => n.name)
    .slice(0, 10);
  const funcList = funcs.length > 0 ? `${L.functions}: ${funcs.join(', ')}.` : '';
  return `${L.file}: ${relPath}\n${funcList}\n\n${header}\n\n${L.isEntryPoint}`;
}

// ── Detect test file ─────────────────────────────────────────

export function detectTestPrompt(
  source: string,
  relPath: string
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  const header = source.slice(0, Math.min(source.length, 1200));
  return `${L.file}: ${relPath}\n\n${header}\n\n${L.isTest}`;
}

// ── Classify code smell ──────────────────────────────────────

export function classifyCodeSmellPrompt(
  funcSource: string,
  funcName: string,
  metrics: { cyclomatic: number; lineCount: number; loopDepth: number }
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  return `Function: ${funcName}\n${L.complexity}: ${metrics.cyclomatic}, ${L.lines}: ${metrics.lineCount}, Loop depth: ${metrics.loopDepth}\n\n${funcSource.slice(0, 1500)}\n\n${L.classifyInstruction}`;
}

// ── Assess change risk ───────────────────────────────────────

export function assessChangeRiskPrompt(
  funcName: string,
  funcSource: string,
  callers: string[],
  fanIn: number,
  changeDescription: string
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  const callerList = callers.slice(0, 10).join(', ');
  const sourceSnippet = funcSource.slice(0, 1500);
  return `${L.modifiedFunction}: ${funcName}
${L.directCallers}: ${fanIn} (${callerList || L.noneKnown})

${L.changeMade}:
${changeDescription.slice(0, 1000)}

${L.currentCode}:
\`\`\`
${sourceSnippet}
\`\`\`

${L.riskEvaluation}

${L.riskFormat}`;}

// ── Re-rank search results ────────────────────────────────────

export function reRankSearchPrompt(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): string {
  const locale = getLocale();
  const L = localeLabels(locale);
  const items = candidates.map(c =>
    `[${c.index}] ${c.kind}: ${c.name}\n   ${c.snippet.slice(0, 150)}`
  ).join('\n');
  return `Query: "${query}"\n\n${L.candidates}:\n${items}\n\n${L.rerankInstruction}`;
}
