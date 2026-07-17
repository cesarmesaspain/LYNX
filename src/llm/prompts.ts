/*
 * prompts.ts — Prompt templates for each LLM task.
 *
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
    ? `Exports: ${exports.slice(0, 10).join(', ')}.`
    : 'No exports.';
  return `File: ${relPath} (${language})\n${exportsList}\n\n${header}\n\nSummarize in ONE English sentence what this file does. Just the sentence, no prefaces.`;
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
  const funcList = funcs.length > 0 ? `Functions: ${funcs.join(', ')}.` : '';
  return `File: ${relPath}\n${funcList}\n\n${header}\n\nIs this file an entry point (API endpoint, CLI command, event handler, cron job, queue worker)? Answer only "yes" or "no", followed by a short reason in English. Format: "yes|no: reason"`;
}

// ── Detect test file ─────────────────────────────────────────

export function detectTestPrompt(
  source: string,
  relPath: string
): string {
  const header = source.slice(0, Math.min(source.length, 1200));
  return `File: ${relPath}\n\n${header}\n\nIs this file a test? Answer only "yes" or "no". Format: "yes|no: reason"`;
}

// ── Classify code smell ──────────────────────────────────────

export function classifyCodeSmellPrompt(
  funcSource: string,
  funcName: string,
  metrics: { cyclomatic: number; lineCount: number; loopDepth: number }
): string {
  return `Function: ${funcName}\nComplexity: ${metrics.cyclomatic}, Lines: ${metrics.lineCount}, Loop depth: ${metrics.loopDepth}\n\n${funcSource.slice(0, 1500)}\n\nClassify this function: "tech_debt", "over_engineered", "complex_but_necessary", or "fine". Only the classification and a short reason in English.`;
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
  return `Modified function: ${funcName}
Direct callers: ${fanIn} (${callerList || 'none known'})

CHANGE MADE:
${changeDescription.slice(0, 1000)}

Current function code:
\`\`\`
${sourceSnippet}
\`\`\`

Evaluate the risk of this change: does it break the signature? Does it change the output contract? Does it introduce new failure surface (network, files, external APIs)? Is it just a safe internal refactor?

Respond EXACTLY in this format (two lines):
RISK: critical|high|medium|low
WHY: reason in English (one sentence)`;
}

// ── Re-rank search results ────────────────────────────────────

export function reRankSearchPrompt(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): string {
  const items = candidates.map(c =>
    `[${c.index}] ${c.kind}: ${c.name}\n   ${c.snippet.slice(0, 150)}`
  ).join('\n');
  return `Query: "${query}"\n\nCandidates:\n${items}\n\nReorder indices from most to least relevant for the query. Respond only with numbers separated by commas. Example: "3,1,5,2,4,0"`;
}
