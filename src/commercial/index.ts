/*
 * commercial/index.ts — LYNX commercial layer public API.
 *
 * Fase 7: JWT license validation, tier gating, Stripe billing, ROI calculator.
 */

// License
export {
  readLicense,
  saveLicense,
  getTier,
  isProOrBetter,
  isFreeTier,
  getMachineFingerprint,
  refreshLicense,
  validateOnline,
  login,
  sendTelemetry,
  getTierLimit,
  licenseStatusString,
} from './license.js';
export type { LicenseInfo, Tier } from './license.js';

// Tier capability matrix
export {
  getCapability,
  listCapabilities,
  capabilitiesForTier,
  tierSatisfies,
  maxProjectsForTier,
  maxFilesForTier,
  FREE_MAX_PROJECTS,
  FREE_MAX_FILES,
} from './tiers.js';
export type { Capability } from './tiers.js';

// Gate enforcement
export {
  checkCapability,
  requireCapability,
  hasCapability,
  upgradeMessage,
  TierGateError,
} from './gate.js';
export type { GateResult } from './gate.js';

// Stripe billing
export {
  createCheckoutSession,
  createBillingPortalSession,
  handleWebhook,
  isStripeConfigured,
  getPriceId,
} from './stripe.js';
export type { CheckoutResult, WebhookEvent } from './stripe.js';

// ROI calculator
export {
  computeRoi,
  defaultInputs,
  formatRoiAsMarkdown,
} from './roi-calculator.js';
export type { RoiInputs, RoiOutput, RoiBreakdown, BreakevenAnalysis } from './roi-calculator.js';

// Provider intelligence API
export {
  apiSummarize,
  apiDetectEntryPoint,
  apiDetectTest,
  apiClassifyCodeSmell,
  apiAssessChangeRisk,
  apiReRank,
} from './provider-intelligence-api.js';
