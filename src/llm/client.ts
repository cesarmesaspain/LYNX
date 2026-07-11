/*
 * client.ts — Unified LLM client with automatic provider selection.
 *
 * Strategy: Qwen local > DeepSeek cloud > heuristic fallback.
 * In pkg binary mode, only heuristics are used (no network dependency).
 *
 * All task methods return metadata — never throw.
 */

import { llmCache } from './cache.js';
import type { LlmFileMetadata } from './types.js';
import type { LynxNode } from '../types.js';

import {
  summarizeModulePrompt,
  detectEntryPointPrompt,
  detectTestPrompt,
  classifyCodeSmellPrompt,
  assessChangeRiskPrompt,
  reRankSearchPrompt,
} from './prompts.js';

import {
  heuristicSummarize,
  heuristicDetectEntryPoint,
  heuristicDetectTest,
  heuristicClassifyCodeSmell,
  heuristicAssessChangeRisk,
} from './provider-heuristic.js';

import * as deepseekProvider from './provider-deepseek.js';
import { isPkg } from '../paths.js';

const VPS_URL = process.env.LYNX_API_URL || '';
const VPS_KEY = process.env.LYNX_API_KEY || '';

function hasVps(): boolean {
  if (isPkg()) return false;
  return !!(VPS_URL && VPS_KEY);
}

function hasDeepSeek(): boolean {
  if (isPkg()) return false;
  return !!process.env.LYNX_DEEPSEEK_KEY;
}

export function getRerankProviderMode(): 'api' | 'deepseek' | 'heuristic' {
  if (process.env.LYNX_NO_LLM === '1') return 'heuristic';
  if (hasVps()) return 'api';
  if (hasDeepSeek()) return 'deepseek';
  return 'heuristic';
}

