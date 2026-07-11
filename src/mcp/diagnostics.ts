/*
 * diagnostics.ts — Shared diagnostic hints for MCP tool errors.
 *
 * Centralizes actionable guidance so every handler doesn't replicate
 * the same error strings. Callers wrap their error responses with these.
 */

export interface Diagnostics {
  error: string;
  hint?: string;
  recoverable?: boolean;
}

export function projectNotIndexed(project: string): Diagnostics {
  return {
    error: `Project '${project}' is not indexed`,
    hint: 'Run lynx index <project-path> or use the index_repository MCP tool to index this project',
    recoverable: true,
  };
}

export function projectStale(project: string, hours: number): Diagnostics {
  return {
    error: `Project '${project}' index is ${hours}h old (stale)`,
    hint: 'Re-index the project: lynx index <project-path> or use index_repository with mode=fast',
    recoverable: true,
  };
}

export function projectLocked(project: string, reason: string): Diagnostics {
  return {
    error: `Project '${project}' is locked: ${reason}`,
    hint: 'Wait for the current index to complete, or use force_lock=true to override a stale lock',
    recoverable: true,
  };
}

export function projectFailed(project: string, errMsg: string): Diagnostics {
  return {
    error: `Project '${project}' indexing failed: ${errMsg}`,
    hint: 'Re-run index_repository to recover. The previous failure may have been transient.',
    recoverable: true,
  };
}

export function gitRequired(project: string): Diagnostics {
  return {
    error: `Project '${project}' is not a git repository`,
    hint: 'detect_changes and assess_impact require a git working tree. Initialize git in the project root.',
    recoverable: false,
  };
}

export function noResults(query: string, kind?: string): Diagnostics {
  const scope = kind ? ` ${kind}s` : ' symbols';
  return {
    error: `No${scope} found for "${query}"`,
    hint: 'Try broader terms, check project spelling, or use name_pattern for regex matching',
    recoverable: true,
  };
}
