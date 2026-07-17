export const SACG_BULK_EVIDENCE_THRESHOLD = 500;

export function shouldUseBulkEvidencePersistence(
  evidenceCount: number,
  envValue: string | undefined,
): boolean {
  if (!Number.isInteger(evidenceCount) || evidenceCount < 0) {
    throw new RangeError("SACG evidence count must be a non-negative integer");
  }
  return envValue !== "0" && evidenceCount >= SACG_BULK_EVIDENCE_THRESHOLD;
}
