import { describe, expect, it } from 'vitest';
import {
  checkCapability,
  requireCapability,
  hasCapability,
  upgradeMessage,
  TierGateError,
} from '../../../src/commercial/gate.js';
import type { Tier } from '../../../src/commercial/license.js';

describe('capability gating', () => {
  describe('checkCapability', () => {
    it('allows free capabilities for free tier', () => {
      const result = checkCapability('search_graph', 'free');
      expect(result.allowed).toBe(true);
      expect(result.currentTier).toBe('free');
    });

    it('allows free capabilities for any tier', () => {
      for (const tier of ['free', 'pro', 'team', 'enterprise'] as Tier[]) {
        expect(checkCapability('pack_context', tier).allowed).toBe(true);
      }
    });

    it('denies pro capability for free tier', () => {
      const result = checkCapability('semantic_rerank', 'free');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('free');
      expect(result.reason).toContain('pro');
    });

    it('allows pro capability for pro tier', () => {
      expect(checkCapability('semantic_rerank', 'pro').allowed).toBe(true);
      expect(checkCapability('report_html', 'pro').allowed).toBe(true);
    });

    it('allows team capability for team tier', () => {
      expect(checkCapability('mcp_gateway', 'team').allowed).toBe(true);
      expect(checkCapability('shared_index_read', 'team').allowed).toBe(true);
    });

    it('denies team capability for pro tier', () => {
      expect(checkCapability('mcp_gateway', 'pro').allowed).toBe(false);
    });

    it('allows enterprise capability for enterprise tier', () => {
      expect(checkCapability('sso', 'enterprise').allowed).toBe(true);
      expect(checkCapability('rbac_per_repo', 'enterprise').allowed).toBe(true);
    });

    it('unknown capabilities are allowed (forward compat)', () => {
      const result = checkCapability('future_feature_v2', 'free');
      expect(result.allowed).toBe(true);
      expect(result.capability).toBeUndefined();
    });

    it('enterprise tier can use everything', () => {
      // Spot-check: enterprise should allow all defined capabilities
      expect(checkCapability('search_graph', 'enterprise').allowed).toBe(true);
      expect(checkCapability('semantic_rerank', 'enterprise').allowed).toBe(true);
      expect(checkCapability('mcp_gateway', 'enterprise').allowed).toBe(true);
      expect(checkCapability('sso', 'enterprise').allowed).toBe(true);
    });
  });

  describe('requireCapability', () => {
    it('does not throw for allowed capabilities', () => {
      expect(() => requireCapability('search_graph', 'free')).not.toThrow();
      expect(() => requireCapability('semantic_rerank', 'pro')).not.toThrow();
      expect(() => requireCapability('sso', 'enterprise')).not.toThrow();
    });

    it('throws TierGateError for denied capabilities', () => {
      expect(() => requireCapability('semantic_rerank', 'free')).toThrow(TierGateError);
    });

    it('TierGateError contains structured info', () => {
      try {
        requireCapability('mcp_gateway', 'free');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TierGateError);
        const err = e as TierGateError;
        expect(err.capability).toBe('mcp_gateway');
        expect(err.currentTier).toBe('free');
        expect(err.requiredTier).toBe('team');
        expect(err.message).toContain('team');
        expect(err.message).toContain('free');
      }
    });

    it('does not throw for unknown capabilities', () => {
      expect(() => requireCapability('unknown_feature', 'free')).not.toThrow();
    });
  });

  describe('hasCapability', () => {
    it('returns boolean', () => {
      expect(hasCapability('search_graph', 'free')).toBe(true);
      expect(hasCapability('semantic_rerank', 'free')).toBe(false);
      expect(hasCapability('semantic_rerank', 'pro')).toBe(true);
    });

    it('works for soft capabilities (auto_watch)', () => {
      expect(hasCapability('auto_watch', 'free')).toBe(false);
      expect(hasCapability('auto_watch', 'pro')).toBe(true);
    });

    it('works for hard capabilities (mcp_gateway)', () => {
      expect(hasCapability('mcp_gateway', 'free')).toBe(false);
      expect(hasCapability('mcp_gateway', 'team')).toBe(true);
    });
  });

  describe('upgradeMessage', () => {
    it('returns empty for free-tier capabilities', () => {
      expect(upgradeMessage('search_graph')).toBe('');
    });

    it('returns upgrade message for gated capabilities', () => {
      const msg = upgradeMessage('semantic_rerank');
      expect(msg).toContain('PRO');
      expect(msg).toContain('reordenamiento');
    });

    it('returns empty for unknown capabilities', () => {
      expect(upgradeMessage('nonexistent')).toBe('');
    });
  });

  describe('tier inheritance', () => {
    it('team inherits all pro capabilities', () => {
      const proGated = ['semantic_rerank', 'report_html', 'savings_lab', 'auto_watch'];
      for (const key of proGated) {
        expect(hasCapability(key, 'team'), `${key} should be allowed for team`).toBe(true);
      }
    });

    it('enterprise inherits all team capabilities', () => {
      const teamGated = ['mcp_gateway', 'shared_index_read', 'roles'];
      for (const key of teamGated) {
        expect(hasCapability(key, 'enterprise'), `${key} should be allowed for enterprise`).toBe(true);
      }
    });
  });
});
