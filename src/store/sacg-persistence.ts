import { serializeEvidencePayload } from "../sacg/evidence-payload.js";
import type {
  Evidence,
  GraphSnapshot,
  SemanticEntity,
  SemanticRelation,
} from "../sacg/types.js";
import type { LynxDatabase } from "./database.js";

export interface SacgSnapshotWrite {
  snapshot: GraphSnapshot;
  entities: readonly SemanticEntity[];
  relations: readonly SemanticRelation[];
  evidence: readonly Evidence[];
}

export interface PersistSacgSnapshotResult {
  project: string;
  snapshotId: string;
  entities: number;
  relations: number;
  evidence: number;
}

export interface PersistSacgSnapshotOptions {
  /**
   * Skip recursive JSON normalization when the bundle was produced by the
   * trusted SACG projector, which already normalizes every payload. External
   * callers should keep the safe default.
   */
  canonicalPayloads?: boolean;
  /** Content-addressed projectors may treat an existing snapshot as immutable. */
  skipExistingSnapshot?: boolean;
  /**
   * Stage evidence rows in a TEMP table and flush via a single
   * INSERT ... SELECT ... ON CONFLICT instead of row-by-row upserts. Same
   * semantics, lower SQLite overhead.
   */
  bulkEvidence?: boolean;
}

function assertSnapshotBundle(input: SacgSnapshotWrite): void {
  const { project, snapshotId } = input.snapshot;

  if (!project.trim()) {
    throw new Error("SACG snapshot project must be non-empty");
  }
  if (!snapshotId.trim()) {
    throw new Error("SACG snapshot ID must be non-empty");
  }

  for (const entity of input.entities) {
    if (entity.project !== project) {
      throw new Error(
        `SACG entity ${entity.semanticId} belongs to project ${entity.project}, expected ${project}`,
      );
    }
    if (entity.lastSeenSnapshot !== snapshotId) {
      throw new Error(
        `SACG entity ${entity.semanticId} lastSeenSnapshot must equal ${snapshotId}`,
      );
    }
  }

  for (const relation of input.relations) {
    if (relation.project !== project) {
      throw new Error(
        `SACG relation ${relation.semanticRelationId} belongs to project ${relation.project}, expected ${project}`,
      );
    }
    if (relation.lastSeenSnapshot !== snapshotId) {
      throw new Error(
        `SACG relation ${relation.semanticRelationId} lastSeenSnapshot must equal ${snapshotId}`,
      );
    }
  }

  for (const item of input.evidence) {
    if (item.project !== project) {
      throw new Error(
        `SACG evidence ${item.evidenceId} belongs to project ${item.project}, expected ${project}`,
      );
    }
    if (item.snapshotId !== snapshotId) {
      throw new Error(
        `SACG evidence ${item.evidenceId} snapshotId must equal ${snapshotId}`,
      );
    }
  }
}

