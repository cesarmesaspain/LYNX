import { describe, expect, it } from "vitest";
import {
  reconcileEvidenceConfidence,
  type ConfidenceEvidence,
} from "../../../src/sacg/index.js";

function evidence(
  evidenceId: string,
  overrides: Partial<ConfidenceEvidence> = {},
): ConfidenceEvidence {
  return {
    evidenceId,
    evidenceType: "CALL_RESOLUTION",
    polarity: "supports",
    sourceHash: `hash-${evidenceId}`,
    strength: 0.8,
    independenceGroup: null,
    observedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("SACG evidence reconciliation", () => {
  it("keeps only the strongest correlated evidence contribution", () => {
    const result = reconcileEvidenceConfidence([
      evidence("a", { strength: 0.6, independenceGroup: "resolver-pass" }),
      evidence("b", { strength: 0.8, independenceGroup: "resolver-pass" }),
    ]);

    expect(result.supportGroupCount).toBe(1);
    expect(result.supportingStrength).toBe(0.8);
    expect(result.groups[0].evidenceIds).toEqual(["a", "b"]);
  });

  it("increases confidence for independent supporting groups", () => {
    const result = reconcileEvidenceConfidence([
      evidence("a", { strength: 0.6 }),
      evidence("b", { strength: 0.5 }),
    ]);

    expect(result.supportGroupCount).toBe(2);
    expect(result.supportingStrength).toBe(0.8);
    expect(result.confidence).toBe(0.8);
    expect(result.confidenceLevel).toBe("high");
  });

  it("reduces support by independently reconciled contradictions", () => {
    const result = reconcileEvidenceConfidence([
      evidence("support", { strength: 0.8 }),
      evidence("contra", {
        polarity: "contradicts",
        strength: 0.25,
      }),
    ]);

    expect(result.supportingStrength).toBe(0.8);
    expect(result.contradictingStrength).toBe(0.25);
    expect(result.confidence).toBe(0.6);
    expect(result.confidenceLevel).toBe("medium");
  });

  it("retains neutral evidence without changing confidence", () => {
    const result = reconcileEvidenceConfidence([
      evidence("support", { strength: 0.7 }),
      evidence("neutral", { polarity: "neutral", strength: 1 }),
    ]);

    expect(result.confidence).toBe(0.7);
    expect(result.neutralEvidenceCount).toBe(1);
    expect(result.explanation.join(" ")).toContain(
      "neutral evidence item(s) were retained",
    );
  });

  it("applies evidence type ceilings and optional age decay", () => {
    const result = reconcileEvidenceConfidence(
      [
        evidence("old-doc", {
          evidenceType: "DOCUMENTATION",
          strength: 0.9,
          observedAt: "2026-07-06T00:00:00.000Z",
        }),
      ],
      {
        now: "2026-07-16T00:00:00.000Z",
        ceilingByEvidenceType: { DOCUMENTATION: 0.8 },
        decayHalfLifeDaysByEvidenceType: { DOCUMENTATION: 10 },
      },
    );

    expect(result.supportingStrength).toBe(0.4);
    expect(result.confidenceLevel).toBe("low");
    expect(result.explanation.join(" ")).toContain("limited by type ceilings");
    expect(result.explanation.join(" ")).toContain("reduced by age decay");
  });

  it("requires sufficient deterministic support for verified status", () => {
    const unverified = reconcileEvidenceConfidence([
      evidence("ast", { evidenceType: "AST_EXACT", strength: 0.95 }),
    ]);
    const verified = reconcileEvidenceConfidence(
      [evidence("ast", { evidenceType: "AST_EXACT", strength: 0.95 })],
      { deterministicEvidenceTypes: ["AST_EXACT"] },
    );

    expect(unverified.confidence).toBe(0.95);
    expect(unverified.confidenceLevel).toBe("high");
    expect(unverified.explanation.join(" ")).toContain(
      "Verified status was withheld",
    );
    expect(verified.deterministicSupportingStrength).toBe(0.95);
    expect(verified.confidenceLevel).toBe("verified");
  });

  it("is idempotent for repeated evidence records", () => {
    const item = evidence("same", { strength: 0.7 });
    const result = reconcileEvidenceConfidence([item, item]);

    expect(result.supportGroupCount).toBe(1);
    expect(result.supportingStrength).toBe(0.7);
    expect(result.groups[0].evidenceIds).toEqual(["same"]);
  });

  it("rejects conflicting records with the same evidence identity", () => {
    expect(() =>
      reconcileEvidenceConfidence([
        evidence("same", { strength: 0.7 }),
        evidence("same", { strength: 0.8 }),
      ]),
    ).toThrow("evidence same has conflicting duplicate records");
  });

  it("returns an explicit hypothesis for an empty evidence set", () => {
    const result = reconcileEvidenceConfidence([]);

    expect(result.confidence).toBe(0);
    expect(result.confidenceLevel).toBe("hypothesis");
    expect(result.supportGroupCount).toBe(0);
    expect(result.contradictionGroupCount).toBe(0);
  });

  it.each([
    [0.24, "hypothesis"],
    [0.25, "low"],
    [0.5, "medium"],
    [0.75, "high"],
  ] as const)("maps confidence %s to %s", (strength, level) => {
    expect(
      reconcileEvidenceConfidence([evidence("boundary", { strength })])
        .confidenceLevel,
    ).toBe(level);
  });

  it("uses source hashes as the default correlation boundary", () => {
    const result = reconcileEvidenceConfidence([
      evidence("a", { sourceHash: "same-source", strength: 0.7 }),
      evidence("b", { sourceHash: "same-source", strength: 0.6 }),
      evidence("c", { sourceHash: "independent-source", strength: 0.5 }),
    ]);

    expect(result.supportGroupCount).toBe(2);
    expect(result.supportingStrength).toBe(0.85);
  });

  it("validates unused policy entries eagerly", () => {
    expect(() =>
      reconcileEvidenceConfidence([], {
        ceilingByEvidenceType: { UNUSED: 2 },
      }),
    ).toThrow("ceiling for UNUSED must be a finite number between 0 and 1");
    expect(() =>
      reconcileEvidenceConfidence([], {
        decayHalfLifeDaysByEvidenceType: { UNUSED: 0 },
      }),
    ).toThrow("decay half-life for UNUSED must be a positive finite number");
  });

  it.each([
    [
      "evidence strength",
      [evidence("bad", { strength: 1.1 })],
      {},
      "must be a finite number between 0 and 1",
    ],
    [
      "type ceiling",
      [evidence("bad")],
      { ceilingByEvidenceType: { CALL_RESOLUTION: -0.1 } },
      "must be a finite number between 0 and 1",
    ],
    [
      "half-life",
      [evidence("bad")],
      { decayHalfLifeDaysByEvidenceType: { CALL_RESOLUTION: 0 } },
      "must be a positive finite number",
    ],
    [
      "timestamp",
      [evidence("bad", { observedAt: "not-a-date" })],
      {
        now: "2026-07-16T00:00:00.000Z",
        decayHalfLifeDaysByEvidenceType: { CALL_RESOLUTION: 10 },
      },
      "must be a valid ISO timestamp",
    ],
  ])("rejects invalid %s configuration", (_label, items, policy, message) => {
    expect(() => reconcileEvidenceConfidence(items, policy)).toThrow(message);
  });
});
