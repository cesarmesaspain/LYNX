/*
 * tiers.ts — Tier capability matrix for LYNX license enforcement.
 *
 * Every feature that differs by tier is declared here as a Capability.
 * Enforcement is done via checkCapability() / requireCapability() in gate.ts.
 *
 * Tiers: free < pro < team < enterprise
 * Each tier inherits all capabilities from lower tiers.
 */

import type { Tier } from './license.js';

// ── Capability definitions ──────────────────────────

export interface Capability {
  /** Unique key — used in checkCapability() calls. */
  key: string;
  /** Human-readable label for error messages. */
  label: string;
  /** Minimum tier required to use this capability. */
  minTier: Tier;
  /** Whether exceeding this limit is a hard error (vs soft warning). */
  hard: boolean;
}

// ── Free tier numeric limits ────────────────────────

export const FREE_MAX_PROJECTS = 5;
export const FREE_MAX_FILES = 50_000;

// ── Capability registry ─────────────────────────────
//
// Sorted roughly by tier. Free capabilities are listed first
// for documentation, even though they're always available.

const CAPABILITIES: Capability[] = [
  // ── Free tier (always available) ──────────────────
  {
    key: 'search_graph',
    label: 'Búsqueda en grafo de código',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'trace_path',
    label: 'Traza de llamadas',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'get_code_snippet',
    label: 'Lectura de código fuente',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'pack_context',
    label: 'Empaquetado de contexto',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'dashboard_metrics',
    label: 'Dashboard de métricas',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'dashboard_action_graph',
    label: 'Action Graph 3D',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'doctor',
    label: 'Diagnóstico (doctor)',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'install_upgrade',
    label: 'Instalación y upgrade',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'metrics_provenance',
    label: 'Métricas con procedencia',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'metrics_export',
    label: 'Export JSON/CSV de métricas',
    minTier: 'free',
    hard: true,
  },
  {
    key: 'auto_index',
    label: 'Indexación automática',
    minTier: 'free',
    hard: true,
  },

  // ── Pro tier ──────────────────────────────────────
  {
    key: 'unlimited_projects',
    label: 'Proyectos ilimitados',
    minTier: 'pro',
    hard: true,
  },
  {
    key: 'unlimited_files',
    label: 'Archivos ilimitados',
    minTier: 'pro',
    hard: true,
  },
  {
    key: 'semantic_rerank',
    label: 'Reordenamiento semántico',
    minTier: 'pro',
    hard: false, // soft: degrades to heuristic, doesn't block
  },
  {
    key: 'report_html',
    label: 'Reporte HTML',
    minTier: 'pro',
    hard: true,
  },
  {
    key: 'savings_lab',
    label: 'Savings Lab (escenarios editables)',
    minTier: 'pro',
    hard: true,
  },
  {
    key: 'auto_watch',
    label: 'Watcher automático en tiempo real',
    minTier: 'pro',
    hard: false, // soft: auto-watch degrades gracefully
  },

  // ── Team tier ─────────────────────────────────────
  {
    key: 'shared_index_read',
    label: 'Índice compartido (lectura)',
    minTier: 'team',
    hard: true,
  },
  {
    key: 'mcp_gateway',
    label: 'Gateway MCP centralizado',
    minTier: 'team',
    hard: true,
  },
  {
    key: 'multi_repo',
    label: 'Traza cross-repo',
    minTier: 'team',
    hard: false,
  },
  {
    key: 'github_gitlab_integration',
    label: 'Integración GitHub/GitLab',
    minTier: 'team',
    hard: false,
  },
  {
    key: 'roles',
    label: 'Roles (admin, member, viewer)',
    minTier: 'team',
    hard: true,
  },
  {
    key: 'team_dashboard',
    label: 'Dashboard de equipo',
    minTier: 'team',
    hard: false,
  },
  {
    key: 'cross_repo_dedup',
    label: 'Deduplicación cross-repo',
    minTier: 'team',
    hard: false,
  },
  {
    key: 'basic_audit',
    label: 'Auditoría básica',
    minTier: 'team',
    hard: false,
  },

  // ── Enterprise tier ───────────────────────────────
  {
    key: 'sso',
    label: 'SSO (SAML/OIDC)',
    minTier: 'enterprise',
    hard: true,
  },
  {
    key: 'rbac_per_repo',
    label: 'Permisos por repositorio (RBAC)',
    minTier: 'enterprise',
    hard: true,
  },
  {
    key: 'private_deployment',
    label: 'Despliegue privado (VPC)',
    minTier: 'enterprise',
    hard: false,
  },
  {
    key: 'full_audit',
    label: 'Auditoría completa (SIEM)',
    minTier: 'enterprise',
    hard: false,
  },
  {
    key: 'sla_995',
    label: 'SLA 99.5%',
    minTier: 'enterprise',
    hard: false,
  },
  {
    key: 'shared_index_write',
    label: 'Índice compartido (lectura/escritura)',
    minTier: 'enterprise',
    hard: true,
  },
];

// ── Indexed lookup ──────────────────────────────────

const CAP_MAP = new Map<string, Capability>();
for (const c of CAPABILITIES) {
  CAP_MAP.set(c.key, c);
}

// ── Tier ordering ───────────────────────────────────

const TIER_ORDER: Record<Tier, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

// ── Public API ──────────────────────────────────────

/** Get the Capability definition for a given key. */
export function getCapability(key: string): Capability | undefined {
  return CAP_MAP.get(key);
}

/** List all capability keys. */
export function listCapabilities(): string[] {
  return CAPABILITIES.map(c => c.key);
}

/** List capabilities available at a given tier. */
export function capabilitiesForTier(tier: Tier): Capability[] {
  const min = TIER_ORDER[tier];
  return CAPABILITIES.filter(c => TIER_ORDER[c.minTier] <= min);
}

/** Check if a tier satisfies a capability's minTier. */
export function tierSatisfies(userTier: Tier, requiredTier: Tier): boolean {
  return TIER_ORDER[userTier] >= TIER_ORDER[requiredTier];
}

/** Get the numeric project limit for a tier. */
export function maxProjectsForTier(tier: Tier): number {
  if (tier === 'free') return FREE_MAX_PROJECTS;
  return Infinity;
}

/** Get the numeric file limit for a tier. */
export function maxFilesForTier(tier: Tier): number {
  if (tier === 'free') return FREE_MAX_FILES;
  return Infinity;
}
