/*
 * runtime.ts — LYNX local runtime configuration.
 *
 * Stored outside projects so MCP startup behavior is consistent across agents.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type PricingConfig, defaultPricingConfig } from '../usage/provenance.js';

export interface LynxRuntimeConfig {
  auto_index: boolean;
  auto_index_limit: number;
  auto_watch: boolean;
  auto_dashboard: boolean;
  /** Hours after which an index is considered stale (default 24). */
  stale_threshold_hours: number;
  /** Minutes after which a lock file is considered stale and broken (default 5). */
  lock_ttl_minutes: number;
  /** UI and generated-brief language, detected during installation. */
  locale: 'es' | 'en';
  /** Agent response verbosity and style preferences injected by LYNX. */
  agent_response?: {
    enabled: boolean;
    length: 'short' | 'medium' | 'long';
    style: 'concise' | 'balanced' | 'detailed';
    /** Controls how aggressively LYNX asks agents to conserve output tokens. */
    budget: 'max_savings' | 'balanced' | 'thorough';
    reminder_interval_minutes: number;
  };
  /** Optional LLM enrichment for cached architecture briefs. Off keeps reindexing local. */
  project_brief?: {
    llm_enrichment: boolean;
  };
  /** Optional low-cost LLM arbitration for genuinely ambiguous tool results. */
  decision_llm?: {
    mode: 'off' | 'conservative' | 'adaptive';
    max_calls_per_hour: number;
  };
  /** MCP registry breadth. Core reduces client startup context; full keeps every tool visible. */
  mcp_tool_profile?: 'full' | 'core';
  agent_policy?: Record<string, unknown>;
  /** API keys for LLM providers. Stored alongside runtime config. Env vars take priority. */
  api_keys?: {
    deepseek?: string;
    vps_url?: string;
    vps_key?: string;
  };
  /** Configurable pricing for token/cost estimation. null = use built-in defaults. */
  pricing?: import('../usage/provenance.js').PricingConfig | null;
  /**
   * Explicit project name aliases for normalization.
   * Keys are canonical names, values are arrays of known alternate spellings/cases.
   * Example: { "LYNX-authoritative": ["lynx-authoritative"] }
   * No auto-merge — every alias must be explicitly configured.
   */
  project_aliases?: Record<string, string[]>;
}

export function detectSystemLocale(): 'es' | 'en' {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  return locale.startsWith('es') ? 'es' : 'en';
}

const DEFAULT_CONFIG: LynxRuntimeConfig = {
  auto_index: true,
  auto_index_limit: 50_000,
  auto_watch: true,
  auto_dashboard: true,
  stale_threshold_hours: 24,
  lock_ttl_minutes: 5,
  locale: detectSystemLocale(),
  agent_response: { enabled: false, length: 'short', style: 'concise', budget: 'balanced', reminder_interval_minutes: 30 },
  project_brief: { llm_enrichment: false },
  decision_llm: { mode: 'off', max_calls_per_hour: 10 },
  mcp_tool_profile: 'full',
};

/**
 * Per-async-operation home override. This avoids mutating process.env when a
 * workflow needs isolated storage (for example, benchmarks running in
 * parallel with the MCP server or another benchmark).
 */
const lynxHomeContext = new AsyncLocalStorage<string>();

export function withLynxHome<T>(home: string, run: () => T): T {
  return lynxHomeContext.run(home, run);
}

export function lynxHome(): string {
  const scopedHome = lynxHomeContext.getStore();
  if (scopedHome) return scopedHome;
  if (process.env.LYNX_HOME) return process.env.LYNX_HOME;
  return path.join(os.homedir(), '.lynx');
}

export function lynxConfigPath(): string {
  return path.join(lynxHome(), 'config.json');
}

