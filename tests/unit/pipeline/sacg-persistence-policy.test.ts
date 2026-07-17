import { describe, expect, it } from "vitest";
import {
  SACG_BULK_EVIDENCE_THRESHOLD,
  shouldUseBulkEvidencePersistence,
} from "../../../src/pipeline/sacg-persistence-policy.js";

describe("SACG bulk evidence persistence policy", () => {
  it("uses row-by-row persistence below the threshold", () => {
    expect(SACG_BULK_EVIDENCE_THRESHOLD).toBe(500);
    expect(shouldUseBulkEvidencePersistence(499, undefined)).toBe(false);
  });

  it("enables bulk persistence at the threshold by default", () => {
    expect(shouldUseBulkEvidencePersistence(500, undefined)).toBe(true);
    expect(shouldUseBulkEvidencePersistence(500, "1")).toBe(true);
  });

  it("allows an explicit environment fallback", () => {
    expect(shouldUseBulkEvidencePersistence(10_000, "0")).toBe(false);
  });

  it("rejects invalid evidence counts", () => {
    expect(() => shouldUseBulkEvidencePersistence(-1, undefined)).toThrow(
      RangeError,
    );
    expect(() => shouldUseBulkEvidencePersistence(1.5, undefined)).toThrow(
      RangeError,
    );
  });
});
