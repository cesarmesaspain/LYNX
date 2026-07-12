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
import { readLynxConfig } from '../config/runtime.js';

type Locale = 'es' | 'en';

function getLocale(): Locale {
  try { return readLynxConfig().locale; } catch { return 'en'; }
}

/** i18n strings for heuristic reasons. */
function L() {
  return getLocale() === 'en'
    ? {
        classCount: (n: number) => `${n} class(es)`,
        funcCount: (n: number) => `${n} function(s)`,
        entryMatch: (p: string) => `Path matches entry point pattern: ${p}`,
        entryNoMatch: 'Path does not match known entry point patterns',
        testMatch: (p: string) => `Path matches test pattern: ${p}`,
        testContentMatch: (imp: string) => `Code contains "${imp}" indicating testing`,
        testNoMatch: 'No test patterns detected',
        fanInCritical: (name: string, n: number) => `${name} has ${n} callers. Any change may break many dependencies.`,
        fanInHigh: (name: string, n: number) => `${name} has ${n} callers. High risk of breaking changes.`,
        fanInMedium: (name: string, n: number) => `${name} has ${n} callers. Moderate risk.`,
        fanInLow: (name: string) => `${name} has few callers. Low risk.`,
      }
    : {
        classCount: (n: number) => `${n} clase(s)`,
        funcCount: (n: number) => `${n} función(es)`,
        entryMatch: (p: string) => `La ruta coincide con el patrón de entry point: ${p}`,
        entryNoMatch: 'La ruta no coincide con patrones conocidos de entry point',
        testMatch: (p: string) => `La ruta coincide con el patrón de test: ${p}`,
        testContentMatch: (imp: string) => `El código contiene "${imp}" indicando testing`,
        testNoMatch: 'No se detectaron patrones de test',
        fanInCritical: (name: string, n: number) => `${name} tiene ${n} callers. Cualquier cambio puede romper muchas dependencias.`,
        fanInHigh: (name: string, n: number) => `${name} tiene ${n} callers. Riesgo alto de breaking changes.`,
        fanInMedium: (name: string, n: number) => `${name} tiene ${n} callers. Riesgo moderado.`,
        fanInLow: (name: string) => `${name} tiene pocos callers. Riesgo bajo.`,
      };
}

// ── Summarize module ────────────────────────────────────────

export function heuristicSummarize(
  relPath: string,
  language: string,
  nodes: LynxNode[]
): LlmSummaryResult {
  const l = L();
  const funcs = nodes.filter(n => n.kind === 'Function' || n.kind === 'Method');
  const classes = nodes.filter(n => n.kind === 'Class');
  const parts: string[] = [];
  if (classes.length > 0) parts.push(l.classCount(classes.length));
  if (funcs.length > 0) parts.push(l.funcCount(funcs.length));
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
  const l = L();
  for (const pattern of ENTRY_PATTERNS) {
    if (pattern.test(relPath)) {
      return {
        isEntryPoint: true,
        reason: l.entryMatch(String(pattern)),
        confidence: 'medium',
      };
    }
  }
  return {
    isEntryPoint: false,
    reason: l.entryNoMatch,
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
  const l = L();
  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(relPath)) {
      return {
        isTest: true,
        reason: l.testMatch(String(pattern)),
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
        reason: l.testContentMatch(imp),
        confidence: 'medium',
      };
    }
  }

  return { isTest: false, reason: l.testNoMatch, confidence: 'medium' };
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
  const l = L();
  if (fanIn > 50) {
    return {
      risk: 'critical',
      reason: l.fanInCritical(funcName, fanIn),
      affectedCallers: [],
      confidence: 'high',
    };
  }
  if (fanIn > 20) {
    return {
      risk: 'high',
      reason: l.fanInHigh(funcName, fanIn),
      affectedCallers: [],
      confidence: 'high',
    };
  }
  if (fanIn > 5) {
    return {
      risk: 'medium',
      reason: l.fanInMedium(funcName, fanIn),
      affectedCallers: [],
      confidence: 'high',
    };
  }
  return {
    risk: 'low',
    reason: l.fanInLow(funcName),
    affectedCallers: [],
    confidence: 'high',
  };
}
