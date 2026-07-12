/*
 * provider-qwen.ts — Local Qwen model via MLX LM Server (OpenAI-compatible).
 *
 * Default base URL: http://localhost:8011/v1
 * Uses raw fetch() — no SDK dependency needed.
 * Model: mlx-community/Qwen3.6-35B-A3B-4bit (35B MoE, 3B active, 4-bit)
 *
 * Performance (MacBook Pro M-series, Apple GPU):
 *   - Cold start: ~17s (JIT + MLX graph compilation)
 *   - Warm: ~0.9s (yes/no), ~2s (40 tok output)
 *   - Generation: ~20 tok/s
 */

import type {
  LlmSummaryResult,
  LlmEntryPointResult,
  LlmTestDetectionResult,
  LlmCodeSmellResult,
  LlmChangeRiskResult,
  LlmReRankResult,
} from './types.js';
import { readLynxConfig } from '../config/runtime.js';

const BASE_URL = process.env.LYNX_QWEN_URL || 'http://localhost:8011/v1';
const MODEL = process.env.LYNX_QWEN_MODEL || 'mlx-community/Qwen3.6-35B-A3B-4bit';
const TIMEOUT_MS = parseInt(process.env.LYNX_QWEN_TIMEOUT || '30000', 10);

function getLocale(): 'es' | 'en' {
  try { return readLynxConfig().locale; } catch { return 'en'; }
}

function isYes(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.startsWith('si') || lower.startsWith('yes');
}

function systemPrompts(locale: 'es' | 'en') {
  return locale === 'en'
    ? {
        summarize: 'You are a technical assistant. Respond in English with concise sentences.',
        entryPoint: 'You are a code analyzer. Respond in English, format: "yes|no: reason".',
        test: 'You are a test detector. Respond in English, format: "yes|no: reason".',
        codeSmell: 'You are a code reviewer. Classify as: tech_debt, over_engineered, complex_but_necessary, fine.',
        risk: 'You are a code risk analyzer. Classify as: critical, high, medium, low.',
        rerank: 'You are a search engine. Respond only with comma-separated numbers.',
      }
    : {
        summarize: 'Eres un asistente tecnico. Respondes en espanol con frases concisas.',
        entryPoint: 'Eres un analizador de codigo. Responde en espanol, formato: "si|no: razon".',
        test: 'Eres un detector de tests. Responde en espanol, formato: "si|no: razon".',
        codeSmell: 'Eres un revisor de codigo. Clasificas en: tech_debt, over_engineered, complex_but_necessary, fine.',
        risk: 'Eres un analizador de riesgo de codigo. Clasificas en: critical, high, medium, low.',
        rerank: 'Eres un motor de busqueda. Responde solo con numeros separados por comas.',
      };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(
  messages: ChatMessage[],
  maxTokens = 128,
  temperature = 0.1
): Promise<{ text: string; tokens: number; timeMs: number } | null> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const json = await res.json() as any;
    const text = json.choices?.[0]?.message?.content?.trim() || null;
    const tokens = json.usage?.completion_tokens || 0;
    return { text, tokens, timeMs: Date.now() - start };
  } catch {
    return null;
  }
}

function parseConfidence(_text: string): 'high' | 'medium' | 'low' {
  return 'medium';
}

// ── Summarize module ────────────────────────────────────────

export async function qwenSummarize(
  prompt: string
): Promise<LlmSummaryResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.summarize },
    { role: 'user', content: prompt },
  ], 80);

  if (!r || !r.text) return null;

  return {
    summary: r.text,
    language: 'unknown',
    confidence: parseConfidence(r.text),
  };
}

// ── Detect entry point ───────────────────────────────────────

export async function qwenDetectEntryPoint(
  prompt: string
): Promise<LlmEntryPointResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.entryPoint },
    { role: 'user', content: prompt },
  ], 40);

  if (!r || !r.text) return null;

  const isEntry = isYes(r.text);
  const reason = r.text.replace(/^(?:si|yes)\|?(?:no)?:?\s*/i, '').trim();

  return {
    isEntryPoint: isEntry,
    reason: reason || r.text,
    confidence: parseConfidence(r.text),
  };
}

// ── Detect test file ─────────────────────────────────────────

export async function qwenDetectTest(
  prompt: string
): Promise<LlmTestDetectionResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.test },
    { role: 'user', content: prompt },
  ], 20);

  if (!r || !r.text) return null;

  const isTest = isYes(r.text);
  const reason = r.text.replace(/^(?:si|yes)\|?(?:no)?:?\s*/i, '').trim();

  return {
    isTest,
    reason: reason || r.text,
    confidence: parseConfidence(r.text),
  };
}

// ── Classify code smell ──────────────────────────────────────

export async function qwenClassifyCodeSmell(
  prompt: string
): Promise<LlmCodeSmellResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.codeSmell },
    { role: 'user', content: prompt },
  ], 80);

  if (!r || !r.text) return null;

  let category: LlmCodeSmellResult['category'] = 'fine';
  const lower = r.text.toLowerCase();
  if (lower.includes('tech_debt')) category = 'tech_debt';
  else if (lower.includes('over_engineered')) category = 'over_engineered';
  else if (lower.includes('complex_but_necessary')) category = 'complex_but_necessary';

  return { category, explanation: r.text, confidence: parseConfidence(r.text) };
}

// ── Assess change risk ───────────────────────────────────────

export async function qwenAssessChangeRisk(
  prompt: string
): Promise<LlmChangeRiskResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.risk },
    { role: 'user', content: prompt },
  ], 80);

  if (!r || !r.text) return null;

  let risk: LlmChangeRiskResult['risk'] = 'medium';
  const lower = r.text.toLowerCase();
  if (lower.includes('critical')) risk = 'critical';
  else if (lower.includes('high')) risk = 'high';
  else if (lower.includes('low')) risk = 'low';

  return { risk, reason: r.text, affectedCallers: [], confidence: parseConfidence(r.text) };
}

// ── Re-rank search ───────────────────────────────────────────

export async function qwenReRank(
  prompt: string
): Promise<LlmReRankResult | null> {
  const S = systemPrompts(getLocale());
  const r = await chat([
    { role: 'system', content: S.rerank },
    { role: 'user', content: prompt },
  ], 100, 0);

  if (!r || !r.text) return null;

  const indices = r.text
    .split(/[,\s]+/)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n));

  if (indices.length === 0) return null;

  return {
    ranked: indices.map((idx, i) => ({
      index: idx,
      relevanceScore: 1 - (i / Math.max(indices.length, 1)) * 0.5,
      reason: 'Qwen re-rank',
    })),
  };
}
