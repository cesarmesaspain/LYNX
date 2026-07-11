import { describe, expect, it } from 'vitest';
import {
  getCapability,
  listCapabilities,
  capabilitiesForTier,
  tierSatisfies,
  maxProjectsForTier,
  maxFilesForTier,
} from '../../../src/commercial/tiers.js';
import type { Tier } from '../../../src/commercial/license.js';

describe('tier capability matrix', () => {
  it('all capabilities have valid keys and labels', () => {
    const keys = listCapabilities();
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const cap = getCapability(key);
      expect(cap).toBeDefined();
      expect(cap!.key).toBe(key);
      expect(cap!.label.length).toBeGreaterThan(0);
      expect(['free', 'pro', 'team', 'enterprise']).toContain(cap!.minTier);
    }
  });

  it('free tier capabilities are all available to free', () => {
    const freeCaps = capabilitiesForTier('free');
    const keys = freeCaps.map(c => c.key);
    // Core tools must be available
    expect(keys).toContain('search_graph');
    expect(keys).toContain('trace_path');
    expect(keys).toContain('pack_context');
    expect(keys).toContain('doctor');
    expect(keys).toContain('auto_index');
    // Pro+ capabilities must NOT be available
    expect(keys).not.toContain('semantic_rerank');
    expect(keys).not.toContain('report_html');
    expect(keys).not.toContain('savings_lab');
    expect(keys).not.toContain('auto_watch');
    expect(keys).not.toContain('mcp_gateway');
  });

  it('pro tier includes all free capabilities plus pro exclusives', () => {
    const proCaps = capabilitiesForTier('pro');
    const keys = proCaps.map(c => c.key);
    expect(keys).toContain('search_graph');
    expect(keys).toContain('semantic_rerank');
    expect(keys).toContain('report_html');
    expect(keys).toContain('savings_lab');
    expect(keys).toContain('auto_watch');
    expect(keys).toContain('unlimited_projects');
    // Team+ exclusives must NOT be in pro
    expect(keys).not.toContain('mcp_gateway');
    expect(keys).not.toContain('shared_index_read');
    expect(keys).not.toContain('sso');
  });

  it('team tier includes free + pro + team exclusives', () => {
    const teamCaps = capabilitiesForTier('team');
    const keys = teamCaps.map(c => c.key);
    expect(keys).toContain('semantic_rerank');
    expect(keys).toContain('mcp_gateway');
    expect(keys).toContain('shared_index_read');
    expect(keys).toContain('roles');
    expect(keys).toContain('github_gitlab_integration');
    // Enterprise exclusives must NOT be in team
    expect(keys).not.toContain('sso');
    expect(keys).not.toContain('shared_index_write');
  });

  it('enterprise tier includes everything', () => {
    const entCaps = capabilitiesForTier('enterprise');
    const keys = entCaps.map(c => c.key);
    expect(keys).toContain('sso');
    expect(keys).toContain('rbac_per_repo');
    expect(keys).toContain('private_deployment');
    expect(keys).toContain('full_audit');
    expect(keys).toContain('shared_index_write');
    expect(keys).toContain('semantic_rerank'); // inherited
  });

  it('tierSatisfies is transitive', () => {
    const tiers: Tier[] = ['free', 'pro', 'team', 'enterprise'];
    for (let i = 0; i < tiers.length; i++) {
      for (let j = 0; j < tiers.length; j++) {
        expect(tierSatisfies(tiers[i], tiers[j])).toBe(i >= j);
      }
    }
  });

  it('free tier has correct numeric limits', () => {
    expect(maxProjectsForTier('free')).toBe(5);
    expect(maxFilesForTier('free')).toBe(50_000);
  });

  it('non-free tiers have unlimited limits', () => {
    for (const tier of ['pro', 'team', 'enterprise'] as Tier[]) {
      expect(maxProjectsForTier(tier)).toBe(Infinity);
      expect(maxFilesForTier(tier)).toBe(Infinity);
    }
  });

  it('semantic_rerank is a soft capability (hard=false)', () => {
    const cap = getCapability('semantic_rerank');
    expect(cap).toBeDefined();
    expect(cap!.hard).toBe(false);
  });

  it('auto_watch is a soft capability (hard=false)', () => {
    const cap = getCapability('auto_watch');
    expect(cap).toBeDefined();
    expect(cap!.hard).toBe(false);
  });

  it('search_graph is a hard capability (hard=true)', () => {
    const cap = getCapability('search_graph');
    expect(cap).toBeDefined();
    expect(cap!.hard).toBe(true);
  });
});
