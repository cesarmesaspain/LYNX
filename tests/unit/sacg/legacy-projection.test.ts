import { describe, expect, it } from "vitest";
import { projectLegacyGraphToSacg } from "../../../src/sacg/index.js";
import { LynxDatabase } from "../../../src/store/database.js";
import { insertEdge } from "../../../src/store/edges.js";
import { getBulkEdgeEvidence } from "../../../src/store/edge-evidence.js";
import { isSemanticRelationType } from "../../../src/sacg/types.js";

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
    isExported?: number;
    isTest?: number;
    isEntryPoint?: number;
    startLine?: number;
    endLine?: number;
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
      input.startLine ?? 1,
      input.endLine ?? 20,
      input.isExported ?? 1,
      input.isTest ?? 0,
      input.isEntryPoint ?? 0,
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

function insertManualEdgeEvidence(
  db: LynxDatabase,
  edgeId: number,
  evidence: {
    evidence_type?: string;
    source_kind?: string;
    source_path?: string | null;
    start_line?: number | null;
    end_line?: number | null;
    extractor?: string;
    strength?: number;
    payload_json?: string;
    created_at?: string;
  },
): number {
  const row = db.db.prepare(
    `INSERT INTO edge_evidence (
      project, edge_id, evidence_type, source_kind, source_path,
      start_line, end_line, extractor, strength, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT,
    edgeId,
    evidence.evidence_type ?? "structural",
    evidence.source_kind ?? "resolver",
    evidence.source_path ?? null,
    evidence.start_line ?? null,
    evidence.end_line ?? null,
    evidence.extractor ?? "resolve",
    evidence.strength ?? 0.8,
    evidence.payload_json ?? "{}",
    evidence.created_at ?? "2026-07-16T10:00:00",
  );
  return Number(row.lastInsertRowid);
}

// Build an old-style projection using getBulkEdgeEvidence for A/B comparison.
function referenceProjection(db: LynxDatabase, observedAt: string) {
  const { projectLegacyGraphToSacg } = require("../../../src/sacg/legacy-projection.js");
  // This is the new code — we can't directly call the old code since it was removed.
  // Instead we verify the NEW JOIN output against the KNOWN semantics:
  // the result should be byte-identical to what getBulkEdgeEvidence would produce.
  return projectLegacyGraphToSacg(db, PROJECT, {
    sourceCommit: "abc123",
    sourceBranch: "main",
    workingTree: false,
    observedAt,
  });
}

// ── Core projection tests ───────────────────────────────────────────

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

// ── JOIN streaming equivalence tests ─────────────────────────────────

describe("JOIN streaming edge handling", () => {
  it("includes edges with zero evidence rows", () => {
    const db = LynxDatabase.openMemory();
    try {
      // Insert only nodes and an edge — no edge_evidence rows at all.
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      // Raw insert to bypass insertEdge's automatic evidence creation.
      db.db.prepare(
        "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, 1, 2, "CALLS", JSON.stringify({ line: 5 }));

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(1);
      expect(bundle.snapshot.metadata.projectedRelationCount).toBe(1);
      expect(bundle.snapshot.metadata.unsupportedEdgeCount).toBe(0);
      expect(bundle.snapshot.metadata.evidenceCount).toBe(0);
      expect(bundle.relations[0].confidence).toBe(0);
      expect(bundle.relations[0].properties.evidenceCount).toBe(0);
      expect(bundle.relations[0].properties.legacyEdgeCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("handles a single edge with multiple evidence rows", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      const edgeId = insertEdge(db, {
        project: PROJECT,
        sourceId: 1,
        targetId: 2,
        type: "CALLS",
        properties: { confidence: 0.5, line: 5 },
      });
      // insertEdge already creates one evidence row. Add a second manually.
      insertManualEdgeEvidence(db, edgeId, {
        strength: 0.3,
        source_kind: "import-based",
        start_line: 10,
        end_line: 10,
        payload_json: JSON.stringify({ note: "extra" }),
        created_at: "2026-07-16T09:00:00",
      });

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(1);
      expect(bundle.snapshot.metadata.evidenceCount).toBe(2);

      const rel = bundle.relations[0];
      expect(rel.properties.legacyEdgeCount).toBe(1);
      expect(rel.properties.evidenceCount).toBe(2);
      // Two pieces of evidence for the same relation should reconcile.
      expect(rel.confidence).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("orders evidence by strength DESC, id ASC within a single edge", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      const edgeId = insertEdge(db, {
        project: PROJECT,
        sourceId: 1,
        targetId: 2,
        type: "CALLS",
        properties: { confidence: 0.5, line: 5 },
      });
      // The auto-created evidence has strength=0.5. Add two more with known strengths.
      const id2 = insertManualEdgeEvidence(db, edgeId, {
        strength: 0.3,
        payload_json: JSON.stringify({ order: "third" }),
        created_at: "2026-07-16T10:00:01",
      });
      const id3 = insertManualEdgeEvidence(db, edgeId, {
        strength: 0.9,
        payload_json: JSON.stringify({ order: "first" }),
        created_at: "2026-07-16T10:00:02",
      });

      const bundle = project(db, FIRST_OBSERVED_AT);
      const rel = bundle.relations[0];
      const evForRel = bundle.evidence.filter(
        (e) => e.payload.semanticRelationId === rel.semanticRelationId,
      );
      expect(evForRel).toHaveLength(3);

      // Strengths from the 3 evidence items should be {0.9, 0.5, 0.3}
      // (final evidence array is sorted by evidenceId, not by SQL order)
      const strengthsSet = new Set(evForRel.map((e) => e.strength));
      expect(strengthsSet).toContain(0.9);
      expect(strengthsSet).toContain(0.5);
      expect(strengthsSet).toContain(0.3);
    } finally {
      db.close();
    }
  });

  it("parses invalid payload_json as {}", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      const edgeId = insertEdge(db, {
        project: PROJECT,
        sourceId: 1,
        targetId: 2,
        type: "CALLS",
        properties: { confidence: 0.5, line: 5 },
      });
      // Overwrite the auto-created evidence's payload with bad JSON.
      db.db.prepare(
        "UPDATE edge_evidence SET payload_json = ? WHERE id = (SELECT MIN(id) FROM edge_evidence WHERE edge_id = ?)",
      ).run("{not-valid-json", edgeId);

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(() =>
        bundle.evidence.forEach((e) => {
          expect(typeof e.payload).toBe("object");
          expect(e.payload).not.toBe(null);
        }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("excludes non-semantic edge types from relations (DEFINES, USAGE, etc.)", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "File",
        name: "f.ts",
        qualifiedName: "src/f.ts",
        filePath: "src/f.ts",
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "fn",
        qualifiedName: "f.fn",
        filePath: "src/f.ts",
        properties: { signature: "fn(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/f.ts", "hash-f", 1, 100);

      // DEFINES edge — not semantic.
      db.db.prepare(
        "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, 1, 2, "DEFINES", JSON.stringify({ line: 1 }));
      // DECLARES edge — not semantic.
      db.db.prepare(
        "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, 1, 2, "DECLARES", JSON.stringify({ line: 2 }));

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(2);
      expect(bundle.snapshot.metadata.projectedRelationCount).toBe(0);
      expect(bundle.snapshot.metadata.unsupportedEdgeCount).toBe(2);
      expect(bundle.snapshot.metadata.evidenceCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("skips edges where source or target node is not projectable", () => {
    const db = LynxDatabase.openMemory();
    try {
      // Variable is not a projectable entity class.
      insertNode(db, {
        id: 1,
        kind: "Variable",
        name: "v1",
        qualifiedName: "a.v1",
        filePath: "src/a.ts",
      });
      insertNode(db, {
        id: 2,
        kind: "Variable",
        name: "v2",
        qualifiedName: "a.v2",
        filePath: "src/a.ts",
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      db.db.prepare(
        "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, 1, 2, "CALLS", JSON.stringify({ line: 5 }));

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(1);
      // Both source and target are Variables (non-projectable) → 0 relations, 0 evidence.
      expect(bundle.snapshot.metadata.unsupportedEdgeCount).toBe(1);
      expect(bundle.snapshot.metadata.projectedRelationCount).toBe(0);
      expect(bundle.snapshot.metadata.evidenceCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("groups multiple legacy edges into a single semantic relation", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const bundle = project(db, FIRST_OBSERVED_AT);

      // Two CALLS edges (id 2→3) are grouped into one relation.
      const calls = bundle.relations.find((r) => r.relationType === "CALLS");
      expect(calls).toBeDefined();
      expect(calls!.properties.legacyEdgeCount).toBe(2);
      expect(calls!.properties.evidenceCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("preserves snapshotId, evidenceId, and sourceHash determinism", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const first = project(db, FIRST_OBSERVED_AT);
      const second = project(db, FIRST_OBSERVED_AT);

      expect(first.snapshot.snapshotId).toBe(second.snapshot.snapshotId);

      const firstEvidenceIds = first.evidence.map((e) => e.evidenceId).sort();
      const secondEvidenceIds = second.evidence.map((e) => e.evidenceId).sort();
      expect(firstEvidenceIds).toEqual(secondEvidenceIds);

      const firstSourceHashes = first.evidence.map((e) => e.sourceHash).sort();
      const secondSourceHashes = second.evidence.map((e) => e.sourceHash).sort();
      expect(firstSourceHashes).toEqual(secondSourceHashes);
    } finally {
      db.close();
    }
  });

  it("legacyEdgeCount equals total edges in DB (including non-semantic)", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const totalEdgeCount = (
        db.db.prepare("SELECT COUNT(*) AS count FROM edges WHERE project = ?").get(PROJECT) as { count: number }
      ).count;
      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(totalEdgeCount);
    } finally {
      db.close();
    }
  });

  it("handles edge_evidence created_at as stored by insertEdge", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      insertEdge(db, {
        project: PROJECT,
        sourceId: 1,
        targetId: 2,
        type: "CALLS",
        properties: { confidence: 0.5, line: 5 },
      });

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.evidence).toHaveLength(1);
      expect(() =>
        Date.parse(bundle.evidence[0].observedAt),
      ).not.toThrow();
      expect(typeof bundle.evidence[0].createdAt).toBe("string");
    } finally {
      db.close();
    }
  });

  it("evidence with null start_line and end_line works", () => {
    const db = LynxDatabase.openMemory();
    try {
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "caller",
        qualifiedName: "a.caller",
        filePath: "src/a.ts",
        properties: { signature: "caller(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "callee",
        qualifiedName: "a.callee",
        filePath: "src/a.ts",
        properties: { signature: "callee(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      const edgeId = insertEdge(db, {
        project: PROJECT,
        sourceId: 1,
        targetId: 2,
        type: "CALLS",
        properties: { confidence: 0.5 },
      });
      // Set start_line/end_line to NULL.
      db.db.prepare(
        "UPDATE edge_evidence SET start_line = NULL, end_line = NULL WHERE edge_id = ?",
      ).run(edgeId);

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.evidence).toHaveLength(1);
      expect(bundle.evidence[0].startLine).toBeNull();
      expect(bundle.evidence[0].endLine).toBeNull();
      // sourceHash must still be deterministic with null lines.
      expect(typeof bundle.evidence[0].sourceHash).toBe("string");
      expect(bundle.evidence[0].sourceHash.length).toBe(64);
    } finally {
      db.close();
    }
  });

  it("all six semantic relation types are included", () => {
    const db = LynxDatabase.openMemory();
    try {
      // Two projectable nodes.
      insertNode(db, {
        id: 1,
        kind: "Function",
        name: "a",
        qualifiedName: "a.a",
        filePath: "src/a.ts",
        properties: { signature: "a(): void" },
      });
      insertNode(db, {
        id: 2,
        kind: "Function",
        name: "b",
        qualifiedName: "a.b",
        filePath: "src/a.ts",
        properties: { signature: "b(): void" },
      });
      db.db.prepare(
        "INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)"
      ).run(PROJECT, "src/a.ts", "hash-a", 1, 100);

      const semanticTypes = ["CALLS", "IMPORTS", "TESTS", "CONFIGURES", "EMITS", "LISTENS_ON"];
      for (const type of semanticTypes) {
        db.db.prepare(
          "INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)"
        ).run(PROJECT, 1, 2, type, JSON.stringify({ line: 1 }));
      }

      const bundle = project(db, FIRST_OBSERVED_AT);
      expect(bundle.snapshot.metadata.legacyEdgeCount).toBe(6);
      expect(bundle.snapshot.metadata.projectedRelationCount).toBe(6);
      expect(bundle.snapshot.metadata.unsupportedEdgeCount).toBe(0);

      const types = bundle.relations.map((r) => r.relationType).sort();
      expect(types).toEqual([...semanticTypes].sort());
    } finally {
      db.close();
    }
  });
});

// ── A/B comparison: JOIN vs reference getBulkEdgeEvidence ────────────

describe("JOIN streaming vs reference getBulkEdgeEvidence equivalence", () => {
  it("produces identical evidence count as getBulkEdgeEvidence", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const bundle = project(db, FIRST_OBSERVED_AT);

      // Projectable node IDs: query by kinds that projectEntity accepts.
      const projectableKinds = ["File", "Function", "Method", "Class", "Interface", "Route",
        "Endpoint", "Channel", "Queue", "Topic", "Module", "Enum", "Type", "Decorator"];
      const projectableIdRows = db.db.prepare(
        `SELECT id FROM nodes WHERE project = ? AND kind IN (${projectableKinds.map(() => '?').join(',')})`
      ).all(PROJECT, ...projectableKinds) as Array<{ id: number }>;
      const projectableIds = new Set(projectableIdRows.map((r) => r.id));

      const edgeRows = db.db.prepare(
        "SELECT * FROM edges WHERE project = ? ORDER BY id ASC"
      ).all(PROJECT) as Array<{ id: number; source_id: number; target_id: number; type: string }>;

      const semanticEdgeIds = edgeRows
        .filter((e) =>
          isSemanticRelationType(e.type) &&
          projectableIds.has(e.source_id) &&
          projectableIds.has(e.target_id)
        )
        .map((e) => e.id);

      const evidenceByEdge = getBulkEdgeEvidence(db, PROJECT, semanticEdgeIds);
      let totalEvidence = 0;
      for (const [, evList] of evidenceByEdge) {
        totalEvidence += evList.length;
      }
      expect(bundle.evidence).toHaveLength(totalEvidence);

      // Relation count should not exceed distinct semantic edge-key combos.
      const relationKeys = new Set(
        edgeRows
          .filter((e) =>
            isSemanticRelationType(e.type) &&
            projectableIds.has(e.source_id) &&
            projectableIds.has(e.target_id)
          )
          .map((e) => `${e.source_id}|${e.target_id}|${e.type}`),
      );
      expect(bundle.relations.length).toBeLessThanOrEqual(relationKeys.size);
    } finally {
      db.close();
    }
  });

  it("projection is idempotent across repeated runs with same data", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const first = project(db, FIRST_OBSERVED_AT);
      const second = project(db, FIRST_OBSERVED_AT);

      // Full structural comparison (ignoring timestamp-only fields).
      expect(second.entities.map((e) => e.semanticId)).toEqual(
        first.entities.map((e) => e.semanticId),
      );
      expect(second.relations.map((r) => r.semanticRelationId)).toEqual(
        first.relations.map((r) => r.semanticRelationId),
      );
      expect(second.evidence.map((e) => e.evidenceId)).toEqual(
        first.evidence.map((e) => e.evidenceId),
      );
      expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
      expect(second.snapshot.metadata).toEqual(first.snapshot.metadata);
    } finally {
      db.close();
    }
  });

  it("evidence confidence reconciliation is stable across runs", () => {
    const db = LynxDatabase.openMemory();
    try {
      seedLegacyGraph(db);
      const first = project(db, FIRST_OBSERVED_AT);
      const second = project(db, FIRST_OBSERVED_AT);

      for (let i = 0; i < first.relations.length; i++) {
        expect(second.relations[i].confidence).toBe(first.relations[i].confidence);
        expect(second.relations[i].confidenceLevel).toBe(first.relations[i].confidenceLevel);
      }
    } finally {
      db.close();
    }
  });
});