export function readLynxConfig(): LynxRuntimeConfig {
  const filePath = lynxConfigPath();
  if (!fs.existsSync(filePath)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    return {
      auto_index: typeof raw.auto_index === 'boolean' ? raw.auto_index : DEFAULT_CONFIG.auto_index,
      auto_index_limit: typeof raw.auto_index_limit === 'number'
        ? raw.auto_index_limit
        : DEFAULT_CONFIG.auto_index_limit,
      auto_watch: typeof raw.auto_watch === 'boolean' ? raw.auto_watch : DEFAULT_CONFIG.auto_watch,
      auto_dashboard: typeof raw.auto_dashboard === 'boolean' ? raw.auto_dashboard : DEFAULT_CONFIG.auto_dashboard,
      stale_threshold_hours: typeof raw.stale_threshold_hours === 'number'
        ? raw.stale_threshold_hours
        : DEFAULT_CONFIG.stale_threshold_hours,
      lock_ttl_minutes: typeof raw.lock_ttl_minutes === 'number'
        ? raw.lock_ttl_minutes
        : DEFAULT_CONFIG.lock_ttl_minutes,
      locale: raw.locale === 'es' || raw.locale === 'en' ? (raw.locale as 'es' | 'en') : DEFAULT_CONFIG.locale,
      agent_response: raw.agent_response && typeof raw.agent_response === 'object' ? raw.agent_response as LynxRuntimeConfig['agent_response'] : DEFAULT_CONFIG.agent_response,
      project_brief: raw.project_brief && typeof raw.project_brief === 'object' ? {
        llm_enrichment: (raw.project_brief as Record<string, unknown>).llm_enrichment === true,
      } : DEFAULT_CONFIG.project_brief,
      decision_llm: raw.decision_llm && typeof raw.decision_llm === 'object' ? {
        mode: ['off', 'conservative', 'adaptive'].includes(String((raw.decision_llm as Record<string, unknown>).mode))
          ? (raw.decision_llm as { mode: 'off' | 'conservative' | 'adaptive' }).mode
          : 'off',
        max_calls_per_hour: Math.max(0, Math.min(1000, Number((raw.decision_llm as Record<string, unknown>).max_calls_per_hour) || 10)),
      } : DEFAULT_CONFIG.decision_llm,
      mcp_tool_profile: raw.mcp_tool_profile === 'core' || raw.mcp_tool_profile === 'full'
        ? raw.mcp_tool_profile
        : DEFAULT_CONFIG.mcp_tool_profile,
      project_aliases: raw.project_aliases && typeof raw.project_aliases === 'object'
        ? Object.fromEntries(Object.entries(raw.project_aliases as Record<string, unknown>)
          .filter(([, aliases]) => Array.isArray(aliases) && aliases.every(alias => typeof alias === 'string'))
          .map(([canonical, aliases]) => [canonical, aliases as string[]]))
        : undefined,
      api_keys: raw.api_keys && typeof raw.api_keys === 'object' ? {
        deepseek: typeof (raw.api_keys as Record<string,unknown>).deepseek === 'string' ? (raw.api_keys as Record<string,unknown>).deepseek as string : undefined,
        vps_url: typeof (raw.api_keys as Record<string,unknown>).vps_url === 'string' ? (raw.api_keys as Record<string,unknown>).vps_url as string : undefined,
        vps_key: typeof (raw.api_keys as Record<string,unknown>).vps_key === 'string' ? (raw.api_keys as Record<string,unknown>).vps_key as string : undefined,
      } : undefined,
      pricing: raw.pricing != null ? (raw.pricing as PricingConfig) : undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Get the active pricing config (user-configured or default). */
export function getPricingConfig(): PricingConfig {
  const cfg = readLynxConfig();
  if (cfg.pricing?.version === 1) {
    return cfg.pricing;
  }
  return defaultPricingConfig();
}

/** Resolve a project name to its canonical form via explicit alias map.
 *  Returns the canonical name if the input matches a known alias, or the input unchanged.
 *  No auto-merge or fuzzy matching — every alias must be explicitly configured. */
export function resolveProjectAlias(name: string): string {
  const cfg = readLynxConfig();
  const aliases = cfg.project_aliases;
  if (!aliases) return name;
  // Direct match on canonical key
  if (aliases[name] !== undefined) return name;
  // Check if this name is a known alias
  for (const [canonical, alts] of Object.entries(aliases)) {
    if (alts.includes(name)) return canonical;
  }
  return name;
}

/** Get the full alias map for inspection. */
export function getProjectAliases(): Record<string, string[]> {
  const cfg = readLynxConfig();
  return cfg.project_aliases || {};
}

export function writeLynxConfig(config: LynxRuntimeConfig): void {
  const dir = lynxHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = lynxConfigPath();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

export function upsertLynxConfig(values: Partial<LynxRuntimeConfig>): LynxRuntimeConfig {
  const current = readLynxConfig();
  const next: LynxRuntimeConfig = {
    ...current,
    ...values,
    ...(values.agent_response ? { agent_response: { ...current.agent_response, ...values.agent_response } } : {}),
    ...(values.project_brief ? { project_brief: { ...current.project_brief, ...values.project_brief } } : {}),
    ...(values.decision_llm ? { decision_llm: { ...current.decision_llm, ...values.decision_llm } } : {}),
    ...(values.api_keys ? { api_keys: { ...current.api_keys, ...values.api_keys } } : {}),
  };
  writeLynxConfig(next);
  return next;
}

/** Read a configured API key. Env vars are NOT checked — callers combine this with env. */
export function getConfiguredApiKey(provider: 'deepseek' | 'vps_url' | 'vps_key'): string | null {
  const cfg = readLynxConfig();
  const keys = cfg.api_keys;
  if (!keys) return null;
  if (provider === 'deepseek') return keys.deepseek?.trim() || null;
  if (provider === 'vps_url') return keys.vps_url?.trim() || null;
  if (provider === 'vps_key') return keys.vps_key?.trim() || null;
  return null;
}

/** Mask an API key for display — keep last 4 chars, e.g. "sk-...****abcd". */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...****' + key.slice(-4);
}

/** Deep-clone the config but mask api_keys values for safe display. */
export function readLynxConfigSafe(): LynxRuntimeConfig {
  const cfg = readLynxConfig();
  if (!cfg.api_keys) return cfg;
  const masked = { ...cfg.api_keys };
  if (masked.deepseek) masked.deepseek = maskApiKey(masked.deepseek);
  if (masked.vps_key) masked.vps_key = maskApiKey(masked.vps_key);
  return { ...cfg, api_keys: masked };
}
