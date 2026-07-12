/* Empty and file-scope responses for detect_changes. */

import type { LlmUsage } from '../../llm/client.js';
import type { CategorisedChanges, DetectChangesResult } from './detect_changes.js';

export const DETECT_CHANGES_CONTRACT_VERSION = 2;

export function buildEmptyResult(project: string, baseBranch: string, since: string | undefined, scope: 'files' | 'symbols', depth: number, enableLlm = true): DetectChangesResult {
  return {
    contract_version: DETECT_CHANGES_CONTRACT_VERSION,
    project,
    base_branch: baseBranch,
    since: since || null,
    scope,
    depth,
    categories: { tracked_changes: [], unstaged_changes: [], untracked_files: [], deleted_files: [], renamed_files: [] },
    category_counts: { tracked_changes: 0, unstaged_changes: 0, untracked_files: 0, deleted_files: 0, renamed_files: 0, total: 0 },
    impact_assessment: { confirmed_count: 0, probable_count: 0, nominal_count: 0, confirmed: [], probable: [], nominal: [] },
    related_dependencies: [],
    related_dependencies_count: 0,
    changed_files: [],
    changed_nodes: [],
    total_changed_files: 0,
    total_affected_nodes: 0,
    by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    indirect_callers_affected: 0,
    impact_analysis: { summary: 'No changes detected.', risk_level: 'low', details: ['No files changed.'] },
    llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: 'no changes detected' },
  };
}

export function buildFilesOnlyResult(project: string, baseBranch: string, since: string | undefined, categories: CategorisedChanges, total: number, enableLlm = true): DetectChangesResult {
  return {
    contract_version: DETECT_CHANGES_CONTRACT_VERSION,
    project,
    base_branch: baseBranch,
    since: since || null,
    scope: 'files',
    depth: 0,
    categories: {
      tracked_changes: categories.tracked_changes.map(c => ({ file: c.file, status: 'M', old_path: c.oldPath || null })),
      unstaged_changes: categories.unstaged_changes.map(c => ({ file: c.file, status: 'M (unstaged)', old_path: c.oldPath || null })),
      untracked_files: categories.untracked_files.map(c => ({ file: c.file, status: '?', old_path: null })),
      deleted_files: categories.deleted_files.map(c => ({ file: c.file, status: 'D', old_path: null })),
      renamed_files: categories.renamed_files.map(c => ({ file: c.file, status: 'R', old_path: c.oldPath || null })),
    },
    category_counts: {
      tracked_changes: categories.tracked_changes.length,
      unstaged_changes: categories.unstaged_changes.length,
      untracked_files: categories.untracked_files.length,
      deleted_files: categories.deleted_files.length,
      renamed_files: categories.renamed_files.length,
      total,
    },
    impact_assessment: { confirmed_count: 0, probable_count: 0, nominal_count: 0, confirmed: [], probable: [], nominal: [] },
    related_dependencies: [],
    related_dependencies_count: 0,
    changed_files: [],
    changed_nodes: [],
    total_changed_files: total,
    total_affected_nodes: 0,
    by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    indirect_callers_affected: 0,
    impact_analysis: { summary: `${total} files changed (scope=files).`, risk_level: 'low', details: [] },
    llm_usage: { enabled: enableLlm, used: false, provider: null, model: null, calls: 0, latency_ms: 0, fallback_used: false, fallback_reason: 'scope=files, skipped risk assessment' },
  };
}

