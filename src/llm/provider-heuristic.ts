/*
 * provider-heuristic.ts — Rules-based fallback provider.
 *
 * Zero dependencies, zero latency, always available.
 * Used as fallback when DeepSeek is unreachable.
 */

import type {
  LlmSummaryResult,
  LlmEntryPointResult,
  LlmTestDetectionResult,
  LlmCodeSmellResult,
  LlmChangeRiskResult,
} from './types.js';
import type { LynxNode } from '../types.js';

// ── Summarize module ────────────────────────────────────────

export function heuristicSummarize(
  relPath: string,
  language: string,
  nodes: LynxNode[]
): LlmSummaryResult {
  const funcs = nodes.filter(n => n.kind === 'Function' || n.kind === 'Method');
  const classes = nodes.filter(n => n.kind === 'Class');
  const parts: string[] = [];
  if (classes.length > 0) parts.push(`${classes.length} clase(s)`);
  if (funcs.length > 0) parts.push(`${funcs.length} función(es)`);
  const name = relPath.split('/').pop()?.replace(/\.[^.]+$/, '') || relPath;

  let summary: string;
  if (parts.length > 0) {
    summary = `${name} (${language}): ${parts.join(', ')}.`;
  } else {
    summary = `${name} (${language}).`;
  }

  return { summary, language, confidence: 'medium' };
}

// ── Detect entry point ───────────────────────────────────────

const ENTRY_PATTERNS = [
  /\/api\//, /\/routes?\//, /\/handlers?\//, /\/controllers?\//,
  /\/cli\//, /\/commands?\//, /\/jobs?\//, /\/workers?\//,
  /\/cron\//, /\/events?\//, /\/listeners?\//,
  /\.command\./, /\.handler\./, /\.controller\./, /\.route\./,
  /index\.ts$/, /main\.ts$/, /server\.ts$/, /app\.ts$/,
];

export function heuristicDetectEntryPoint(
  relPath: string,
  _nodes: LynxNode[]
): LlmEntryPointResult {
  for (const pattern of ENTRY_PATTERNS) {
    if (pattern.test(relPath)) {
      return {
        isEntryPoint: true,
        reason: `La ruta coincide con el patrón de entry point: ${pattern}`,
        confidence: 'medium',
      };
    }
  }
  return {
    isEntryPoint: false,
    reason: 'La ruta no coincide con patrones conocidos de entry point',
    confidence: 'medium',
  };
}

// ── Detect test file ─────────────────────────────────────────

const TEST_PATTERNS = [
  /\.test\./, /\.spec\./, /\.test_/, /_test\./,
  /__tests__\//, /\/tests?\//, /\/test\//,
  /\/spec\//, /\/specs\//, /\/__mocks__\//,
  /\/fixtures?\//, /\/__snapshots__\//,
];

const TEST_IMPORTS = [
  'describe', 'it', 'test', 'expect', 'assert',
  'jest', 'mocha', 'chai', 'vitest', 'supertest',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
];

export function heuristicDetectTest(
  relPath: string,
  source: string
): LlmTestDetectionResult {
  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(relPath)) {
      return {
        isTest: true,
        reason: `La ruta coincide con el patrón de test: ${pattern}`,
        confidence: 'high',
      };
    }
  }

  // Check source for test imports
  const head = source.slice(0, 500);
  for (const imp of TEST_IMPORTS) {
    if (head.includes(imp)) {
      return {
        isTest: true,
        reason: `El código contiene "${imp}" indicando testing`,
        confidence: 'medium',
      };
    }
  }

  return { isTest: false, reason: 'No se detectaron patrones de test', confidence: 'medium' };
}

// ── Classify code smell ──────────────────────────────────────

export function heuristicClassifyCodeSmell(metrics: {
  cyclomatic: number;
  lineCount: number;
  loopDepth: number;
}): LlmCodeSmellResult {
  if (metrics.cyclomatic > 100 || metrics.lineCount > 500) {
    return {
      category: 'tech_debt',
      explanation: `Complexity ${metrics.cyclomatic} and ${metrics.lineCount} lines: highly likely tech debt.`,
      confidence: 'medium',
    };
  }
  if (metrics.cyclomatic > 50 || metrics.lineCount > 200) {
    return {
      category: 'complex_but_necessary',
      explanation: `Complexity ${metrics.cyclomatic}: possibly necessary but deserves review.`,
      confidence: 'medium',
    };
  }
  return {
    category: 'fine',
    explanation: 'Complexity within acceptable ranges.',
    confidence: 'medium',
  };
}

// ── Assess change risk ───────────────────────────────────────

export function heuristicAssessChangeRisk(
  funcName: string,
  fanIn: number,
  _changeDescription?: string
): LlmChangeRiskResult {
  if (fanIn > 50) {
    return {
      risk: 'critical',
      reason: `${funcName} tiene ${fanIn} callers. Cualquier cambio puede romper muchas dependencias.`,
      affectedCallers: [],
      confidence: 'high',
    };
  }
  if (fanIn > 20) {
    return {
      risk: 'high',
      reason: `${funcName} tiene ${fanIn} callers. Riesgo alto de breaking changes.`,
      affectedCallers: [],
      confidence: 'high',
    };
  }
  if (fanIn > 5) {
    return {
      risk: 'medium',
      reason: `${funcName} tiene ${fanIn} callers. Riesgo moderado.`,
      affectedCallers: [],
      confidence: 'high',
    };
  }
  return {
    risk: 'low',
    reason: `${funcName} tiene pocos callers. Riesgo bajo.`,
    affectedCallers: [],
    confidence: 'high',
  };
}
