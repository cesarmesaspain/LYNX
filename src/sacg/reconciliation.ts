import type {
  ConfidenceLevel,
  Evidence,
  EvidenceId,
  EvidencePolarity,
  IsoTimestamp,
} from "./types.js";

export type ConfidenceEvidence = Pick<
  Evidence,
  | "evidenceId"
  | "evidenceType"
  | "polarity"
  | "sourceHash"
  | "strength"
  | "independenceGroup"
  | "observedAt"
>;

export interface ConfidencePolicy {
  ceilingByEvidenceType?: Readonly<Record<string, number>>;
  decayHalfLifeDaysByEvidenceType?: Readonly<Record<string, number>>;
  deterministicEvidenceTypes?: readonly string[];
  now?: IsoTimestamp;
}

export interface ReconciledEvidenceGroup {
  groupKey: string;
  polarity: Exclude<EvidencePolarity, "neutral">;
  evidenceIds: EvidenceId[];
  effectiveStrength: number;
  deterministicStrength: number;
}

export interface ReconciledConfidence {
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  supportingStrength: number;
  contradictingStrength: number;
  deterministicSupportingStrength: number;
  supportGroupCount: number;
  contradictionGroupCount: number;
  neutralEvidenceCount: number;
  groups: ReconciledEvidenceGroup[];
  explanation: string[];
}

interface MutableEvidenceGroup {
  groupKey: string;
  polarity: Exclude<EvidencePolarity, "neutral">;
  evidenceIds: EvidenceId[];
  effectiveStrength: number;
  deterministicStrength: number;
}

function assertUnitInterval(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number between 0 and 1`);
  }
}

function parseTimestamp(label: string, value: IsoTimestamp): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid ISO timestamp`);
  }
  return timestamp;
}

function validatePolicy(policy: ConfidencePolicy): void {
  for (const [evidenceType, ceiling] of Object.entries(
    policy.ceilingByEvidenceType ?? {},
  )) {
    assertUnitInterval(`ceiling for ${evidenceType}`, ceiling);
  }
  for (const [evidenceType, halfLifeDays] of Object.entries(
    policy.decayHalfLifeDaysByEvidenceType ?? {},
  )) {
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
      throw new RangeError(
        `decay half-life for ${evidenceType} must be a positive finite number`,
      );
    }
  }
}

function evidenceSignature(evidence: ConfidenceEvidence): string {
  return JSON.stringify([
    evidence.evidenceType,
    evidence.polarity,
    evidence.sourceHash,
    evidence.strength,
    evidence.independenceGroup,
    evidence.observedAt,
  ]);
}

function combineIndependent(strengths: readonly number[]): number {
  return (
    1 - strengths.reduce((remaining, strength) => remaining * (1 - strength), 1)
  );
}

function roundConfidence(value: number): number {
  return Number(value.toFixed(12));
}

function confidenceLevelFor(
  confidence: number,
  deterministicSupportingStrength: number,
): ConfidenceLevel {
  if (confidence >= 0.9 && deterministicSupportingStrength >= 0.9) {
    return "verified";
  }
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  if (confidence >= 0.25) return "low";
  return "hypothesis";
}

function correlationKey(evidence: ConfidenceEvidence): string {
  const explicitGroup = evidence.independenceGroup?.trim();
  if (explicitGroup) return `independence:${explicitGroup}`;
  return `source:${evidence.sourceHash || evidence.evidenceId}`;
}

