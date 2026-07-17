import { createHash } from "node:crypto";
import {
  generateEvidenceId,
  generateSemanticId,
  generateSemanticRelationId,
} from "./identity.js";
import {
  normalizeEvidencePayload,
  serializeEvidencePayload,
} from "./evidence-payload.js";
import { reconcileEvidenceConfidence } from "./reconciliation.js";
import {
  isSemanticEntityClass,
  isSemanticRelationType,
  type Evidence,
  type GraphSnapshot,
  type JsonObject,
  type SemanticEntity,
  type SemanticId,
  type SemanticRelation,
  type SemanticRelationType,
} from "./types.js";
import type { SacgSnapshotWrite } from "../store/sacg-persistence.js";
import type { LynxDatabase } from "../store/database.js";

const PROJECTION_VERSION = "legacy-v1";

interface LegacyNodeRow {
  id: number;
  project: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  is_exported: number;
  is_test: number;
  is_entry_point: number;
  properties: string;
  file_hash: string | null;
}

interface LegacyEdgeRow {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties: string;
}

interface EdgeEvidenceJoinRow {
  id: number;
  source_id: number;
  target_id: number;
  type: string;
  evidence_id: number | null;
  evidence_type: string | null;
  source_kind: string | null;
  source_path: string | null;
  start_line: number | null;
  end_line: number | null;
  extractor: string | null;
  strength: number | null;
  payload_json: string | null;
  created_at: string | null;
}

export interface LegacySacgProjectionContext {
  sourceCommit: string | null;
  sourceBranch: string | null;
  workingTree: boolean;
  observedAt?: string;
}

interface ProjectedNode {
  row: LegacyNodeRow;
  entity: SemanticEntity;
}

interface RelationAccumulator {
  relationType: SemanticRelationType;
  sourceSemanticId: SemanticId;
  targetSemanticId: SemanticId;
  legacyEdgeCount: number;
  evidence: Map<string, Evidence>;
}

