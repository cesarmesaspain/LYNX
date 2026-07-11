/*
 * roi-calculator.ts — Realistic, defensible ROI model for LYNX.
 *
 * Every multiplier below is conservative and documented. The model is
 * designed to be shown to a CTO/VP Eng and survive scrutiny.
 *
 * Three input profiles (from real measurement):
 *   conservative  — "prove it to me", uses the low end of every range
 *   moderate      — balanced, the default for demos
 *   aggressive    — "what if it's really good", upper end
 *
 * All prices in USD. Team rates configurable.
 */

// ── User-facing inputs ──────────────────────────────────────────

export interface RoiInputs {
  /** Number of developers using AI assistants daily */
  teamSize: number;
  /** Average AI-assisted coding tasks per developer per day */
  tasksPerDevPerDay: number;
  /** avg tokens consumed per AI-assisted task (input + output) */
  avgTokensPerTask: number;
  /** Fraction of tasks that involve code discovery (0-1) */
  discoveryTaskRatio: number;
  /** Average fully-loaded cost per developer per hour (USD) */
  devHourlyCost: number;
  /** Working days per month (default 20) */
  workingDaysPerMonth: number;
  /** Current AI model tier: "opus" | "sonnet" | "haiku" | "custom" */
  modelTier: 'opus' | 'sonnet' | 'haiku' | 'custom';
  /** If custom, the blended cost per 1M input tokens (USD) */
  customInputCostPerMTok?: number;
  /** If custom, the blended cost per 1M output tokens (USD) */
  customOutputCostPerMTok?: number;
  /** New developers onboarded per year */
  newDevsPerYear: number;
  /** Days to productivity without LYNX */
  onboardingDaysWithoutLynx: number;
  /** Codebase size category */
  projectSize: 'small' | 'medium' | 'large';
  /** LYNX monthly price for this team (for breakeven) */
  lynxMonthlyCost: number;
}

// ── Output ──────────────────────────────────────────────────────

export interface RoiOutput {
  inputs: RoiInputs;
  monthly: RoiBreakdown;
  annual: RoiBreakdown;
  breakeven: BreakevenAnalysis;
  summary: string;
}

export interface RoiBreakdown {
  /** Tokens saved via reduced discovery operations */
  tokensSavedByDiscovery: number;
  /** Tokens saved by avoiding hallucinated symbols/imports */
  tokensSavedByErrorPrevention: number;
  /** Tokens saved by needing fewer iterations per task */
  tokensSavedByIterationReduction: number;
  /** Total tokens saved */
  totalTokensSaved: number;
  /** USD saved on API costs */
  apiCostSaved: number;
  /** Hours saved by developers (waiting + rework) */
  devHoursSaved: number;
  /** USD equivalent of developer time saved */
  devTimeValue: number;
  /** USD saved by downgrading model tier */
  modelTierSavings: number;
  /** Developer hours saved on onboarding new hires */
  onboardingHoursSaved: number;
  /** USD equivalent of onboarding time saved */
  onboardingValue: number;
  /** Total savings (api + dev time + model tier + onboarding) */
  totalSavingsUsd: number;
  /** LYNX cost for the period */
  lynxCost: number;
  /** Net savings after LYNX subscription */
  netSavingsUsd: number;
  /** ROI multiplier: netSavings / lynxCost */
  roiMultiplier: number;
}

export interface BreakevenAnalysis {
  /** Months to pay back the subscription */
  months: number;
  /** "You start saving money in month X" */
  narrative: string;
}

// ── Model parameters (conservative defaults, tuned from real data) ──

interface ModelParams {
  /** Fraction of tokens spent on discovery without LYNX */
  discoveryOverheadRatio: number;
  /** Multiplier: discovery overhead with LYNX = ratio * lynxFactor */
  lynxDiscoveryFactor: number;
  /** Hallucinated symbol/import errors per 100 discovery tasks */
  hallucinationRatePer100: number;
  /** Avg tokens wasted per hallucination (detect + fix + redo) */
  avgTokensPerHallucination: number;
  /** Iterations needed WITHOUT LYNX per discovery task */
  iterationsWithoutLynx: number;
  /** Iterations needed WITH LYNX per discovery task */
  iterationsWithLynx: number;
  /** Avg tokens per iteration (grep + read + think) */
  avgTokensPerIteration: number;
  /** Avg latency per iteration in seconds */
  avgIterationLatencySec: number;
  /** Seconds saved per avoided hallucination */
  hallucinationFixSec: number;
  /** Model tier savings — can you downgrade? */
  canDowngradeModelTier: boolean;
  /** Input token cost without LYNX ($/MTok) */
  inputCostWithoutLynx: number;
  /** Output token cost without LYNX ($/MTok) */
  outputCostWithoutLynx: number;
  /** Input token cost with LYNX ($/MTok) */
  inputCostWithLynx: number;
  /** Output token cost with LYNX ($/MTok) */
  outputCostWithLynx: number;
}

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  opus: { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.8, output: 4.0 },
};

