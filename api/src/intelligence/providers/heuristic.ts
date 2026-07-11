/*
 * heuristic.ts — Rule-based fallback provider. Always available, zero latency.
 *
 * Same logic as LYNX src/llm/provider-heuristic.ts but runs server-side
 * for cases where all model providers fail.
 */

import type { IntelligenceRequest, IntelligenceResponse } from '../../types.js';

export async function callHeuristic(
  req: IntelligenceRequest
): Promise<IntelligenceResponse> {
  const { task, payload } = req;
  let result = '';

  switch (task) {
    case 'summarize_module': {
      const { path: p, language, exports, function_count } = payload as any;
      const funcs = function_count || 0;
      const exps = exports || [];
      const name = String(p).split('/').pop()?.replace(/\.[^.]+$/, '') || p;
      const parts: string[] = [];
      if (exps.length > 0) parts.push(`${exps.length} exports`);
      if (funcs > 0) parts.push(`${funcs} funciones`);
      result = parts.length > 0
        ? `${name} (${language}): ${parts.join(', ')}.`
        : `${name} (${language}).`;
      break;
    }
    case 'rerank_search': {
      const { candidates } = payload as any;
      // Keep original BM25 order
      const cands = candidates || [];
      result = cands.map((c: any) => c.index).join(',');
      break;
    }
    case 'assess_change_risk': {
      const { func_name, caller_count } = payload as any;
      const fanIn = caller_count || 0;
      if (fanIn > 50) result = `RISK: critical\nWHY: ${func_name} tiene ${fanIn} callers.`;
      else if (fanIn > 20) result = `RISK: high\nWHY: ${func_name} tiene ${fanIn} callers.`;
      else if (fanIn > 5) result = `RISK: medium\nWHY: ${func_name} tiene ${fanIn} callers.`;
      else result = `RISK: low\nWHY: Pocos callers.`;
      break;
    }
    case 'detect_entry_point': {
      const { path: p } = payload as any;
      const entryPatterns = [/\/api\//, /\/routes?\//, /\/handlers?\//, /\/commands?\//, /\.command\./, /\.handler\./, /index\.ts$/, /server\.ts$/];
      const matched = entryPatterns.some((pt: RegExp) => pt.test(String(p)));
      result = matched ? 'si: ruta coincide con patron de entry point' : 'no: no coincide con patrones conocidos';
      break;
    }
    case 'classify_code_smell': {
      const { complexity, line_count } = payload as any;
      if (complexity > 100 || line_count > 500) result = 'tech_debt: complejidad alta';
      else if (complexity > 50 || line_count > 200) result = 'complex_but_necessary: complejidad moderada';
      else result = 'fine: complejidad aceptable';
      break;
    }
    case 'detect_test': {
      const { path: p } = payload as any;
      const testPatterns = [/\.test\./, /\.spec\./, /\.test_/, /_test\./, /__tests__\//, /\/tests?\//];
      const isTest = testPatterns.some((pt: RegExp) => pt.test(String(p)));
      result = isTest ? 'si: ruta de test' : 'no: no parece test';
      break;
    }
  }

  return { result, latency_ms: 0 };
}
