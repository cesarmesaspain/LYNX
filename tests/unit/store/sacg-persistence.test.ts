import { describe, expect, it } from "vitest";
import type {
  Evidence,
  GraphSnapshot,
  SemanticEntity,
  SemanticRelation,
} from "../../../src/sacg/types.js";
import { LynxDatabase } from "../../../src/store/database.js";
import {
  persistSacgSnapshot,
  type SacgSnapshotWrite,
} from "../../../src/store/sacg-persistence.js";

const project = "project-a";
const snapshotId = "snapshot-a";
const timestamp = "2026-07-16T10:00:00.000Z";

function bundle(): SacgSnapshotWrite {
  const snapshot: GraphSnapshot = {
    snapshotId,
    project,
    status: "ready",
    sourceCommit: "abc123",
    sourceBranch: "main",
    workingTree: false,
    validFrom: timestamp,
    validTo: null,
    createdAt: timestamp,
    completedAt: timestamp,
    metadata: { z: 1, a: { y: true, x: "value" } },
  };
  const source: SemanticEntity = {
    project,
    semanticId: "semantic:source",
    entityClass: "Function",
    name: "source",
    qualifiedName: "module.source",
    normalizedSignature: "source()",
    structuralContext: "src/module.ts",
    properties: { z: 1, a: 2 },
    firstSeenSnapshot: snapshotId,
    lastSeenSnapshot: snapshotId,
    validFrom: timestamp,
    validTo: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const target: SemanticEntity = {
    ...source,
    semanticId: "semantic:target",
    name: "target",
    qualifiedName: "module.target",
    normalizedSignature: "target()",
  };
  const relation: SemanticRelation = {
    project,
    semanticRelationId: "relation-a",
    sourceSemanticId: source.semanticId,
    relationType: "CALLS",
    targetSemanticId: target.semanticId,
    scope: { z: 1, a: 2 },
    properties: { reason: "direct call" },
    confidence: 0.95,
    confidenceLevel: "high",
    firstSeenSnapshot: snapshotId,
    lastSeenSnapshot: snapshotId,
    validFrom: timestamp,
    validTo: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const evidence: Evidence = {
    evidenceId: "evidence-a",
    project,
    evidenceType: "structural",
    polarity: "supports",
    sourceKind: "source",
    sourcePath: "src/module.ts",
    sourceHash: "source-hash",
    startLine: 10,
    endLine: 12,
    symbolSemanticId: source.semanticId,
    extractor: "tree-sitter",
    extractorVersion: "1",
    payload: { z: 1, a: { y: true, x: "value" } },
    strength: 0.95,
    independenceGroup: "parser",
    observedAt: timestamp,
    snapshotId,
    createdAt: timestamp,
  };
  return {
    snapshot,
    entities: [source, target],
    relations: [relation],
    evidence: [evidence],
  };
}

function counts(db: LynxDatabase): unknown {
  return db.db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM graph_snapshots) AS snapshots, (SELECT COUNT(*) FROM semantic_entities) AS entities, (SELECT COUNT(*) FROM semantic_relations) AS relations, (SELECT COUNT(*) FROM evidence) AS evidence",
    )
    .get();
}

describe("SACG snapshot persistence", () => {
  it("persists canonically and replays idempotently", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      expect(persistSacgSnapshot(db, input)).toEqual({
        project,
        snapshotId,
        entities: 2,
        relations: 1,
        evidence: 1,
      });

      const updatedAt = "2026-07-16T11:00:00.000Z";
      persistSacgSnapshot(db, {
        ...input,
        snapshot: {
          ...input.snapshot,
          metadata: { replayed: true },
          completedAt: updatedAt,
        },
        entities: input.entities.map((entity) =>
          entity.semanticId === "semantic:source"
            ? { ...entity, name: "updated-source", updatedAt }
            : entity,
        ),
        relations: [
          {
            ...input.relations[0],
            confidence: 0.99,
            confidenceLevel: "verified",
            updatedAt,
          },
        ],
        evidence: [
          {
            ...input.evidence[0],
            strength: 0.99,
            observedAt: updatedAt,
          },
        ],
      });

      expect(counts(db)).toEqual({
        snapshots: 1,
        entities: 2,
        relations: 1,
        evidence: 1,
      });
      expect(
        db.db
          .prepare(
            "SELECT status, metadata_json FROM graph_snapshots WHERE project = ? AND snapshot_id = ?",
          )
          .get(project, snapshotId),
      ).toEqual({ status: "ready", metadata_json: '{"replayed":true}' });
      expect(
        db.db
          .prepare(
            "SELECT name, properties_json FROM semantic_entities WHERE project = ? AND semantic_id = ?",
          )
          .get(project, "semantic:source"),
      ).toEqual({
        name: "updated-source",
        properties_json: '{"a":2,"z":1}',
      });
      expect(
        db.db
          .prepare(
            "SELECT confidence, confidence_level, scope_json FROM semantic_relations WHERE project = ? AND semantic_relation_id = ?",
          )
          .get(project, "relation-a"),
      ).toEqual({
        confidence: 0.99,
        confidence_level: "verified",
        scope_json: '{"a":2,"z":1}',
      });
      expect(
        db.db
          .prepare(
            "SELECT strength, payload_json FROM evidence WHERE project = ? AND evidence_id = ?",
          )
          .get(project, "evidence-a"),
      ).toEqual({
        strength: 0.99,
        payload_json: '{"a":{"x":"value","y":true},"z":1}',
      });
    } finally {
      db.close();
    }
  });

  it("rolls back every row when a relation violates a foreign key", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      expect(() =>
        persistSacgSnapshot(db, {
          ...input,
          entities: input.entities.slice(0, 1),
        }),
      ).toThrow();
      expect(counts(db)).toEqual({
        snapshots: 0,
        entities: 0,
        relations: 0,
        evidence: 0,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a mixed-project bundle before writing", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      expect(() =>
        persistSacgSnapshot(db, {
          ...input,
          entities: [{ ...input.entities[0], project: "project-b" }],
          relations: [],
          evidence: [],
        }),
      ).toThrow(/belongs to project project-b/);
      expect(counts(db)).toEqual({
        snapshots: 0,
        entities: 0,
        relations: 0,
        evidence: 0,
      });
    } finally {
      db.close();
    }
  });
});