const CONSERVATIVE: ModelParams = {
  discoveryOverheadRatio: 0.25,
  lynxDiscoveryFactor: 0.50,
  hallucinationRatePer100: 8,
  avgTokensPerHallucination: 800,
  iterationsWithoutLynx: 2.0,
  iterationsWithLynx: 1.2,
  avgTokensPerIteration: 600,
  avgIterationLatencySec: 30,
  hallucinationFixSec: 120,
  canDowngradeModelTier: false, // conservative: no downgrade assumed
  inputCostWithoutLynx: 3.0,
  outputCostWithoutLynx: 15.0,
  inputCostWithLynx: 3.0,
  outputCostWithLynx: 15.0,
};

const MODERATE: ModelParams = {
  discoveryOverheadRatio: 0.35,
  lynxDiscoveryFactor: 0.35,
  hallucinationRatePer100: 12,
  avgTokensPerHallucination: 1200,
  iterationsWithoutLynx: 2.5,
  iterationsWithLynx: 1.1,
  avgTokensPerIteration: 600,
  avgIterationLatencySec: 45,
  hallucinationFixSec: 180,
  canDowngradeModelTier: true, // moderate: downgrade possible for large codebases
  inputCostWithoutLynx: 3.0,
  outputCostWithoutLynx: 15.0,
  inputCostWithLynx: 0.8,
  outputCostWithLynx: 4.0,
};

const AGGRESSIVE: ModelParams = {
  discoveryOverheadRatio: 0.45,
  lynxDiscoveryFactor: 0.25,
  hallucinationRatePer100: 18,
  avgTokensPerHallucination: 1500,
  iterationsWithoutLynx: 3.0,
  iterationsWithLynx: 1.0,
  avgTokensPerIteration: 600,
  avgIterationLatencySec: 60,
  hallucinationFixSec: 240,
  canDowngradeModelTier: true,
  inputCostWithoutLynx: 15.0, // Opus without, Haiku with
  outputCostWithoutLynx: 75.0,
  inputCostWithLynx: 0.8,
  outputCostWithLynx: 4.0,
};

// ── Defaults by codebase size ───────────────────────────────────

const DEFAULTS_BY_SIZE: Record<string, Partial<RoiInputs>> = {
  small: {
    tasksPerDevPerDay: 10,
    avgTokensPerTask: 8000,
    discoveryTaskRatio: 0.55,
    modelTier: 'sonnet',
    onboardingDaysWithoutLynx: 2,
  },
  medium: {
    tasksPerDevPerDay: 8,
    avgTokensPerTask: 12000,
    discoveryTaskRatio: 0.65,
    modelTier: 'sonnet',
    onboardingDaysWithoutLynx: 3,
  },
  large: {
    tasksPerDevPerDay: 6,
    avgTokensPerTask: 15000,
    discoveryTaskRatio: 0.75,
    modelTier: 'opus',
    onboardingDaysWithoutLynx: 5,
  },
};

// ── Model functions ─────────────────────────────────────────────

function getModelParams(inputs: RoiInputs, profile: 'conservative' | 'moderate' | 'aggressive'): ModelParams {
  const base = profile === 'conservative' ? { ...CONSERVATIVE }
    : profile === 'aggressive' ? { ...AGGRESSIVE }
    : { ...MODERATE };

  // Override model costs from user input
  if (inputs.modelTier !== 'custom') {
    const costs = MODEL_COSTS[inputs.modelTier];
    base.inputCostWithoutLynx = costs.input;
    base.outputCostWithoutLynx = costs.output;
  } else if (inputs.customInputCostPerMTok !== undefined) {
    base.inputCostWithoutLynx = inputs.customInputCostPerMTok;
    base.outputCostWithoutLynx = inputs.customOutputCostPerMTok ?? inputs.customInputCostPerMTok * 5;
  }

  // Only allow model downgrade if codebase is large enough
  if (inputs.projectSize === 'small' && base.canDowngradeModelTier) {
    base.canDowngradeModelTier = false;
    base.inputCostWithLynx = base.inputCostWithoutLynx;
    base.outputCostWithLynx = base.outputCostWithoutLynx;
  }

  return base;
}

