/*
 * auth.ts — Authorization abstractions for federated gateway.
 *
 * Authorizer checks whether a caller may access results from a shared provider.
 * NoopAuthorizer allows everything (default when Team is not configured).
 */

import type { Authorizer, AuthResult } from './types.js';

/**
 * NoopAuthorizer — allows all shared access.
 *
 * Used when no Team configuration is present.
 * authorizeProject always returns allowed=true.
 * filterResult always returns the result unchanged.
 */
export class NoopAuthorizer implements Authorizer {
  authorizeProject(_project: string): AuthResult {
    return { allowed: true };
  }

  filterResult<T extends { file_path?: string }>(result: T, _project: string): T | null {
    return result;
  }
}

/**
 * DenyAllAuthorizer — denies all shared access.
 *
 * Used for testing authorization-denied scenarios.
 */
export class DenyAllAuthorizer implements Authorizer {
  readonly reason: string;

  constructor(reason = 'access denied') {
    this.reason = reason;
  }

  authorizeProject(_project: string): AuthResult {
    return { allowed: false, reason: this.reason };
  }

  filterResult<T extends { file_path?: string }>(_result: T, _project: string): T | null {
    return null;
  }
}
