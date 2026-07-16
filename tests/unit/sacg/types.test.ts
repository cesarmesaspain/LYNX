import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_LEVELS,
  EVIDENCE_POLARITIES,
  SEMANTIC_ENTITY_CLASSES,
  SEMANTIC_RELATION_TYPES,
  isConfidenceLevel,
  isEvidencePolarity,
  isSemanticEntityClass,
  isSemanticRelationType,
} from "../../../src/sacg/index.js";

describe("SACG domain type vocabularies", () => {
  it("exposes only the first vertical slice entity and relation kinds", () => {
    expect(SEMANTIC_ENTITY_CLASSES).toEqual([
      "File",
      "Function",
      "Method",
      "Class",
    ]);
    expect(SEMANTIC_RELATION_TYPES).toEqual([
      "CALLS",
      "IMPORTS",
      "TESTS",
      "CONFIGURES",
      "EMITS",
      "LISTENS_ON",
    ]);
  });

  it("narrows supported evidence polarities and confidence levels", () => {
    expect(EVIDENCE_POLARITIES).toEqual(["supports", "contradicts", "neutral"]);
    expect(CONFIDENCE_LEVELS).toEqual([
      "verified",
      "high",
      "medium",
      "low",
      "hypothesis",
    ]);
    expect(isSemanticEntityClass("Method")).toBe(true);
    expect(isSemanticEntityClass("Service")).toBe(false);
    expect(isSemanticRelationType("EMITS")).toBe(true);
    expect(isSemanticRelationType("READS")).toBe(false);
    expect(isEvidencePolarity("contradicts")).toBe(true);
    expect(isEvidencePolarity("unknown")).toBe(false);
    expect(isConfidenceLevel("verified")).toBe(true);
    expect(isConfidenceLevel("certain")).toBe(false);
  });
});