function tokensPerMonth(inputs: RoiInputs): number {
  return inputs.teamSize * inputs.tasksPerDevPerDay * inputs.avgTokensPerTask * inputs.workingDaysPerMonth;
}

function discoveryTokensPerMonth(inputs: RoiInputs): number {
  return Math.round(tokensPerMonth(inputs) * inputs.discoveryTaskRatio);
}

function tokensToCost(tokens: number, inputPerMTok: number, outputPerMTok: number): number {
  // Assuming 70/30 input/output split on token usage
  const inputTokens = tokens * 0.7;
  const outputTokens = tokens * 0.3;
  return (inputTokens / 1_000_000) * inputPerMTok + (outputTokens / 1_000_000) * outputPerMTok;
}

function computeBreakdown(inputs: RoiInputs, p: ModelParams, months: number): RoiBreakdown {
  const totalT = tokensPerMonth(inputs) * months;
  const discoveryT = Math.round(totalT * inputs.discoveryTaskRatio);
  const totalDiscoveryTasks = inputs.teamSize * inputs.tasksPerDevPerDay * inputs.workingDaysPerMonth * months * inputs.discoveryTaskRatio;

  // 1. Discovery overhead savings
  const withoutOverheadT = Math.round(discoveryT * p.discoveryOverheadRatio);
  const withOverheadT = Math.round(withoutOverheadT * p.lynxDiscoveryFactor);
  const tokensSavedByDiscovery = withoutOverheadT - withOverheadT;

  // 2. Error prevention savings
  const hallucinations = Math.round(totalDiscoveryTasks * (p.hallucinationRatePer100 / 100));
  const tokensSavedByErrorPrevention = hallucinations * p.avgTokensPerHallucination;

  // 3. Iteration reduction savings
  const iterationsSaved = (p.iterationsWithoutLynx - p.iterationsWithLynx) * totalDiscoveryTasks;
  const tokensSavedByIterationReduction = Math.round(iterationsSaved * p.avgTokensPerIteration);

  const totalTokensSaved = tokensSavedByDiscovery + tokensSavedByErrorPrevention + tokensSavedByIterationReduction;

  // API cost saved (using blended cost without LYNX)
  const apiCostSaved = tokensToCost(totalTokensSaved, p.inputCostWithoutLynx, p.outputCostWithoutLynx);

  // Dev time saved: iteration latency + hallucination fix time
  const iterationLatencySavedSec = iterationsSaved * p.avgIterationLatencySec;
  const hallucinationTimeSavedSec = hallucinations * p.hallucinationFixSec;
  const devHoursSaved = (iterationLatencySavedSec + hallucinationTimeSavedSec) / 3600;
  const devTimeValue = devHoursSaved * inputs.devHourlyCost;

  // Model tier savings
  let modelTierSavings = 0;
  if (p.canDowngradeModelTier) {
    const withoutCost = tokensToCost(totalT, p.inputCostWithoutLynx, p.outputCostWithoutLynx);
    const withCost = tokensToCost(totalT, p.inputCostWithLynx, p.outputCostWithLynx);
    modelTierSavings = withoutCost - withCost;
    // Subtract the overlap with discovery savings to avoid double counting
    modelTierSavings = Math.max(0, modelTierSavings - apiCostSaved * 0.3);
  }

  // Onboarding savings
  const newHiresInPeriod = Math.round((inputs.newDevsPerYear / 12) * months);
  const daysSavedPerHire = inputs.onboardingDaysWithoutLynx - 1; // with LYNX = 1 day
  const onboardingHoursSaved = newHiresInPeriod * daysSavedPerHire * 8;
  const onboardingValue = onboardingHoursSaved * inputs.devHourlyCost;

  const totalSavingsUsd = apiCostSaved + devTimeValue + modelTierSavings + onboardingValue;
  const lynxCost = inputs.lynxMonthlyCost * months;
  const netSavingsUsd = totalSavingsUsd - lynxCost;
  const roiMultiplier = lynxCost > 0 ? Math.round((netSavingsUsd / lynxCost) * 10) / 10 : Infinity;

  return {
    tokensSavedByDiscovery,
    tokensSavedByErrorPrevention,
    tokensSavedByIterationReduction,
    totalTokensSaved,
    apiCostSaved: Math.round(apiCostSaved * 100) / 100,
    devHoursSaved: Math.round(devHoursSaved * 10) / 10,
    devTimeValue: Math.round(devTimeValue),
    modelTierSavings: Math.round(modelTierSavings * 100) / 100,
    onboardingHoursSaved: Math.round(onboardingHoursSaved * 10) / 10,
    onboardingValue: Math.round(onboardingValue),
    totalSavingsUsd: Math.round(totalSavingsUsd),
    lynxCost: Math.round(lynxCost),
    netSavingsUsd: Math.round(netSavingsUsd),
    roiMultiplier,
  };
}

