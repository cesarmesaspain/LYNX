import { describe, expect, it } from "vitest";
import { projectLegacyGraphToSacg } from "../../../src/sacg/index.js";
import { LynxDatabase } from "../../../src/store/database.js";
import { insertEdge } from "../../../src/store/edges.js";

const PROJECT = "projection-test";
const FIRST_OBSERVED_AT = "2026-07-16T10:00:00.000Z";
const SECOND_OBSERVED_AT = "2026-07-16T11:00:00.000Z";

function insertNode(
  db: LynxDatabase,
  input: {
    id: number;
    kind: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    properties?: Record<string, unknown>;
  },
): void {
  db.db
    .prepare(
      `INSERT INTO nodes (
        id, project, kind, name, qualified_name, file_path,
        start_line, end_line, is_exported, is_test, is_entry_point, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      PROJECT,
      input.kind,
      input.name,
      input.qualifiedName,
      input.filePath,
      1,
      20,
      1,
      0,
      0,
      JSON.stringify(input.properties ?? {}),
    );
}

function seedLegacyGraph(db: LynxDatabase): void {
  insertNode(db, {
    id: 1,
    kind: "File",
    name: "a.ts",
    qualifiedName: "src/a.ts",
    filePath: "src/a.ts",
    properties: { extension: ".ts" },
  });
  insertNode(db, {
    id: 2,
    kind: "Function",
    name: "source",
    qualifiedName: "a.source",
    filePath: "src/a.ts",
    properties: { signature: "source(): void" },
  });
  insertNode(db, {
    id: 3,
    kind: "Method",
    name: "target",
    qualifiedName: "A.target",
    filePath: "src/a.ts",
    properties: { signature: "target(): void", parentClass: "A" },
  });
  insertNode(db, {
    id: 4,
    kind: "Class",
    name: "A",
    qualifiedName: "A",
    filePath: "src/a.ts",
    properties: { baseClasses: [] },
  });
  insertNode(db, {
    id: 5,
    kind: "Variable",
    name: "value",
    qualifiedName: "a.value",
    filePath: "src/a.ts",
  });

  db.db
    .prepare(
      "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
    )
    .run(PROJECT, "src/a.ts", "hash-a", 1, 100);

  insertEdge(db, {
    project: PROJECT,
    sourceId: 2,
    targetId: 3,
    type: "CALLS",
    properties: { confidence: 0.8, line: 10, resolution: "direct" },
  });
  insertEdge(db, {
    project: PROJECT,
    sourceId: 2,
    targetId: 3,
    type: "CALLS",
    properties: { confidence: 0.6, line: 11, resolution: "direct" },
  });
  insertEdge(db, {
    project: PROJECT,
    sourceId: 1,
    targetId: 4,
    type: "IMPORTS",
    properties: { confidence: 0.7, line: 1, resolution: "static" },
  });
  insertEdge(db, {
    project: PROJECT,
    sourceId: 1,
    targetId: 2,
    type: "DEFINES",
    properties: { confidence: 1, line: 2 },
  });
  insertEdge(db, {
    project: PROJECT,
    sourceId: 2,
    targetId: 5,
    type: "CALLS",
    properties: { confidence: 0.9, line: 12 },
  });
}

function project(db: LynxDatabase, observedAt: string) {
  return projectLegacyGraphToSacg(db, PROJECT, {
    sourceCommit: "abc123",
    sourceBranch: "main",
    workingTree: false,
    observedAt,
  });
}

describe("legacy graph to SACG projection", () => {
  it("projects supported entities and relations with reconciled evidence", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const bundle = project(db, FIRST_OBSERVED_AT);

      expect(bundle.snapshot.metadata).toEqual({
        projectionVersion: "legacy-v1",
        legacyNodeCount: 5,
        projectedEntityCount: 4,
        unsupportedNodeCount: 1,
        legacyEdgeCount: 5,
        projectedRelationCount: 2,
        unsupportedEdgeCount: 2,
        evidenceCount: 3,
      });
      expect(bundle.entities).toHaveLength(4);
      expect(bundle.relations).toHaveLength(2);
      expect(bundle.evidence).toHaveLength(3);

      const file = bundle.entities.find((entity) => entity.entityClass === "File");
      const method = bundle.entities.find(
        (entity) => entity.entityClass === "Method",
      );
      expect(file).toMatchObject({
        name: "a.ts",
        normalizedSignature: "src/a.ts",
        structuralContext: "src/a.ts",
        properties: {
          extension: ".ts",
          fileHash: "hash-a",
          projectionVersion: "legacy-v1",
        },
      });
      expect(method).toMatchObject({
        name: "target",
        normalizedSignature: "target(): void",
        structuralContext: "src/a.ts:A:A.target",
      });

      const calls = bundle.relations.find(
        (relation) => relation.relationType === "CALLS",
      );
      const imports = bundle.relations.find(
        (relation) => relation.relationType === "IMPORTS",
      );
      expect(calls).toMatchObject({
        confidence: 0.92,
        confidenceLevel: "high",
        properties: {
          projectionVersion: "legacy-v1",
          legacyEdgeCount: 2,
          evidenceCount: 2,
        },
      });
      expect(imports).toMatchObject({
        confidence: 0.7,
        confidenceLevel: "medium",
        properties: {
          projectionVersion: "legacy-v1",
          legacyEdgeCount: 1,
          evidenceCount: 1,
        },
      });

      expect(
        bundle.evidence.filter(
          (item) =>
            item.payload.semanticRelationId === calls?.semanticRelationId,
        ),
      ).toHaveLength(2);
      expect(bundle.evidence.every((item) => item.polarity === "supports")).toBe(
        true,
      );
      expect(
        bundle.evidence.every((item) => item.sourcePath === "src/a.ts"),
      ).toBe(true);
      expect(
        bundle.evidence.every(
          (item) =>
            item.snapshotId === bundle.snapshot.snapshotId &&
            item.extractorVersion.endsWith("@legacy-v1"),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps semantic identities stable while snapshot content changes", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const first = project(db, FIRST_OBSERVED_AT);
      const replay = project(db, SECOND_OBSERVED_AT);

      expect(replay.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
      expect(replay.entities.map((entity) => entity.semanticId)).toEqual(
        first.entities.map((entity) => entity.semanticId),
      );
      expect(replay.relations.map((relation) => relation.semanticRelationId)).toEqual(
        first.relations.map((relation) => relation.semanticRelationId),
      );

      const firstFile = first.entities.find(
        (entity) => entity.entityClass === "File",
      );
      db.db
        .prepare(
          "UPDATE file_hashes SET sha256 = ?, mtime_ns = ? WHERE project = ? AND rel_path = ?",
        )
        .run("hash-b", 2, PROJECT, "src/a.ts");
      const changed = project(db, SECOND_OBSERVED_AT);
      const changedFile = changed.entities.find(
        (entity) => entity.entityClass === "File",
      );

      expect(changed.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
      expect(changedFile?.semanticId).toBe(firstFile?.semanticId);
      expect(changedFile?.properties.fileHash).toBe("hash-b");
    } finally {
      db.close();
    }
  });
});
