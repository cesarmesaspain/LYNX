/*
 * types.ts — Shared types for the LYNX API server.
 */

export interface IntelligenceRequest {
  task: 'summarize_module' | 'rerank_search' | 'assess_change_risk' | 'detect_entry_point' | 'classify_code_smell' | 'detect_test';
  license_jwt: string;
  payload: Record<string, unknown>;
}

export interface IntelligenceResponse {
  result: string;
  latency_ms: number;
  cached?: boolean;
  fallback?: boolean;
}

export interface LicenseActivateRequest {
  stripe_session_id: string;
}

export interface LicenseValidateRequest {
  license_jwt: string;
  machine_fingerprint?: string;
}

export interface TelemetryEvent {
  tool: string;
  count: number;
}

export interface TelemetryRequest {
  license_jwt: string;
  events: TelemetryEvent[];
}

export interface VersionResponse {
  latest: string;
  download_url: string;
  checksum_sha256: string;
  release_notes: string;
}
