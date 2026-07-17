import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LynxDatabase } from "../../../src/store/database.js";

describe("SACG vertical slice schema", () => {
  it("creates the additive tables, critical indexes, and migration ledger entry", () => {
    const db = LynxDatabase.openMemory();
    try {
      const tables = db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('graph_snapshots', 'semantic_entities', 'semantic_relations', 'evidence') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "evidence",
        "graph_snapshots",
        "semantic_entities",
        "semantic_relations",
      ]);

      const indexes = db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = new Set(indexes.map((row) => row.name));
      for (const index of [
        "idx_graph_snapshots_project_validity",
        "idx_semantic_entities_project_class",
        "idx_semantic_relations_source_type",
        "idx_semantic_relations_target_type",
        "idx_evidence_source_hash",
      ]) {
        expect(names.has(index)).toBe(true);
      }

      expect(
        db.db
          .prepare(
            "SELECT version, name FROM schema_migrations WHERE version = 3",
          )
          .get(),
      ).toEqual({ version: 3, name: "SACG vertical slice tables" });
    } finally {
      db.close();
    }
  });

  it("enforces project-scoped identity, foreign keys, and evidence bounds", () => {
    const db = LynxDatabase.openMemory();
    try {
      const insertSnapshot = db.db.prepare(
        "INSERT INTO graph_snapshots (snapshot_id, project, status) VALUES (?, ?, ?)",
      );
      insertSnapshot.run("snapshot-a", "project-a", "ready");
      insertSnapshot.run("snapshot-b", "project-b", "ready");

      const insertEntity = db.db.prepare(`
        INSERT INTO semantic_entities (
          project, semantic_id, entity_class, name, first_seen_snapshot, last_seen_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertEntity.run(
        "project-a",
        "semantic:file:shared",
        "File",
        "shared.ts",
        "snapshot-a",
        "snapshot-a",
      );
      insertEntity.run(
        "project-b",
        "semantic:file:shared",
        "File",
        "shared.ts",
        "snapshot-b",
        "snapshot-b",
      );
      insertEntity.run(
        "project-a",
        "semantic:file:target",
        "File",
        "target.ts",
        "snapshot-a",
        "snapshot-a",
      );
      expect(() =>
        insertEntity.run(
          "project-a",
          "semantic:file:shared",
          "File",
          "duplicate.ts",
          "snapshot-a",
          "snapshot-a",
        ),
      ).toThrow();

      const insertRelation = db.db.prepare(`
        INSERT INTO semantic_relations (
          project, semantic_relation_id, source_semantic_id, relation_type,
          target_semantic_id, scope_json, first_seen_snapshot, last_seen_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertRelation.run(
        "project-a",
        "relation-a",
        "semantic:file:shared",
        "IMPORTS",
        "semantic:file:target",
        "{}",
        "snapshot-a",
        "snapshot-a",
      );
      expect(() =>
        insertRelation.run(
          "project-a",
          "relation-b",
          "semantic:file:shared",
          "IMPORTS",
          "semantic:file:target",
          "{}",
          "snapshot-a",
          "snapshot-a",
        ),
      ).toThrow();

      const insertEvidence = db.db.prepare(`
        INSERT INTO evidence (
          evidence_id, project, evidence_type, polarity, source_kind, source_hash,
          extractor, extractor_version, strength, snapshot_id, symbol_semantic_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertEvidence.run(
        "evidence-a",
        "project-a",
        "ast",
        "supports",
        "extractor",
        "source-hash",
        "tree-sitter",
        "1",
        0.95,
        "snapshot-a",
        "semantic:file:shared",
      );
      expect(() =>
        insertEvidence.run(
          "evidence-duplicate",
          "project-a",
          "ast",
          "supports",
          "extractor",
          "source-hash",
          "tree-sitter",
          "1",
          0.95,
          "snapshot-a",
          "semantic:file:shared",
        ),
      ).toThrow();

      expect(() =>
        insertEvidence.run(
          "evidence-invalid-strength",
          "project-a",
          "ast",
          "supports",
          "extractor",
          "source-hash-strength",
          "tree-sitter",
          "1",
          1.5,
          "snapshot-a",
          "semantic:file:shared",
        ),
      ).toThrow();
      expect(() =>
        insertEvidence.run(
          "evidence-cross-project",
          "project-a",
          "ast",
          "supports",
          "extractor",
          "source-hash-cross-project",
          "tree-sitter",
          "1",
          0.9,
          "snapshot-b",
          "semantic:file:shared",
        ),
      ).toThrow();
      expect(() =>
        insertEvidence.run(
          "evidence-invalid-polarity",
          "project-a",
          "ast",
          "unknown",
          "extractor",
          "source-hash-polarity",
          "tree-sitter",
          "1",
          0.9,
          "snapshot-a",
          "semantic:file:shared",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("reopens idempotently without duplicating migration records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-sacg-schema-"));
    const dbPath = path.join(dir, "graph.db");

    try {
      LynxDatabase.openPath(dbPath).close();
      const reopened = LynxDatabase.openPath(dbPath);
      try {
        const migration = reopened.db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3",
          )
          .get() as { count: number };
        expect(migration.count).toBe(1);
        expect(
          reopened.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_relations'",
            )
            .get(),
        ).toEqual({ name: "semantic_relations" });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