export function persistSacgSnapshot(
  db: LynxDatabase,
  input: SacgSnapshotWrite,
  options: PersistSacgSnapshotOptions = {},
): PersistSacgSnapshotResult {
  const _timings: Record<string, number> = {};
  let _t = Date.now();
  const _mark = (label: string) => {
    const now = Date.now();
    _timings[label] = now - _t;
    _t = now;
  };

  assertSnapshotBundle(input);
  _mark("assert");
  if (options.skipExistingSnapshot) {
    const existing = db.db
      .prepare(
        "SELECT 1 FROM graph_snapshots WHERE project = ? AND snapshot_id = ?",
      )
      .get(input.snapshot.project, input.snapshot.snapshotId);
    if (existing) {
      return {
        project: input.snapshot.project,
        snapshotId: input.snapshot.snapshotId,
        entities: input.entities.length,
        relations: input.relations.length,
        evidence: input.evidence.length,
      };
    }
  }
  const serialize = options.canonicalPayloads
    ? (value: unknown): string => JSON.stringify(value)
    : serializeEvidencePayload;

  const insertSnapshot = db.db.prepare(`
    INSERT INTO graph_snapshots (
      snapshot_id, project, status, source_commit, source_branch, working_tree,
      valid_from, valid_to, created_at, completed_at, metadata_json
    ) VALUES (
      @snapshot_id, @project, @status, @source_commit, @source_branch, @working_tree,
      @valid_from, @valid_to, @created_at, @completed_at, @metadata_json
    )
    ON CONFLICT(project, snapshot_id) DO UPDATE SET
      status = excluded.status,
      source_commit = excluded.source_commit,
      source_branch = excluded.source_branch,
      working_tree = excluded.working_tree,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      completed_at = excluded.completed_at,
      metadata_json = excluded.metadata_json
  `);

  const upsertEntity = db.db.prepare(`
    INSERT INTO semantic_entities (
      project, semantic_id, entity_class, name, qualified_name,
      normalized_signature, structural_context, properties_json,
      first_seen_snapshot, last_seen_snapshot, valid_from, valid_to,
      created_at, updated_at
    ) VALUES (
      @project, @semantic_id, @entity_class, @name, @qualified_name,
      @normalized_signature, @structural_context, @properties_json,
      @first_seen_snapshot, @last_seen_snapshot, @valid_from, @valid_to,
      @created_at, @updated_at
    )
    ON CONFLICT(project, semantic_id) DO UPDATE SET
      entity_class = excluded.entity_class,
      name = excluded.name,
      qualified_name = excluded.qualified_name,
      normalized_signature = excluded.normalized_signature,
      structural_context = excluded.structural_context,
      properties_json = excluded.properties_json,
      last_seen_snapshot = excluded.last_seen_snapshot,
      valid_to = excluded.valid_to,
      updated_at = excluded.updated_at
  `);

  const upsertRelation = db.db.prepare(`
    INSERT INTO semantic_relations (
      project, semantic_relation_id, source_semantic_id, relation_type,
      target_semantic_id, scope_json, properties_json, confidence,
      confidence_level, first_seen_snapshot, last_seen_snapshot, valid_from,
      valid_to, created_at, updated_at
    ) VALUES (
      @project, @semantic_relation_id, @source_semantic_id, @relation_type,
      @target_semantic_id, @scope_json, @properties_json, @confidence,
      @confidence_level, @first_seen_snapshot, @last_seen_snapshot, @valid_from,
      @valid_to, @created_at, @updated_at
    )
    ON CONFLICT(project, semantic_relation_id) DO UPDATE SET
      source_semantic_id = excluded.source_semantic_id,
      relation_type = excluded.relation_type,
      target_semantic_id = excluded.target_semantic_id,
      scope_json = excluded.scope_json,
      properties_json = excluded.properties_json,
      confidence = excluded.confidence,
      confidence_level = excluded.confidence_level,
      last_seen_snapshot = excluded.last_seen_snapshot,
      valid_to = excluded.valid_to,
      updated_at = excluded.updated_at
  `);

  const upsertEvidence = db.db.prepare(`
    INSERT INTO evidence (
      evidence_id, project, evidence_type, polarity, source_kind, source_path,
      source_hash, start_line, end_line, symbol_semantic_id, extractor,
      extractor_version, payload_json, strength, independence_group,
      observed_at, snapshot_id, created_at
    ) VALUES (
      @evidence_id, @project, @evidence_type, @polarity, @source_kind, @source_path,
      @source_hash, @start_line, @end_line, @symbol_semantic_id, @extractor,
      @extractor_version, @payload_json, @strength, @independence_group,
      @observed_at, @snapshot_id, @created_at
    )
    ON CONFLICT(project, evidence_id) DO UPDATE SET
      evidence_type = excluded.evidence_type,
      polarity = excluded.polarity,
      source_kind = excluded.source_kind,
      source_path = excluded.source_path,
      source_hash = excluded.source_hash,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      symbol_semantic_id = excluded.symbol_semantic_id,
      extractor = excluded.extractor,
      extractor_version = excluded.extractor_version,
      payload_json = excluded.payload_json,
      strength = excluded.strength,
      independence_group = excluded.independence_group,
      observed_at = excluded.observed_at,
      snapshot_id = excluded.snapshot_id
  `);

  const stagingBulkEvidence = options.bulkEvidence
    ? (items: readonly Evidence[]) => {
        if (items.length === 0) return;
        // TEMP staging table: same column structure, no indexes or FKs.
        db.db.exec(`
          CREATE TEMP TABLE IF NOT EXISTS _bulk_evidence (
            ordinal INTEGER NOT NULL,
            evidence_id TEXT NOT NULL,
            project TEXT NOT NULL,
            evidence_type TEXT NOT NULL,
            polarity TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_path TEXT,
            source_hash TEXT NOT NULL,
            start_line INTEGER,
            end_line INTEGER,
            symbol_semantic_id TEXT,
            extractor TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            strength REAL NOT NULL,
            independence_group TEXT,
            observed_at TEXT NOT NULL,
            snapshot_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        db.db.exec("DELETE FROM _bulk_evidence");

        const insertStaging = db.db.prepare(`
          INSERT INTO _bulk_evidence (
            ordinal, evidence_id, project, evidence_type, polarity, source_kind, source_path,
            source_hash, start_line, end_line, symbol_semantic_id, extractor,
            extractor_version, payload_json, strength, independence_group,
            observed_at, snapshot_id, created_at
          ) VALUES (
            @ordinal, @evidence_id, @project, @evidence_type, @polarity, @source_kind, @source_path,
            @source_hash, @start_line, @end_line, @symbol_semantic_id, @extractor,
            @extractor_version, @payload_json, @strength, @independence_group,
            @observed_at, @snapshot_id, @created_at
          )
        `);

        for (const [ordinal, item] of items.entries()) {
          insertStaging.run({
            ordinal,
            evidence_id: item.evidenceId,
            project: item.project,
            evidence_type: item.evidenceType,
            polarity: item.polarity,
            source_kind: item.sourceKind,
            source_path: item.sourcePath,
            source_hash: item.sourceHash,
            start_line: item.startLine,
            end_line: item.endLine,
            symbol_semantic_id: item.symbolSemanticId,
            extractor: item.extractor,
            extractor_version: item.extractorVersion,
            payload_json: serialize(item.payload),
            strength: item.strength,
            independence_group: item.independenceGroup,
            observed_at: item.observedAt,
            snapshot_id: item.snapshotId,
            created_at: item.createdAt,
          });
        }

        // Flush staging into real evidence table in one shot.
        db.db.exec(`
          INSERT INTO evidence (
            evidence_id, project, evidence_type, polarity, source_kind, source_path,
            source_hash, start_line, end_line, symbol_semantic_id, extractor,
            extractor_version, payload_json, strength, independence_group,
            observed_at, snapshot_id, created_at
          )
          SELECT
            evidence_id, project, evidence_type, polarity, source_kind, source_path,
            source_hash, start_line, end_line, symbol_semantic_id, extractor,
            extractor_version, payload_json, strength, independence_group,
            observed_at, snapshot_id, created_at
          FROM _bulk_evidence
          ORDER BY ordinal ASC
          ON CONFLICT(project, evidence_id) DO UPDATE SET
            evidence_type = excluded.evidence_type,
            polarity = excluded.polarity,
            source_kind = excluded.source_kind,
            source_path = excluded.source_path,
            source_hash = excluded.source_hash,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            symbol_semantic_id = excluded.symbol_semantic_id,
            extractor = excluded.extractor,
            extractor_version = excluded.extractor_version,
            payload_json = excluded.payload_json,
            strength = excluded.strength,
            independence_group = excluded.independence_group,
            observed_at = excluded.observed_at,
            snapshot_id = excluded.snapshot_id
        `);

        db.db.exec("DELETE FROM _bulk_evidence");
      }
    : null;

  db.transaction(() => {
    const snapshot = input.snapshot;
    insertSnapshot.run({
      snapshot_id: snapshot.snapshotId,
      project: snapshot.project,
      status: snapshot.status,
      source_commit: snapshot.sourceCommit,
      source_branch: snapshot.sourceBranch,
      working_tree: snapshot.workingTree ? 1 : 0,
      valid_from: snapshot.validFrom,
      valid_to: snapshot.validTo,
      created_at: snapshot.createdAt,
      completed_at: snapshot.completedAt,
      metadata_json: serialize(snapshot.metadata),
    });
    _mark("snapshot");

    for (const entity of input.entities) {
      upsertEntity.run({
        project: entity.project,
        semantic_id: entity.semanticId,
        entity_class: entity.entityClass,
        name: entity.name,
        qualified_name: entity.qualifiedName,
        normalized_signature: entity.normalizedSignature,
        structural_context: entity.structuralContext,
        properties_json: serialize(entity.properties),
        first_seen_snapshot: entity.firstSeenSnapshot,
        last_seen_snapshot: entity.lastSeenSnapshot,
        valid_from: entity.validFrom,
        valid_to: entity.validTo,
        created_at: entity.createdAt,
        updated_at: entity.updatedAt,
      });
    }
    _mark("entities");

    for (const relation of input.relations) {
      upsertRelation.run({
        project: relation.project,
        semantic_relation_id: relation.semanticRelationId,
        source_semantic_id: relation.sourceSemanticId,
        relation_type: relation.relationType,
        target_semantic_id: relation.targetSemanticId,
        scope_json: serialize(relation.scope),
        properties_json: serialize(relation.properties),
        confidence: relation.confidence,
        confidence_level: relation.confidenceLevel,
        first_seen_snapshot: relation.firstSeenSnapshot,
        last_seen_snapshot: relation.lastSeenSnapshot,
        valid_from: relation.validFrom,
        valid_to: relation.validTo,
        created_at: relation.createdAt,
        updated_at: relation.updatedAt,
      });
    }
    _mark("relations");

    if (stagingBulkEvidence) {
      stagingBulkEvidence(input.evidence);
    } else {
      for (const item of input.evidence) {
        upsertEvidence.run({
          evidence_id: item.evidenceId,
          project: item.project,
          evidence_type: item.evidenceType,
          polarity: item.polarity,
          source_kind: item.sourceKind,
          source_path: item.sourcePath,
          source_hash: item.sourceHash,
          start_line: item.startLine,
          end_line: item.endLine,
          symbol_semantic_id: item.symbolSemanticId,
          extractor: item.extractor,
          extractor_version: item.extractorVersion,
          payload_json: serialize(item.payload),
          strength: item.strength,
          independence_group: item.independenceGroup,
          observed_at: item.observedAt,
          snapshot_id: item.snapshotId,
          created_at: item.createdAt,
        });
      }
    }
    _mark("evidence");
  });

  if (process.env.LYNX_PROFILE) {
    process.stderr.write(
      `[sacg-persist.profile] ${JSON.stringify(_timings)}\n`,
    );
  }

  return {
    project: input.snapshot.project,
    snapshotId: input.snapshot.snapshotId,
    entities: input.entities.length,
    relations: input.relations.length,
    evidence: input.evidence.length,
  };
}
