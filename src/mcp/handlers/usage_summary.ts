/*
 * usage_summary.ts — Read-only local usage roll-up for MCP clients.
 *
 * Keeps the dashboard and an agent on the same accounting source without
 * pretending that estimated savings are billed usage.
 */

import { summarizeUsage } from '../../usage/metrics.js';

function optionalProject(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1_000;
  return Math.max(1, Math.min(10_000, Math.floor(parsed)));
}

export async function handleUsageSummary(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const project = optionalProject(args.project);
  const limit = boundedLimit(args.limit);
  const summary = summarizeUsage(project, limit);

  return {
    scope: project ? { project } : { project: 'all_projects' },
    sampled_events_limit: limit,
    ...summary,
    interpretation: {
      tokens_saved: 'Estimated avoided exploration context; not provider billing or a guarantee.',
      files_avoided: 'Estimated avoided reads, deduplicated where an event supplied file evidence.',
      structural_confidence: 'Inspect each tool result for graph evidence and ambiguity details.',
      local_only: true,
    },
  };
}
