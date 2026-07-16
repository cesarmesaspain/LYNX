import { createHash } from "node:crypto";
import type { SemanticEntityClass, SemanticId } from "./types.js";

export interface SemanticIdentityComponents {
  projectNamespace: string;
  entityClass: SemanticEntityClass;
  normalizedSignature: string;
  structuralContext: string;
}

function assertNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

/**
 * Build the unambiguous canonical material hashed for a semantic ID.
 *
 * JSON array framing preserves the blueprint order while avoiding
 * concatenation collisions such as ["ab", "c"] versus ["a", "bc"].
 */
export function buildSemanticIdentityMaterial(
  input: SemanticIdentityComponents,
): string {
  assertNonEmpty("projectNamespace", input.projectNamespace);

  return JSON.stringify([
    input.projectNamespace,
    input.entityClass,
    input.normalizedSignature,
    input.structuralContext,
  ]);
}

export function generateSemanticId(
  input: SemanticIdentityComponents,
): SemanticId {
  return createHash("sha256")
    .update(buildSemanticIdentityMaterial(input), "utf8")
    .digest("hex");
}
