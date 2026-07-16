/*
 * types.ts — Domain contracts for the SACG evidence-native core.
 *
 * These types expose logical identity in camelCase. SQLite physical IDs and
 * snake_case rows remain a storage concern and are intentionally excluded.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type IsoTimestamp = string;
export type SemanticId = string;
export type SemanticRelationId = string;
export type EvidenceId = string;
export type SnapshotId = string;

export const SEMANTIC_ENTITY_CLASSES = [
  "File",
  "Function",
  "Method",
  "Class",
] as const;

export type SemanticEntityClass = (typeof SEMANTIC_ENTITY_CLASSES)[number];

export const SEMANTIC_RELATION_TYPES = [
  "CALLS",
  "IMPORTS",
  "TESTS",
  "CONFIGURES",
  "EMITS",
  "LISTENS_ON",
] as const;

export type SemanticRelationType = (typeof SEMANTIC_RELATION_TYPES)[number];

export const EVIDENCE_POLARITIES = [
  "supports",
  "contradicts",
  "neutral",
] as const;

export type EvidencePolarity = (typeof EVIDENCE_POLARITIES)[number];

export const CONFIDENCE_LEVELS = [
  "verified",
  "high",
  "medium",
  "low",
  "hypothesis",
] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface SemanticEntity {
  project: string;
  semanticId: SemanticId;
  entityClass: SemanticEntityClass;
  name: string;
  qualifiedName: string | null;
  normalizedSignature: string;
  structuralContext: string;
  properties: JsonObject;
  firstSeenSnapshot: SnapshotId;
  lastSeenSnapshot: SnapshotId;
  validFrom: IsoTimestamp;
  validTo: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SemanticRelation {
  project: string;
  semanticRelationId: SemanticRelationId;
  sourceSemanticId: SemanticId;
  relationType: SemanticRelationType;
  targetSemanticId: SemanticId;
  scope: JsonObject;
  properties: JsonObject;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  firstSeenSnapshot: SnapshotId;
  lastSeenSnapshot: SnapshotId;
  validFrom: IsoTimestamp;
  validTo: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Evidence {
  evidenceId: EvidenceId;
  project: string;
  evidenceType: string;
  polarity: EvidencePolarity;
  sourceKind: string;
  sourcePath: string | null;
  sourceHash: string;
  startLine: number | null;
  endLine: number | null;
  symbolSemanticId: SemanticId | null;
  extractor: string;
  extractorVersion: string;
  payload: JsonObject;
  strength: number;
  independenceGroup: string | null;
  observedAt: IsoTimestamp;
  snapshotId: SnapshotId;
  createdAt: IsoTimestamp;
}

export function isSemanticEntityClass(
  value: string,
): value is SemanticEntityClass {
  return (SEMANTIC_ENTITY_CLASSES as readonly string[]).includes(value);
}

export function isSemanticRelationType(
  value: string,
): value is SemanticRelationType {
  return (SEMANTIC_RELATION_TYPES as readonly string[]).includes(value);
}

export function isEvidencePolarity(value: string): value is EvidencePolarity {
  return (EVIDENCE_POLARITIES as readonly string[]).includes(value);
}

export function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}
