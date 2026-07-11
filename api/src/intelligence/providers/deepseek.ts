/*
 * deepseek.ts — DeepSeek V4 Flash provider (cloud fallback).
 *
 * OpenAI-compatible API. Input $0.14/M (cache miss), $0.0028/M (cache hit), Output $0.28/M.
 * Used only when the local Qwen 14B model is unavailable.
 */

import type { IntelligenceRequest } from '../../types.js';

export async function callDeepSeek(
  apiKey: string,
  task: string,
  payload: Record<string, unknown>,
  maxTokens: number,
  temperature: number
): Promise<string | null> {
  const prompt = buildPrompt(task, payload);
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'Eres un analizador de codigo. Responde EXACTAMENTE en el formato pedido. Sin preambulos.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return null;
  const data = await res.json() as any;
  const text: string = data.choices?.[0]?.message?.content || '';
  return text.trim() || null;
}

function buildPrompt(task: string, payload: Record<string, unknown>): string {
  switch (task) {
    case 'summarize_module': {
      const { path: p, language, exports, function_count } = payload as any;
      return `Archivo: ${p} (${language})\nExporta: ${(exports || []).slice(0, 10).join(', ') || 'nada'}\nContiene ${function_count || 0} funciones.\n\nResume en UNA frase en español qué hace este módulo. Solo la frase.`;
    }
    case 'rerank_search': {
      const { query, candidates } = payload as any;
      const items = (candidates || []).map((c: any) =>
        `[${c.index}] ${c.kind}: ${c.name}`
      ).join('\n');
      return `Query: "${query}"\n\nCandidatos:\n${items}\n\nReordena los índices del más relevante al menos relevante. Responde solo con números separados por comas. Ejemplo: "3,1,0,2"`;
    }
    case 'assess_change_risk': {
      const { func_name, line_count, caller_count, change_sig } = payload as any;
      return `Función: ${func_name} (${line_count} líneas)\nCallers: ${caller_count}\n\nCambio detectado: ${change_sig}\n\nEvalúa el riesgo. Responde EXACTAMENTE:\nRISK: critical|high|medium|low\nWHY: razón en español (una frase)`;
    }
    default:
      return task;
  }
}
