import { createHash } from "node:crypto";
import { serializeEvidencePayload } from "./evidence-payload.js";
import type {
  EvidenceId,
  JsonObject,
  SemanticEntityClass,
  SemanticId,
  SemanticRelationId,
  SemanticRelationType,
} from "./types.js";

export interface SemanticIdentityComponents {
  projectNamespace: string;
  entityClass: SemanticEntityClass;
  normalizedSignature: string;
  structuralContext: string;
}

export interface SemanticRelationIdentityComponents {
  projectNamespace: string;
  sourceSemanticId: SemanticId;
  relationType: SemanticRelationType;
  targetSemanticId: SemanticId;
  scope: JsonObject;
}

export interface EvidenceIdentityComponents {
  projectNamespace: string;
  evidenceType: string;
  sourceHash: string;
  sourcePath: string | null;
  startLine: number | null;
  endLine: number | null;
  symbolSemanticId: SemanticId | null;
  extractorVersion: string;
}

function assertNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function sha256(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
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
  return sha256(buildSemanticIdentityMaterial(input));
}

export function buildSemanticRelationIdentityMaterial(
  input: SemanticRelationIdentityComponents,
): string {
  assertNonEmpty("projectNamespace", input.projectNamespace);
  assertNonEmpty("sourceSemanticId", input.sourceSemanticId);
  assertNonEmpty("targetSemanticId", input.targetSemanticId);

  return JSON.stringify([
    input.projectNamespace,
    input.sourceSemanticId,
    input.relationType,
    input.targetSemanticId,
    serializeEvidencePayload(input.scope),
  ]);
}

export function generateSemanticRelationId(
  input: SemanticRelationIdentityComponents,
): SemanticRelationId {
  return sha256(buildSemanticRelationIdentityMaterial(input));
}

export function buildEvidenceIdentityMaterial(
  input: EvidenceIdentityComponents,
): string {
  assertNonEmpty("projectNamespace", input.projectNamespace);
  assertNonEmpty("evidenceType", input.evidenceType);
  assertNonEmpty("sourceHash", input.sourceHash);
  assertNonEmpty("extractorVersion", input.extractorVersion);

  return JSON.stringify([
    input.projectNamespace,
    input.evidenceType,
    input.sourceHash,
    input.sourcePath,
    input.startLine,
    input.endLine,
    input.symbolSemanticId,
    input.extractorVersion,
  ]);
}

export function generateEvidenceId(
  input: EvidenceIdentityComponents,
): EvidenceId {
  return sha256(buildEvidenceIdentityMaterial(input));
}