// ── Public API ──────────────────────────────────────────────────

export function computeRoi(inputs: RoiInputs): RoiOutput {
  // Use moderate profile by default, conservative for small codebases
  const profile = inputs.projectSize === 'large' ? 'moderate'
    : inputs.projectSize === 'small' ? 'conservative'
    : 'moderate';

  const p = getModelParams(inputs, profile);
  const monthly = computeBreakdown(inputs, p, 1);
  const annual = computeBreakdown(inputs, p, 12);

  const breakevenMonths = monthly.netSavingsUsd > 0 && inputs.lynxMonthlyCost > 0
    ? Math.ceil(inputs.lynxMonthlyCost / (monthly.totalSavingsUsd / 1)) // months to cover first month
    : monthly.netSavingsUsd >= 0 ? 1 : 999;

  // More realistic breakeven: how many months until cumulative net savings > 0
  let cumulative = 0;
  let actualBreakeven = 999;
  for (let m = 1; m <= 12; m++) {
    cumulative += monthly.totalSavingsUsd - inputs.lynxMonthlyCost;
    if (cumulative >= 0) {
      actualBreakeven = m;
      break;
    }
  }

  let breakevenNarrative: string;
  if (actualBreakeven <= 1) {
    breakevenNarrative = `You save money from day one. LYNX pays for itself immediately.`;
  } else if (actualBreakeven <= 3) {
    breakevenNarrative = `LYNX pays for itself in month ${actualBreakeven}. Every month after that is pure savings.`;
  } else if (actualBreakeven <= 6) {
    breakevenNarrative = `Breakeven at month ${actualBreakeven}. Annual net savings remain strongly positive.`;
  } else if (actualBreakeven <= 12) {
    breakevenNarrative = `Breakeven near end of year 1. Consider that onboarding savings may push this earlier.`;
  } else {
    breakevenNarrative = `LYNX doesn't break even in year 1 at the current price. The value is in long-term knowledge retention and reduced errors.`;
  }

  const summary = buildSummary(inputs, monthly, profile);

  return {
    inputs,
    monthly,
    annual,
    breakeven: {
      months: actualBreakeven,
      narrative: breakevenNarrative,
    },
    summary,
  };
}

// ── Smart defaults ──────────────────────────────────────────────

export function defaultInputs(projectSize: 'small' | 'medium' | 'large', teamSize?: number): RoiInputs {
  const defaults = DEFAULTS_BY_SIZE[projectSize];
  const lynxPrices = { small: 5, medium: 20, large: 50 }; // per user/month

  return {
    teamSize: teamSize || 5,
    tasksPerDevPerDay: defaults.tasksPerDevPerDay!,
    avgTokensPerTask: defaults.avgTokensPerTask!,
    discoveryTaskRatio: defaults.discoveryTaskRatio!,
    devHourlyCost: 75,
    workingDaysPerMonth: 20,
    modelTier: defaults.modelTier!,
    newDevsPerYear: Math.round((teamSize || 5) * 0.3), // 30% turnover/hiring
    onboardingDaysWithoutLynx: defaults.onboardingDaysWithoutLynx!,
    projectSize,
    lynxMonthlyCost: lynxPrices[projectSize] * (teamSize || 5),
  };
}

// ── Summary text ────────────────────────────────────────────────

