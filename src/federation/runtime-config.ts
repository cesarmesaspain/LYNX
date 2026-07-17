/*
 * runtime-config.ts — Product wiring for read-only Team federation.
 */

import type { LynxRuntimeConfig } from "../config/runtime.js";
import { NoopAuthorizer } from "./auth.js";
import { clearFederatedConfig, setFederatedConfig } from "./handler-bridge.js";
import { HttpSharedIndexProvider } from "./http-shared-provider.js";
import { LocalIndexProvider } from "./providers.js";

/**
 * Configure the handler federation bridge from normalized runtime settings.
 * Returns true when Team federation is active.
 */
export function configureFederationFromRuntime(
  config: LynxRuntimeConfig,
): boolean {
  const team = config.team_backend;
  if (!team?.enabled || !team.base_url) {
    clearFederatedConfig();
    return false;
  }

  let teamName: string;
  try {
    teamName = new URL(team.base_url).host || "team";
  } catch {
    clearFederatedConfig();
    return false;
  }

  setFederatedConfig({
    teamName,
    localProvider: new LocalIndexProvider(),
    sharedProvider: new HttpSharedIndexProvider({
      baseUrl: team.base_url,
      accessToken: team.access_token,
      timeoutMs: team.timeout_ms,
    }),
    authorizer: new NoopAuthorizer(),
    sharedTimeoutMs: team.timeout_ms,
  });
  return true;
}
