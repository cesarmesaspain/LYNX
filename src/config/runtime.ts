/*
 * runtime.ts — LYNX local runtime configuration.
 *
 * Stored outside projects so MCP startup behavior is consistent across agents.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
};

export function lynxHome(): string {
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
  const next = { ...readLynxConfig(), ...values };
  writeLynxConfig(next);
  return next;
}
