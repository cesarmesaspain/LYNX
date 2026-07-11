/*
 * provider-intelligence-api.ts — Cloud intelligence provider via LYNX API.
 *
 * This is the NEW default provider for Pro users. It replaces local Qwen/DeepSeek
 * direct calls with a single API endpoint: POST https://api.lynx.dev/v1/intelligence
 *
 * Zero-knowledge: only metadata is sent. Source code never leaves the machine.
 *
 * Falls back to local heuristic if:
 *   - User is on Free tier
 *   - No internet connection
 *   - API returns an error
 */

import type {
  LlmSummaryResult,
  LlmEntryPointResult,
  LlmTestDetectionResult,
  LlmCodeSmellResult,
  LlmChangeRiskResult,
  LlmReRankItem,
} from '../llm/types.js';
import type { LynxNode } from '../types.js';
import { readLicense } from './license.js';
import { hasCapability } from './gate.js';
import {
  heuristicSummarize,
  heuristicDetectEntryPoint,
  heuristicDetectTest,
  heuristicClassifyCodeSmell,
  heuristicAssessChangeRisk,
} from '../llm/provider-heuristic.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const API_URL = process.env.LYNX_API_URL || 'https://api.lynx.dev';

async function callIntelligence(
  task: string,
  payload: Record<string, unknown>
): Promise<string | null> {
  const license = readLicense();
  if (!license) return null;

  try {
    const licensePath = `${homedir()}/.lynx/license`;
    const licenseJwt = readFileSync(licensePath, 'utf8').trim();

    const res = await fetch(`${API_URL}/v1/intelligence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        license_jwt: licenseJwt,
        payload,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.result || null;
  } catch {
    return null;
  }
}

// ── Summarize module ────────────────────────────────

export async function apiSummarize(
  source: string,
  relPath: string,
  language: string,
  nodes: LynxNode[]
): Promise<LlmSummaryResult | null> {
  if (!hasCapability('semantic_rerank')) return null;

  const exports = nodes.filter(n => n.isExported).map(n => n.name);
  const funcCount = nodes.filter(n => n.kind === 'Function' || n.kind === 'Method').length;

  const result = await callIntelligence('summarize_module', {
    path: relPath,
    language,
    exports,
    function_count: funcCount,
  });

  if (result) {
    return { summary: result, language, confidence: 'high' };
  }
  return null;
}

// ── Detect entry point ──────────────────────────────

export async function apiDetectEntryPoint(
  _source: string,
  relPath: string,
  nodes: LynxNode[]
): Promise<LlmEntryPointResult | null> {
  if (!hasCapability('semantic_rerank')) return null;

  const funcNames = nodes
    .filter(n => n.kind === 'Function' || n.kind === 'Method')
    .map(n => n.name)
    .slice(0, 10);

  const result = await callIntelligence('detect_entry_point', {
    path: relPath,
    func_names: funcNames,
  });

  if (result) {
    const parts = result.split(':');
    const isEntry = parts[0]?.trim().toLowerCase() === 'si';
    const reason = parts.slice(1).join(':').trim() || result;
    return { isEntryPoint: isEntry, reason, confidence: 'high' };
  }
  return null;
}

// ── Detect test ─────────────────────────────────────

export async function apiDetectTest(
  _source: string,
  relPath: string
): Promise<LlmTestDetectionResult | null> {
  if (!hasCapability('semantic_rerank')) return null;

  const result = await callIntelligence('detect_test', {
    path: relPath,
  });

  if (result) {
    const parts = result.split(':');
    const isTest = parts[0]?.trim().toLowerCase() === 'si';
    const reason = parts.slice(1).join(':').trim() || result;
    return { isTest, reason, confidence: 'high' };
  }
  return null;
}

// ── Classify code smell ─────────────────────────────

export async function apiClassifyCodeSmell(
  _funcSource: string,
  funcName: string,
  metrics: { cyclomatic: number; lineCount: number; loopDepth: number }
): Promise<LlmCodeSmellResult | null> {
  if (!hasCapability('semantic_rerank')) return null;

  const result = await callIntelligence('classify_code_smell', {
    func_name: funcName,
    line_count: metrics.lineCount,
    complexity: metrics.cyclomatic,
  });

  if (result) {
    const parts = result.split(':');
    const category = parts[0]?.trim() || 'fine';
    const explanation = parts.slice(1).join(':').trim() || result;
    return {
      category: category as any,
      explanation,
      confidence: 'high',
    };
  }
  return null;
}

// ── Assess change risk ──────────────────────────────

export async function apiAssessChangeRisk(
  funcName: string,
  _funcSource: string,
  _callers: string[],
  fanIn: number,
  changeDescription: string
): Promise<LlmChangeRiskResult | null> {
  if (!hasCapability('semantic_rerank')) return null;

  // Extract a safe change signature (no source code!)
  const changeSig = changeDescription.slice(0, 500);

  const result = await callIntelligence('assess_change_risk', {
    func_name: funcName,
    line_count: _funcSource.split('\n').length,
    caller_count: fanIn,
    change_sig: changeSig,
  });

  if (result) {
    const lines = result.split('\n');
    const riskLine = lines.find(l => l.startsWith('RISK:')) || '';
    const whyLine = lines.find(l => l.startsWith('WHY:')) || '';

    const risk = riskLine.replace('RISK:', '').trim().toLowerCase() || 'medium';
    const reason = whyLine.replace('WHY:', '').trim() || 'Sin evaluacion detallada.';

    return {
      risk: risk as any,
      reason,
      affectedCallers: [],
      confidence: 'high',
    };
  }
  return null;
}

// ── Re-rank search ──────────────────────────────────

export async function apiReRank(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): Promise<LlmReRankItem[] | null> {
  if (!hasCapability('semantic_rerank') || candidates.length <= 1) return null;

  const payload = candidates.map(c => ({
    index: c.index,
    kind: c.kind,
    name: c.name,
  }));

  const result = await callIntelligence('rerank_search', {
    query,
    candidates: payload,
  });

  if (result) {
    const indices = result.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const maxScore = indices.length;
    return indices.map((idx, i) => ({
      index: idx,
      relevanceScore: 1 - (i / Math.max(maxScore, 1)) * 0.5,
      reason: 'API re-rank',
    }));
  }
  return null;
}