async function callVps(task: string, payload: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(`${VPS_URL}/v1/intelligence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': VPS_KEY,
      },
      body: JSON.stringify({ task, payload }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: string };
    return data.result || null;
  } catch {
    return null;
  }
}

// ── Per-file enrichment (called after extraction) ───────────

export interface LlmEnrichResult {
  metadata: LlmFileMetadata;
}

export async function enrichFile(
  source: string,
  hash: string,
  relPath: string,
  language: string,
  nodes: LynxNode[]
): Promise<LlmEnrichResult> {
  const exports = nodes.filter(n => n.isExported).map(n => n.name);
  const metadata: LlmFileMetadata = { source: 'heuristic' };
  const vps = hasVps();
  const ds = !vps && hasDeepSeek();

  // Summarize
  const cachedSummary = llmCache.get<string>(hash, 'summarize_module');
  if (cachedSummary !== undefined) {
    metadata.summary = cachedSummary;
  } else {
    // Try VPS first
    if (vps) {
      const result = await callVps('summarize_module', {
        path: relPath, language, exports, function_count: nodes.filter(n => n.kind === 'Function' || n.kind === 'Method').length,
      });
      if (result) {
        metadata.summary = result;
        metadata.source = 'api';
        llmCache.set(hash, 'summarize_module', result);
      }
    }
    // Fallback to DeepSeek direct
    if (!metadata.summary && ds) {
      const prompt = summarizeModulePrompt(source, relPath, language, exports);
      const result = await deepseekProvider.deepseekSummarize(prompt);
      if (result) {
        metadata.summary = result.summary;
        metadata.source = 'deepseek';
        llmCache.set(hash, 'summarize_module', result.summary);
      }
    }
    // Last resort: heuristic
    if (!metadata.summary) {
      const h = heuristicSummarize(relPath, language, nodes);
      metadata.summary = h.summary;
      llmCache.set(hash, 'summarize_module', h.summary);
    }
  }

  // Detect entry point
  const cachedEntry = llmCache.get<boolean>(hash, 'detect_entry_point');
  if (cachedEntry !== undefined) {
    metadata.suggestedEntryPoint = cachedEntry;
  } else {
    if (vps) {
      const funcNames = nodes.filter(n => n.kind === 'Function' || n.kind === 'Method').map(n => n.name).slice(0, 10);
      const result = await callVps('detect_entry_point', { path: relPath, func_names: funcNames });
      if (result) {
        metadata.suggestedEntryPoint = result.toLowerCase().startsWith('si');
        metadata.source = 'api';
        llmCache.set(hash, 'detect_entry_point', metadata.suggestedEntryPoint);
      }
    }
    if (metadata.suggestedEntryPoint === undefined && ds) {
      const prompt = detectEntryPointPrompt(source, relPath, nodes);
      const result = await deepseekProvider.deepseekDetectEntryPoint(prompt);
      if (result) {
        metadata.suggestedEntryPoint = result.isEntryPoint;
        metadata.source = 'deepseek';
        llmCache.set(hash, 'detect_entry_point', result.isEntryPoint);
      }
    }
    if (metadata.suggestedEntryPoint === undefined) {
      const h = heuristicDetectEntryPoint(relPath, nodes);
      metadata.suggestedEntryPoint = h.isEntryPoint;
      llmCache.set(hash, 'detect_entry_point', h.isEntryPoint);
    }
  }

  // Detect test file
  const cachedTest = llmCache.get<boolean>(hash, 'detect_test');
  if (cachedTest !== undefined) {
    metadata.suggestedTestFile = cachedTest;
  } else {
    if (vps) {
      const result = await callVps('detect_test', { path: relPath });
      if (result) {
        metadata.suggestedTestFile = result.toLowerCase().startsWith('si');
        llmCache.set(hash, 'detect_test', metadata.suggestedTestFile);
      }
    }
    if (metadata.suggestedTestFile === undefined && ds) {
      const prompt = detectTestPrompt(source, relPath);
      const result = await deepseekProvider.deepseekDetectTest(prompt);
      if (result) {
        metadata.suggestedTestFile = result.isTest;
        llmCache.set(hash, 'detect_test', result.isTest);
      }
    }
    if (metadata.suggestedTestFile === undefined) {
      const h = heuristicDetectTest(relPath, source);
      metadata.suggestedTestFile = h.isTest;
      llmCache.set(hash, 'detect_test', h.isTest);
    }
  }

  return { metadata };
}

// ── Code smell classification ───────────────────────────────

export interface SmellResult {
  category: string;
  explanation: string;
}

export async function classifySmell(
  funcSource: string,
  funcName: string,
  metrics: { cyclomatic: number; lineCount: number; loopDepth: number }
): Promise<SmellResult> {
  const vps = hasVps();
  if (vps) {
    const result = await callVps('classify_code_smell', {
      func_name: funcName, line_count: metrics.lineCount, complexity: metrics.cyclomatic,
    });
    if (result) {
      const parts = result.split(':');
      return { category: parts[0]?.trim() || 'fine', explanation: parts.slice(1).join(':').trim() || result };
    }
  }
  if (!vps && hasDeepSeek()) {
    const prompt = classifyCodeSmellPrompt(funcSource, funcName, metrics);
    const result = await deepseekProvider.deepseekClassifyCodeSmell(prompt);
    if (result) return { category: result.category, explanation: result.explanation };
  }

  const h = heuristicClassifyCodeSmell(metrics);
  return { category: h.category, explanation: h.explanation };
}

// ── Change risk assessment ──────────────────────────────────

export interface RiskResult {
  risk: string;
  reason: string;
}

export interface RiskMeta {
  risk: string;
  reason: string;
  provider: string;
  model?: string;
  fallback: boolean;
}

export interface LlmUsage {
  enabled: boolean;
  used: boolean;
  provider: string | null;
  model: string | null;
  calls: number;
  latency_ms: number;
  fallback_used: boolean;
  fallback_reason: string | null;
}

export async function assessRisk(
  funcName: string,
  funcSource: string,
  callers: string[],
  fanIn: number,
  changeDescription: string
): Promise<RiskResult> {
  const result = await assessRiskWithMeta(funcName, funcSource, callers, fanIn, changeDescription);
  return { risk: result.risk, reason: result.reason };
}

export async function assessRiskWithMeta(
  funcName: string,
  funcSource: string,
  callers: string[],
  fanIn: number,
  changeDescription: string
): Promise<RiskMeta> {
  const vps = hasVps();
  if (vps) {
    const changeSig = changeDescription.slice(0, 500);
    const result = await callVps('assess_change_risk', {
      func_name: funcName, line_count: funcSource.split('\n').length, caller_count: fanIn, change_sig: changeSig,
    });
    if (result) {
      const lines = result.split('\n');
      const riskLine = lines.find(l => l.startsWith('RISK:')) || '';
      const whyLine = lines.find(l => l.startsWith('WHY:')) || '';
      return {
        risk: riskLine.replace('RISK:', '').trim().toLowerCase() || 'medium',
        reason: whyLine.replace('WHY:', '').trim() || 'Sin evaluacion detallada.',
        provider: 'api',
        fallback: false,
      };
    }
  }
  if (!vps && hasDeepSeek()) {
    const prompt = assessChangeRiskPrompt(funcName, funcSource, callers, fanIn, changeDescription);
    const result = await deepseekProvider.deepseekAssessChangeRisk(prompt);
    if (result) return { risk: result.risk, reason: result.reason, provider: 'deepseek', model: 'deepseek-v4-flash', fallback: false };
  }

  const h = heuristicAssessChangeRisk(funcName, fanIn, changeDescription);
  return { risk: h.risk, reason: h.reason, provider: 'heuristic', fallback: true };
}

// ── Search re-rank ──────────────────────────────────────────

export interface RankedItem {
  index: number;
  relevanceScore: number;
}

export async function rerankSearch(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): Promise<RankedItem[]> {
  if (candidates.length <= 1) {
    return candidates.map(c => ({ index: c.index, relevanceScore: 1 }));
  }

  const vps = hasVps();
  if (vps) {
    const payload = candidates.map(c => ({ index: c.index, kind: c.kind, name: c.name }));
    const result = await callVps('rerank_search', { query, candidates: payload });
    if (result) {
      const indices = result.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (indices.length > 0) {
        const maxScore = indices.length;
        return indices.map((idx, i) => ({ index: idx, relevanceScore: 1 - (i / Math.max(maxScore, 1)) * 0.5 }));
      }
    }
  }
  if (!vps && hasDeepSeek()) {
    const prompt = reRankSearchPrompt(query, candidates);
    const result = await deepseekProvider.deepseekReRank(prompt);
    if (result && result.ranked.length > 0) {
      return result.ranked.map(r => ({ index: r.index, relevanceScore: r.relevanceScore }));
    }
  }

  // Heuristic: keep original order (already BM25-ranked)
  return candidates.map((c, i) => ({
    index: c.index,
    relevanceScore: 1 - (i / Math.max(candidates.length, 1)) * 0.3,
  }));
}

export interface RerankMeta {
  items: RankedItem[];
  provider: string;
  model?: string;
  fallback: boolean;
}

export async function rerankSearchWithMeta(
  query: string,
  candidates: Array<{ index: number; name: string; kind: string; snippet: string }>
): Promise<RerankMeta> {
  if (candidates.length <= 1) {
    return {
      items: candidates.map(c => ({ index: c.index, relevanceScore: 1 })),
      provider: 'heuristic',
      fallback: false,
    };
  }

  const vps = hasVps();
  if (vps) {
    const payload = candidates.map(c => ({ index: c.index, kind: c.kind, name: c.name }));
    const result = await callVps('rerank_search', { query, candidates: payload });
    if (result) {
      const indices = result.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (indices.length > 0) {
        const maxScore = indices.length;
        return {
          items: indices.map((idx, i) => ({ index: idx, relevanceScore: 1 - (i / Math.max(maxScore, 1)) * 0.5 })),
          provider: 'api',
          fallback: false,
        };
      }
    }
  }
  if (!vps && hasDeepSeek()) {
    const prompt = reRankSearchPrompt(query, candidates);
    const result = await deepseekProvider.deepseekReRank(prompt);
    if (result && result.ranked.length > 0) {
      return {
        items: result.ranked.map(r => ({ index: r.index, relevanceScore: r.relevanceScore })),
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        fallback: false,
      };
    }
  }

  return {
    items: candidates.map((c, i) => ({
      index: c.index,
      relevanceScore: 1 - (i / Math.max(candidates.length, 1)) * 0.3,
    })),
    provider: 'heuristic',
    fallback: true,
  };
}