export function reconcileEvidenceConfidence(
  evidence: readonly ConfidenceEvidence[],
  policy: ConfidencePolicy = {},
): ReconciledConfidence {
  validatePolicy(policy);
  const ceilings = policy.ceilingByEvidenceType ?? {};
  const halfLives = policy.decayHalfLifeDaysByEvidenceType ?? {};
  const deterministicTypes = new Set(policy.deterministicEvidenceTypes ?? []);
  const now = parseTimestamp(
    "policy.now",
    policy.now ?? new Date().toISOString(),
  );
  const groups = new Map<string, MutableEvidenceGroup>();
  const seenEvidence = new Map<EvidenceId, string>();
  let neutralEvidenceCount = 0;
  let decayedEvidenceCount = 0;
  let cappedEvidenceCount = 0;

  for (const item of evidence) {
    assertUnitInterval(`evidence ${item.evidenceId} strength`, item.strength);

    const signature = evidenceSignature(item);
    const previousSignature = seenEvidence.get(item.evidenceId);
    if (previousSignature !== undefined) {
      if (previousSignature !== signature) {
        throw new Error(
          `evidence ${item.evidenceId} has conflicting duplicate records`,
        );
      }
      continue;
    }
    seenEvidence.set(item.evidenceId, signature);

    if (item.polarity === "neutral") {
      neutralEvidenceCount += 1;
      continue;
    }

    const ceiling = ceilings[item.evidenceType] ?? 1;
    let effectiveStrength = Math.min(item.strength, ceiling);
    if (effectiveStrength < item.strength) cappedEvidenceCount += 1;

    const halfLifeDays = halfLives[item.evidenceType];
    if (halfLifeDays !== undefined) {
      const observedAt = parseTimestamp(
        `evidence ${item.evidenceId} observedAt`,
        item.observedAt,
      );
      const ageDays = Math.max(0, now - observedAt) / 86_400_000;
      const decayFactor = Math.pow(0.5, ageDays / halfLifeDays);
      effectiveStrength *= decayFactor;
      if (decayFactor < 1) decayedEvidenceCount += 1;
    }

    effectiveStrength = roundConfidence(effectiveStrength);
    const deterministicStrength = deterministicTypes.has(item.evidenceType)
      ? effectiveStrength
      : 0;
    const groupKey = correlationKey(item);
    const mapKey = `${item.polarity}\u0000${groupKey}`;
    const existing = groups.get(mapKey);

    if (existing) {
      existing.evidenceIds.push(item.evidenceId);
      existing.effectiveStrength = Math.max(
        existing.effectiveStrength,
        effectiveStrength,
      );
      existing.deterministicStrength = Math.max(
        existing.deterministicStrength,
        deterministicStrength,
      );
    } else {
      groups.set(mapKey, {
        groupKey,
        polarity: item.polarity,
        evidenceIds: [item.evidenceId],
        effectiveStrength,
        deterministicStrength,
      });
    }
  }

  const reconciledGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      evidenceIds: [...group.evidenceIds].sort(),
    }))
    .sort((a, b) =>
      `${a.polarity}:${a.groupKey}`.localeCompare(
        `${b.polarity}:${b.groupKey}`,
      ),
    );
  const supportGroups = reconciledGroups.filter(
    (group) => group.polarity === "supports",
  );
  const contradictionGroups = reconciledGroups.filter(
    (group) => group.polarity === "contradicts",
  );
  const supportingStrength = roundConfidence(
    combineIndependent(supportGroups.map((group) => group.effectiveStrength)),
  );
  const contradictingStrength = roundConfidence(
    combineIndependent(
      contradictionGroups.map((group) => group.effectiveStrength),
    ),
  );
  const deterministicSupportingStrength = roundConfidence(
    combineIndependent(
      supportGroups.map((group) => group.deterministicStrength),
    ),
  );
  const confidence = roundConfidence(
    supportingStrength * (1 - contradictingStrength),
  );
  const confidenceLevel = confidenceLevelFor(
    confidence,
    deterministicSupportingStrength,
  );

  const explanation = [
    `${supportGroups.length} independent supporting group(s) combine to ${supportingStrength.toFixed(3)}.`,
    `${contradictionGroups.length} independent contradicting group(s) combine to ${contradictingStrength.toFixed(3)}.`,
    `Final confidence ${confidence.toFixed(3)} = support × (1 - contradiction); level ${confidenceLevel}.`,
  ];
  if (neutralEvidenceCount > 0) {
    explanation.push(
      `${neutralEvidenceCount} neutral evidence item(s) were retained but did not affect confidence.`,
    );
  }
  if (cappedEvidenceCount > 0) {
    explanation.push(
      `${cappedEvidenceCount} evidence item(s) were limited by type ceilings.`,
    );
  }
  if (decayedEvidenceCount > 0) {
    explanation.push(
      `${decayedEvidenceCount} evidence item(s) were reduced by age decay.`,
    );
  }
  if (confidence >= 0.9 && deterministicSupportingStrength < 0.9) {
    explanation.push(
      "Verified status was withheld because deterministic supporting evidence was insufficient.",
    );
  }

  return {
    confidence,
    confidenceLevel,
    supportingStrength,
    contradictingStrength,
    deterministicSupportingStrength,
    supportGroupCount: supportGroups.length,
    contradictionGroupCount: contradictionGroups.length,
    neutralEvidenceCount,
    groups: reconciledGroups,
    explanation: explanation,
  };
}