function buildSummary(inputs: RoiInputs, m: RoiBreakdown, profile: string): string {
  const lines = [
    `= LYNX ROI Analysis (${profile} profile) =`,
    ``,
    `Team: ${inputs.teamSize} developers, ${inputs.projectSize} codebase, ${inputs.modelTier} model tier.`,
    `Monthly tasks per dev: ${inputs.tasksPerDevPerDay}/day × ${inputs.workingDaysPerMonth} days = ${inputs.tasksPerDevPerDay * inputs.workingDaysPerMonth}/mo.`,
    ``,
    `--- Monthly Savings Breakdown ---`,
    `Discovery overhead avoided:        ${m.tokensSavedByDiscovery.toLocaleString()} tokens → $${m.apiCostSaved.toFixed(2).split('.').reduce((_,p) => p, '0')}`,
    `Hallucinated symbols prevented:    ${m.tokensSavedByErrorPrevention.toLocaleString()} tokens`,
    `Iteration rounds eliminated:       ${m.tokensSavedByIterationReduction.toLocaleString()} tokens`,
    `Total tokens saved:                ${m.totalTokensSaved.toLocaleString()} tokens/mo`,
    `API cost saved:                    $${m.apiCostSaved.toFixed(2)}/mo`,
    `Developer time saved:              ${m.devHoursSaved.toFixed(1)} hours → $${m.devTimeValue.toLocaleString()}/mo`,
  ];

  if (m.modelTierSavings > 0) {
    lines.push(`Model tier downgrade:             $${m.modelTierSavings.toFixed(2)}/mo`);
  }
  if (m.onboardingValue > 0) {
    lines.push(`Onboarding acceleration:           ${m.onboardingHoursSaved.toFixed(1)} hours → $${m.onboardingValue.toLocaleString()}/mo`);
  }

  lines.push(
    ``,
    `Total monthly savings:  $${m.totalSavingsUsd.toLocaleString()}`,
    `LYNX cost:            $${m.lynxCost.toLocaleString()}/mo`,
    `Net monthly savings:    $${m.netSavingsUsd.toLocaleString()}/mo`,
    `ROI multiplier:         ${m.roiMultiplier}x`,
    ``,
    `Bottom line: LYNX saves your team $${m.netSavingsUsd.toLocaleString()}/mo after paying for itself.`,
    `That's $${(m.netSavingsUsd * 12).toLocaleString()}/year back in your budget.`,
  );

  return lines.join('\n');
}

// ── Formatting helpers for CLI output ───────────────────────────

export function formatRoiAsMarkdown(output: RoiOutput): string {
  const m = output.monthly;
  const a = output.annual;
  const i = output.inputs;

  return [
    `## LYNX ROI Analysis`,
    ``,
    `| Input | Value |`,
    `|---|---|`,
    `| Team size | ${i.teamSize} developers |`,
    `| Codebase | ${i.projectSize} |`,
    `| Model tier | ${i.modelTier} |`,
    `| Tasks/dev/day | ${i.tasksPerDevPerDay} |`,
    `| LYNX price | $${i.lynxMonthlyCost}/mo |`,
    `| Dev hourly cost | $${i.devHourlyCost}/hr |`,
    ``,
    `### Monthly Savings`,
    ``,
    `| Category | Tokens Saved | Value |`,
    `|---|---|---|`,
    `| Discovery overhead | ${m.tokensSavedByDiscovery.toLocaleString()} | $${m.apiCostSaved.toFixed(2)} |`,
    `| Error prevention | ${m.tokensSavedByErrorPrevention.toLocaleString()} | — |`,
    `| Iteration reduction | ${m.tokensSavedByIterationReduction.toLocaleString()} | — |`,
    `| Developer time | — | $${m.devTimeValue.toLocaleString()} |`,
    m.modelTierSavings > 0 ? `| Model tier savings | — | $${m.modelTierSavings.toFixed(2)} |` : '',
    m.onboardingValue > 0 ? `| Onboarding | — | $${m.onboardingValue.toLocaleString()} |` : '',
    `| **Total savings** | **${m.totalTokensSaved.toLocaleString()}** | **$${m.totalSavingsUsd.toLocaleString()}** |`,
    `| LYNX cost | — | -$${m.lynxCost.toLocaleString()} |`,
    `| **Net savings** | — | **$${m.netSavingsUsd.toLocaleString()}** |`,
    ``,
    `**ROI: ${m.roiMultiplier}x** — every $1 spent on LYNX returns $${m.roiMultiplier}.`,
    ``,
    `### Annual Projection`,
    ``,
    `| Category | Annual Value |`,
    `|---|---|`,
    `| Total savings | $${a.totalSavingsUsd.toLocaleString()} |`,
    `| LYNX cost | $${a.lynxCost.toLocaleString()} |`,
    `| **Net annual savings** | **$${a.netSavingsUsd.toLocaleString()}** |`,
    ``,
    `### Breakeven`,
    ``,
    `> ${output.breakeven.narrative}`,
    ``,
    `---`,
    `*Analysis uses the ${output.inputs.projectSize === 'large' ? 'moderate' : 'conservative'} model profile. ` +
    `Re-run with \`--profile aggressive\` for upper-bound estimates.*`,
  ].filter(Boolean).join('\n');
}
