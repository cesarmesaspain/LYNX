/*
 * handler-bridge.ts — Injectable federated config for handler → gateway wiring.
 *
 * This is NOT a global singleton. Config is set explicitly via setFederatedConfig()
 * before the MCP server starts. Without it, handlers use pure local cores directly
 * (zero overhead, identical to pre-federation behavior).
 *
 * Usage:
 *   import { setFederatedConfig } from '../federation/handler-bridge.js';
 *   setFederatedConfig({ localProvider, sharedProvider, authorizer, ... });
 */

import type { FederatedGatewayConfig } from './types.js';

let _config: FederatedGatewayConfig | null = null;

/** Inject federated config. Call once before MCP server starts. Idempotent. */
export function setFederatedConfig(config: FederatedGatewayConfig): void {
  _config = config;
}

/** Clear federated config (for testing). */
export function clearFederatedConfig(): void {
  _config = null;
}

/** Read current config. Returns null if federation is not active. */
export function getFederatedConfig(): FederatedGatewayConfig | null {
  return _config;
}