function sha256(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function parseJsonObject(value: string): JsonObject {
  try {
    return normalizeEvidencePayload(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
}

function normalizeTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`).toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  throw new TypeError(`Invalid legacy evidence timestamp: ${value}`);
}

function normalizedSignature(
  row: LegacyNodeRow,
  properties: JsonObject,
): string {
  if (
    (row.kind === "Function" || row.kind === "Method") &&
    typeof properties.signature === "string" &&
    properties.signature.trim()
  ) {
    return properties.signature.trim();
  }
  return row.qualified_name;
}

function structuralContext(
  row: LegacyNodeRow,
  properties: JsonObject,
): string {
  if (
    row.kind === "Method" &&
    typeof properties.parentClass === "string" &&
    properties.parentClass.trim()
  ) {
    return `${row.file_path}:${properties.parentClass.trim()}:${row.qualified_name}`;
  }
  if (row.kind === "Function" || row.kind === "Class") {
    return `${row.file_path}:${row.qualified_name}`;
  }
  return row.file_path;
}

function projectEntity(
  row: LegacyNodeRow,
  project: string,
  timestamp: string,
): ProjectedNode | null {
  if (!isSemanticEntityClass(row.kind)) return null;

  const legacyProperties = parseJsonObject(row.properties);
  const signature = normalizedSignature(row, legacyProperties);
  const context = structuralContext(row, legacyProperties);
  const semanticId = generateSemanticId({
    projectNamespace: project,
    entityClass: row.kind,
    normalizedSignature: signature,
    structuralContext: context,
  });

  const properties = normalizeEvidencePayload({
    ...legacyProperties,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    isExported: row.is_exported === 1,
    isTest: row.is_test === 1,
    isEntryPoint: row.is_entry_point === 1,
    ...(row.file_hash ? { fileHash: row.file_hash } : {}),
    projectionVersion: PROJECTION_VERSION,
  });

  return {
    row,
    entity: {
      project,
      semanticId,
      entityClass: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name || null,
      normalizedSignature: signature,
      structuralContext: context,
      properties,
      firstSeenSnapshot: "",
      lastSeenSnapshot: "",
      validFrom: timestamp,
      validTo: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function buildEvidenceSourceHash(input: {
  project: string;
  sourceSemanticId: SemanticId;
  relationType: SemanticRelationType;
  targetSemanticId: SemanticId;
  sourcePath: string | null;
  startLine: number | null;
  endLine: number | null;
  sourceKind: string;
  extractor: string;
  strength: number;
  payload: JsonObject;
}): string {
  return sha256(
    JSON.stringify([
      PROJECTION_VERSION,
      input.project,
      input.sourceSemanticId,
      input.relationType,
      input.targetSemanticId,
      input.sourcePath,
      input.startLine,
      input.endLine,
      input.sourceKind,
      input.extractor,
      input.strength,
      serializeEvidencePayload(input.payload),
    ]),
  );
}

function projectionDigest(input: {
  project: string;
  sourceCommit: string | null;
  sourceBranch: string | null;
  workingTree: boolean;
  entities: readonly SemanticEntity[];
  relations: readonly SemanticRelation[];
  evidence: readonly Evidence[];
}): string {
  // Hash each canonical record independently. Building one giant JSON value
  // temporarily duplicates the whole projected graph and dominates memory on
  // large repositories. Length-prefixing each canonical chunk keeps the
  // stream unambiguous while preserving deterministic snapshot identities.
  const digest = createHash("sha256");
  const update = (value: JsonObject): void => {
    // Every nested payload was normalized when its entity/evidence was built,
    // and the wrapper keys below are declared in a fixed order. Re-normalizing
    // here would recursively sort the same graph a second time.
    const serialized = JSON.stringify(value);
    digest.update(String(Buffer.byteLength(serialized, "utf8")));
    digest.update(":");
    digest.update(serialized, "utf8");
  };

  update({
    projectionVersion: PROJECTION_VERSION,
    project: input.project,
    sourceCommit: input.sourceCommit,
    sourceBranch: input.sourceBranch,
    workingTree: input.workingTree,
  });
  for (const entity of input.entities) {
    update({
      recordType: "entity",
      entity: {
        semanticId: entity.semanticId,
        entityClass: entity.entityClass,
        name: entity.name,
        qualifiedName: entity.qualifiedName,
        normalizedSignature: entity.normalizedSignature,
        structuralContext: entity.structuralContext,
        properties: entity.properties,
      },
    });
  }
  for (const relation of input.relations) {
    update({
      recordType: "relation",
      relation: {
        semanticRelationId: relation.semanticRelationId,
        sourceSemanticId: relation.sourceSemanticId,
        relationType: relation.relationType,
        targetSemanticId: relation.targetSemanticId,
        scope: relation.scope,
        properties: relation.properties,
        confidence: relation.confidence,
        confidenceLevel: relation.confidenceLevel,
      },
    });
  }
  for (const item of input.evidence) {
    update({
      recordType: "evidence",
      evidence: {
        evidenceId: item.evidenceId,
        evidenceType: item.evidenceType,
        polarity: item.polarity,
        sourceKind: item.sourceKind,
        sourcePath: item.sourcePath,
        sourceHash: item.sourceHash,
        startLine: item.startLine,
        endLine: item.endLine,
        symbolSemanticId: item.symbolSemanticId,
        extractor: item.extractor,
        extractorVersion: item.extractorVersion,
        payload: item.payload,
        strength: item.strength,
        independenceGroup: item.independenceGroup,
      },
    });
  }
  return digest.digest("hex");
}

export function projectLegacyGraphToSacg(
  db: LynxDatabase,
  project: string,
  context: LegacySacgProjectionContext,
): SacgSnapshotWrite {
  const _timings: Record<string, number> = {};
  let _t = Date.now();
  const _mark = (label: string) => {
    const now = Date.now();
    _timings[label] = now - _t;
    _t = now;
  };

  if (!project.trim()) {
    throw new Error("SACG projection project must be non-empty");
  }

  const timestamp = context.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(
      "SACG projection observedAt must be a valid ISO timestamp",
    );
  }

  const nodeRows = db.db
    .prepare(`
      SELECT n.*, fh.sha256 AS file_hash
      FROM nodes n
      LEFT JOIN file_hashes fh
        ON fh.project = n.project AND fh.rel_path = n.file_path
      WHERE n.project = ?
      ORDER BY n.id ASC
    `)
    .all(project) as LegacyNodeRow[];
  _mark('select-nodes');

  const projectedNodes = nodeRows
    .map((row) => projectEntity(row, project, timestamp))
    .filter((item): item is ProjectedNode => item !== null);
  const nodeByLegacyId = new Map(
    projectedNodes.map((item) => [item.row.id, item]),
  );
  _mark('project-nodes');

  const relationGroups = new Map<string, RelationAccumulator>();
  let legacyEdgeCount = 0;
  let supportedEdgeCount = 0;

  const accumulateEdgeEvidence = (
    edge: { id: number; source_id: number; target_id: number; type: SemanticRelationType },
    evidenceRows: Array<{
      source_path: string | null;
      evidence_type: string;
      source_kind: string;
      start_line: number | null;
      end_line: number | null;
      extractor: string;
      strength: number;
      payload: unknown;
      created_at: string | null;
    }>,
  ): void => {
    const source = nodeByLegacyId.get(edge.source_id);
    const target = nodeByLegacyId.get(edge.target_id);
    if (!source || !target) return;

    const scope: JsonObject = {};
    const relationId = generateSemanticRelationId({
      projectNamespace: project,
      sourceSemanticId: source.entity.semanticId,
      relationType: edge.type,
      targetSemanticId: target.entity.semanticId,
      scope,
    });
    const group: RelationAccumulator = relationGroups.get(relationId) ?? {
      relationType: edge.type,
      sourceSemanticId: source.entity.semanticId,
      targetSemanticId: target.entity.semanticId,
      legacyEdgeCount: 0,
      evidence: new Map<string, Evidence>(),
    };
    group.legacyEdgeCount += 1;

    for (const ev of evidenceRows) {
      const sourcePath = ev.source_path ?? (source.row.file_path || null);
      const payload = normalizeEvidencePayload({
        ...(ev.payload !== null && typeof ev.payload === "object" && !Array.isArray(ev.payload)
          ? ev.payload as JsonObject
          : {}),
        semanticRelationId: relationId,
        sourceQualifiedName: source.row.qualified_name,
        targetQualifiedName: target.row.qualified_name,
        projectionVersion: PROJECTION_VERSION,
      });
      const extractorVersion = `${ev.extractor}@${PROJECTION_VERSION}`;
      const sourceHash = buildEvidenceSourceHash({
        project,
        sourceSemanticId: source.entity.semanticId,
        relationType: edge.type,
        targetSemanticId: target.entity.semanticId,
        sourcePath,
        startLine: ev.start_line,
        endLine: ev.end_line,
        sourceKind: ev.source_kind,
        extractor: ev.extractor,
        strength: ev.strength,
        payload,
      });
      const evidenceId = generateEvidenceId({
        projectNamespace: project,
        evidenceType: ev.evidence_type,
        sourceHash,
        sourcePath,
        startLine: ev.start_line,
        endLine: ev.end_line,
        symbolSemanticId: source.entity.semanticId,
        extractorVersion,
      });
      group.evidence.set(evidenceId, {
        evidenceId,
        project,
        evidenceType: ev.evidence_type,
        polarity: "supports",
        sourceKind: ev.source_kind,
        sourcePath,
        sourceHash,
        startLine: ev.start_line,
        endLine: ev.end_line,
        symbolSemanticId: source.entity.semanticId,
        extractor: ev.extractor,
        extractorVersion,
        payload,
        strength: ev.strength,
        independenceGroup: null,
        observedAt: normalizeTimestamp(ev.created_at ?? timestamp),
        snapshotId: "",
        createdAt: timestamp,
      });
    }

    relationGroups.set(relationId, group);
  };

  const joinIter = db.db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.type,
           ee.id AS evidence_id, ee.evidence_type, ee.source_kind, ee.source_path,
           ee.start_line, ee.end_line, ee.extractor, ee.strength,
           ee.payload_json, ee.created_at
    FROM edges e
    LEFT JOIN edge_evidence ee ON ee.project = e.project AND ee.edge_id = e.id
    WHERE e.project = ? AND e.type IN ('CALLS','IMPORTS','TESTS','CONFIGURES','EMITS','LISTENS_ON')
    ORDER BY e.id ASC, ee.strength DESC, ee.id ASC
  `).iterate(project) as IterableIterator<EdgeEvidenceJoinRow>;

  legacyEdgeCount = (
    db.db.prepare(
      "SELECT COUNT(*) AS count FROM edges WHERE project = ?",
    ).get(project) as { count: number }
  ).count;

  let currentEdge: { id: number; source_id: number; target_id: number; type: SemanticRelationType } | null = null;
  let currentEvidence: Array<{
    source_path: string | null;
    evidence_type: string;
    source_kind: string;
    start_line: number | null;
    end_line: number | null;
    extractor: string;
    strength: number;
    payload: unknown;
    created_at: string | null;
  }> = [];

  for (const row of joinIter) {
    if (!nodeByLegacyId.has(row.source_id) || !nodeByLegacyId.has(row.target_id)) {
      continue;
    }

    if (currentEdge === null || row.id !== currentEdge.id) {
      if (currentEdge !== null) {
        supportedEdgeCount += 1;
        accumulateEdgeEvidence(currentEdge, currentEvidence);
      }
      currentEdge = { id: row.id, source_id: row.source_id, target_id: row.target_id, type: row.type as SemanticRelationType };
      currentEvidence = [];
    }

    if (row.evidence_id !== null) {
      let payload: unknown = {};
      try {
        payload = JSON.parse(row.payload_json || '{}');
      } catch {
        payload = {};
      }
      currentEvidence.push({
        source_path: row.source_path,
        evidence_type: row.evidence_type!,
        source_kind: row.source_kind!,
        start_line: row.start_line,
        end_line: row.end_line,
        extractor: row.extractor!,
        strength: row.strength!,
        payload,
        created_at: row.created_at,
      });
    }
  }

  if (currentEdge !== null) {
    supportedEdgeCount += 1;
    accumulateEdgeEvidence(currentEdge, currentEvidence);
  }
  _mark('process-edges');

  const evidence = [...relationGroups.values()]
    .flatMap((group) => [...group.evidence.values()])
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const relations = [...relationGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([semanticRelationId, group]): SemanticRelation => {
      const reconciled = reconcileEvidenceConfidence(
        [...group.evidence.values()],
        { now: timestamp },
      );
      return {
        project,
        semanticRelationId,
        sourceSemanticId: group.sourceSemanticId,
        relationType: group.relationType,
        targetSemanticId: group.targetSemanticId,
        scope: {},
        properties: {
          projectionVersion: PROJECTION_VERSION,
          legacyEdgeCount: group.legacyEdgeCount,
          evidenceCount: group.evidence.size,
        },
        confidence: reconciled.confidence,
        confidenceLevel: reconciled.confidenceLevel,
        firstSeenSnapshot: "",
        lastSeenSnapshot: "",
        validFrom: timestamp,
        validTo: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  const entities = projectedNodes
    .map((item) => item.entity)
    .sort((left, right) => left.semanticId.localeCompare(right.semanticId));

  const digest = projectionDigest({
    project,
    sourceCommit: context.sourceCommit,
    sourceBranch: context.sourceBranch,
    workingTree: context.workingTree,
    entities,
    relations,
    evidence,
  });
  const snapshotId = `sacg-${PROJECTION_VERSION}-${digest}`;
  _mark('build-output');

  for (const entity of entities) {
    entity.firstSeenSnapshot = snapshotId;
    entity.lastSeenSnapshot = snapshotId;
  }
  for (const relation of relations) {
    relation.firstSeenSnapshot = snapshotId;
    relation.lastSeenSnapshot = snapshotId;
  }
  for (const item of evidence) {
    item.snapshotId = snapshotId;
  }

  const snapshot: GraphSnapshot = {
    snapshotId,
    project,
    status: "ready",
    sourceCommit: context.sourceCommit,
    sourceBranch: context.sourceBranch,
    workingTree: context.workingTree,
    validFrom: timestamp,
    validTo: null,
    createdAt: timestamp,
    completedAt: timestamp,
    metadata: {
      projectionVersion: PROJECTION_VERSION,
      legacyNodeCount: nodeRows.length,
      projectedEntityCount: entities.length,
      unsupportedNodeCount: nodeRows.length - entities.length,
      legacyEdgeCount,
      projectedRelationCount: relations.length,
      unsupportedEdgeCount: legacyEdgeCount - supportedEdgeCount,
      evidenceCount: evidence.length,
    },
  };

  _mark('snapshot');

  if (process.env.LYNX_PROFILE) {
    process.stderr.write(`[sacg-project.profile] ${JSON.stringify(_timings)}\n`);
  }

  return { snapshot, entities, relations, evidence };
}
