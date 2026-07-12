/*
 * types.ts — Shared types for the LLM module.
 */

/** Result from summarizing a module */
export interface LlmSummaryResult {
  summary: string;        // 1-line summary (locale-dependent)
  language: string;        // detected or confirmed language
  confidence: 'high' | 'medium' | 'low';
}

/** Result from detecting entry points */
export interface LlmEntryPointResult {
  isEntryPoint: boolean;
  reason: string;          // e.g. "HTTP handler", "CLI command", "public API"
  confidence: 'high' | 'medium' | 'low';
}

/** Result from detecting test files */
export interface LlmTestDetectionResult {
  isTest: boolean;
  reason: string;          // e.g. "contains describe/it blocks", "test_ prefix"
  confidence: 'high' | 'medium' | 'low';
}

/** Result from classifying code smell severity */
export interface LlmCodeSmellResult {
  category: 'tech_debt' | 'over_engineered' | 'complex_but_necessary' | 'fine';
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Result from assessing change risk */
export interface LlmChangeRiskResult {
  risk: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  affectedCallers: string[];
  confidence: 'high' | 'medium' | 'low';
}

/** Result from re-ranking search results */
export interface LlmReRankItem {
  index: number;
  relevanceScore: number;  // 0-1
  reason: string;
}

export interface LlmReRankResult {
  ranked: LlmReRankItem[];
}

/** Union of all LLM task types */
export type LlmTaskType =
  | 'summarize_module'
  | 'detect_entry_point'
  | 'detect_test'
  | 'classify_code_smell'
  | 'assess_change_risk'
  | 're_rank_search';

/** Combined LLM metadata added to extraction results */
export interface LlmFileMetadata {
  summary?: string;
  suggestedEntryPoint?: boolean;
  suggestedTestFile?: boolean;
  source: 'deepseek' | 'heuristic' | 'api';
}
