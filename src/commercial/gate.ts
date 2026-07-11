/*
 * gate.ts — Capability gating for LYNX license tiers.
 *
 * checkCapability(key, tier?) → { allowed, reason, capability }
 * requireCapability(key, tier?) → void (throws if not allowed)
 *
 * All gating flows through these two functions. MCP handlers,
 * CLI commands, and dashboard routes call them to enforce tier limits.
 */

import { getTier, type Tier } from './license.js';
import { getCapability, tierSatisfies } from './tiers.js';
import type { Capability } from './tiers.js';

// ── Result types ────────────────────────────────────

export interface GateResult {
  allowed: boolean;
  reason: string;
  capability: Capability | undefined;
  currentTier: Tier;
}

export class TierGateError extends Error {
  public capability: string;
  public currentTier: Tier;
  public requiredTier: Tier;

  constructor(cap: Capability, currentTier: Tier) {
    const msg = `${cap.label}: requiere tier ${cap.minTier}, tienes ${currentTier}.`;
    super(msg);
    this.name = 'TierGateError';
    this.capability = cap.key;
    this.currentTier = currentTier;
    this.requiredTier = cap.minTier;
  }
}

// ── Public API ──────────────────────────────────────

/**
 * Check if the current (or specified) tier can use a capability.
 * Returns a structured result — never throws.
 */
export function checkCapability(key: string, _tier?: Tier): GateResult {
  const currentTier = _tier ?? getTier();
  const cap = getCapability(key);

  if (!cap) {
    return {
      allowed: true, // unknown capabilities are allowed (forward compat)
      reason: `Capability "${key}" not defined — allowed by default.`,
      capability: undefined,
      currentTier,
    };
  }

  const allowed = tierSatisfies(currentTier, cap.minTier);
  const reason = allowed
    ? `OK (${currentTier} >= ${cap.minTier})`
    : `${cap.label}: requiere tier ${cap.minTier}, tienes ${currentTier}.`;

  return { allowed, reason, capability: cap, currentTier };
}

/**
 * Require a capability. Throws TierGateError if not allowed.
 * Use this at the top of handlers that need tier-gated features.
 */
export function requireCapability(key: string, _tier?: Tier): void {
  const result = checkCapability(key, _tier);
  if (!result.allowed && result.capability) {
    throw new TierGateError(result.capability, result.currentTier);
  }
}

/**
 * Check a soft capability — returns false instead of throwing.
 * For features that degrade gracefully (semantic rerank, auto-watch).
 */
export function hasCapability(key: string, _tier?: Tier): boolean {
  return checkCapability(key, _tier).allowed;
}

/**
 * Get a user-friendly message explaining what tier is needed to unlock a capability.
 */
export function upgradeMessage(key: string): string {
  const cap = getCapability(key);
  if (!cap) return '';
  if (cap.minTier === 'free') return '';
  return `Mejora a ${cap.minTier.toUpperCase()} para usar ${cap.label.toLowerCase()}.`;
}
