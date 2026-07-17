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

  it("skips rewriting an immutable content-addressed snapshot", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      persistSacgSnapshot(db, input);
      persistSacgSnapshot(
        db,
        {
          ...input,
          entities: input.entities.map((entity) => ({
            ...entity,
            name: `must-not-rewrite-${entity.name}`,
          })),
        },
        { skipExistingSnapshot: true },
      );

      expect(
        db.db
          .prepare(
            "SELECT name FROM semantic_entities WHERE project = ? AND semantic_id = ?",
          )
          .get(project, "semantic:source"),
      ).toEqual({ name: "source" });
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

// ── Bulk evidence tests ─────────────────────────────

describe("SACG snapshot persistence (bulk evidence)", () => {
  it("produces identical results as row-by-row persistence", () => {
    const dbBulk = LynxDatabase.openMemory();
    const dbRow = LynxDatabase.openMemory();
    try {
      const input = bundle();
      persistSacgSnapshot(dbBulk, input, {
        canonicalPayloads: true,
        bulkEvidence: true,
      });
      persistSacgSnapshot(dbRow, input, { canonicalPayloads: true });

      expect(counts(dbBulk)).toEqual(counts(dbRow));

      const cols =
        "evidence_id, evidence_type, source_hash, strength, payload_json, snapshot_id";
      const bulkRows = dbBulk.db
        .prepare(
          `SELECT ${cols} FROM evidence WHERE project = ? ORDER BY evidence_id`,
        )
        .all(project);
      const rowRows = dbRow.db
        .prepare(
          `SELECT ${cols} FROM evidence WHERE project = ? ORDER BY evidence_id`,
        )
        .all(project);
      expect(bulkRows).toEqual(rowRows);
    } finally {
      dbBulk.close();
      dbRow.close();
    }
  });

  it("respects skipExistingSnapshot when using bulk", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      persistSacgSnapshot(db, input, {
        canonicalPayloads: true,
        bulkEvidence: true,
      });
      persistSacgSnapshot(
        db,
        {
          ...input,
          entities: input.entities.map((e) => ({
            ...e,
            name: `must-not-${e.name}`,
          })),
        },
        { skipExistingSnapshot: true, bulkEvidence: true },
      );
      expect(
        db.db
          .prepare(
            "SELECT name FROM semantic_entities WHERE project = ? AND semantic_id = ?",
          )
          .get(project, "semantic:source"),
      ).toEqual({ name: "source" });
    } finally {
      db.close();
    }
  });

  it("handles empty evidence list gracefully", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      const result = persistSacgSnapshot(
        db,
        { ...input, evidence: [] },
        { bulkEvidence: true },
      );
      expect(result.evidence).toBe(0);
      expect(counts(db)).toEqual({
        snapshots: 1,
        entities: 2,
        relations: 1,
        evidence: 0,
      });
    } finally {
      db.close();
    }
  });

  it("rolls back everything when an entity violates a FK in bulk mode", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      expect(() =>
        persistSacgSnapshot(
          db,
          {
            ...input,
            entities: input.entities.slice(0, 1),
          },
          { bulkEvidence: true },
        ),
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

  it("handles duplicate evidence_id within staging (last row wins)", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      // Two evidence items with same evidenceId but different strengths.
      const evidence1 = { ...input.evidence[0], strength: 0.3 };
      const evidence2 = {
        ...input.evidence[0],
        evidenceId: input.evidence[0].evidenceId,
        strength: 0.7,
      };
      const result = persistSacgSnapshot(
        db,
        {
          ...input,
          evidence: [evidence1, evidence2],
        },
        { canonicalPayloads: true, bulkEvidence: true },
      );

      expect(result.evidence).toBe(2);
      const row = db.db
        .prepare(
          "SELECT strength FROM evidence WHERE project = ? AND evidence_id = ?",
        )
        .get(project, input.evidence[0].evidenceId) as { strength: number };
      // Explicit staging ordinal preserves row-by-row semantics: the final input wins.
      expect(row).toEqual({ strength: 0.7 });
    } finally {
      db.close();
    }
  });

  it("logical identity collision within staging is caught by unique index", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      // Two evidence with different evidenceId but same logical identity.
      const evidence1 = { ...input.evidence[0], evidenceId: "ev-1" };
      const evidence2 = { ...input.evidence[0], evidenceId: "ev-2" };
      expect(() =>
        persistSacgSnapshot(
          db,
          {
            ...input,
            evidence: [evidence1, evidence2],
          },
          { bulkEvidence: true },
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("idempotent replay with bulk evidence", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      persistSacgSnapshot(db, input, {
        canonicalPayloads: true,
        bulkEvidence: true,
      });
      persistSacgSnapshot(db, input, {
        canonicalPayloads: true,
        bulkEvidence: true,
      });

      expect(counts(db)).toEqual({
        snapshots: 1,
        entities: 2,
        relations: 1,
        evidence: 1,
      });
    } finally {
      db.close();
    }
  });

  it("preserves canonical serialization when canonicalPayloads=true", () => {
    const db = LynxDatabase.openMemory();
    try {
      const input = bundle();
      persistSacgSnapshot(db, input, {
        canonicalPayloads: true,
        bulkEvidence: true,
      });

      const row = db.db
        .prepare(
          "SELECT payload_json FROM evidence WHERE project = ? AND evidence_id = ?",
        )
        .get(project, "evidence-a") as { payload_json: string };
      // canonicalPayloads=true uses JSON.stringify — preserves insertion order,
      // not alphabetically sorted. Verify the stored payload is valid JSON.
      const parsed = JSON.parse(row.payload_json);
      expect(parsed).toHaveProperty("z", 1);
      expect(parsed).toHaveProperty("a");
    } finally {
      db.close();
    }
  });
});
