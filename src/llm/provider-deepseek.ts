/*
 * provider-deepseek.ts — DeepSeek V4 Flash via OpenAI-compatible API.
 *
 * DeepSeek V4 Flash: ~$0.28/M output tokens, ~200-400ms latency.
 * API base: https://api.deepseek.com/v1
 * Model: deepseek-chat (auto-routes to V4 Flash for simple prompts)
 *
 * Uses raw fetch() — no SDK dependency needed.
 */

import type {
  LlmSummaryResult,
  LlmEntryPointResult,
  LlmTestDetectionResult,
  LlmCodeSmellResult,
  LlmChangeRiskResult,
  LlmReRankResult,
} from './types.js';
import { getApiKey, openaiChatCompletion, DEFAULT_MODEL } from './shared.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(
  messages: ChatMessage[],
  maxTokens = 128,
  temperature = 0.1
): Promise<string | null> {
  const key = getApiKey();
  if (!key) return null;

  try {
    const res = await openaiChatCompletion(
      {
        model: DEFAULT_MODEL,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        temperature,
      },
      { apiKey: key, timeoutMs: 10_000 }
    );

    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── Parsing helpers ──────────────────────────────────────────

function parseConfidence(text: string): 'high' | 'medium' | 'low' {
  if (text.includes('alta') || text.includes('high')) return 'high';
  if (text.includes('baja') || text.includes('low')) return 'low';
  return 'medium';
}

// ── Summarize module ────────────────────────────────────────

export async function deepseekSummarize(
  prompt: string
): Promise<LlmSummaryResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un asistente técnico. Respondes en español con frases concisas.' },
    { role: 'user', content: prompt },
  ], 80);

  if (!text) return null;

  return {
    summary: text,
    language: 'unknown',
    confidence: parseConfidence(text),
  };
}

// ── Detect entry point ───────────────────────────────────────

export async function deepseekDetectEntryPoint(
  prompt: string
): Promise<LlmEntryPointResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un analizador de código. Responde en español, formato: "si|no: razón".' },
    { role: 'user', content: prompt },
  ], 60);

  if (!text) return null;

  const isEntry = text.toLowerCase().startsWith('si');
  const reason = text.replace(/^si\|?no:?\s*/i, '').trim();

  return {
    isEntryPoint: isEntry,
    reason: reason || text,
    confidence: parseConfidence(text),
  };
}

// ── Detect test file ─────────────────────────────────────────

export async function deepseekDetectTest(
  prompt: string
): Promise<LlmTestDetectionResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un detector de tests. Responde en español, formato: "si|no: razón".' },
    { role: 'user', content: prompt },
  ], 60);

  if (!text) return null;

  const isTest = text.toLowerCase().startsWith('si');
  const reason = text.replace(/^si\|?no:?\s*/i, '').trim();

  return {
    isTest,
    reason: reason || text,
    confidence: parseConfidence(text),
  };
}

// ── Classify code smell ──────────────────────────────────────

export async function deepseekClassifyCodeSmell(
  prompt: string
): Promise<LlmCodeSmellResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un revisor de código. Clasificas en: tech_debt, over_engineered, complex_but_necessary, fine.' },
    { role: 'user', content: prompt },
  ], 80);

  if (!text) return null;

  let category: LlmCodeSmellResult['category'] = 'fine';
  const lower = text.toLowerCase();
  if (lower.includes('tech_debt')) category = 'tech_debt';
  else if (lower.includes('over_engineered')) category = 'over_engineered';
  else if (lower.includes('complex_but_necessary')) category = 'complex_but_necessary';

  return { category, explanation: text, confidence: parseConfidence(text) };
}

// ── Assess change risk ───────────────────────────────────────

export async function deepseekAssessChangeRisk(
  prompt: string
): Promise<LlmChangeRiskResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un analizador de riesgo de código. Clasificas en: critical, high, medium, low.' },
    { role: 'user', content: prompt },
  ], 80);

  if (!text) return null;

  let risk: LlmChangeRiskResult['risk'] = 'medium';
  const lower = text.toLowerCase();
  if (lower.includes('critical')) risk = 'critical';
  else if (lower.includes('high')) risk = 'high';
  else if (lower.includes('low')) risk = 'low';

  return { risk, reason: text, affectedCallers: [], confidence: parseConfidence(text) };
}

// ── Re-rank search ───────────────────────────────────────────

export async function deepseekReRank(
  prompt: string
): Promise<LlmReRankResult | null> {
  const text = await chat([
    { role: 'system', content: 'Eres un motor de búsqueda. Responde solo con números separados por comas.' },
    { role: 'user', content: prompt },
  ], 100, 0);

  if (!text) return null;

  const indices = text
    .split(/[,\s]+/)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n));

  if (indices.length === 0) return null;

  return {
    ranked: indices.map((idx, i) => ({
      index: idx,
      relevanceScore: 1 - (i / Math.max(indices.length, 1)) * 0.5,
      reason: 'DeepSeek re-rank',
    })),
  };
}
