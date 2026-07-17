import { describe, expect, it } from "vitest";
import {
  buildEvidenceIdentityMaterial,
  buildSemanticIdentityMaterial,
  buildSemanticRelationIdentityMaterial,
  generateEvidenceId,
  generateSemanticId,
  generateSemanticRelationId,
  type EvidenceIdentityComponents,
  type SemanticIdentityComponents,
  type SemanticRelationIdentityComponents,
} from "../../../src/sacg/index.js";

const BASE_IDENTITY: SemanticIdentityComponents = {
  projectNamespace: "acme/payments",
  entityClass: "Function",
  normalizedSignature: "approveProposal(proposalId:string):Promise<void>",
  structuralContext: "src/proposals/approval.ts:ProposalService",
};

describe("SACG semantic ID generation", () => {
  it("matches a stable full SHA-256 vector", () => {
    expect(generateSemanticId(BASE_IDENTITY)).toBe(
      "ee00f79ec4e4b6a6620121f0f63ed5074d2c69188d3d0a8eaf6aeb7e189d1ef3",
    );
  });

  it("frames the blueprint components unambiguously", () => {
    expect(buildSemanticIdentityMaterial(BASE_IDENTITY)).toBe(
      JSON.stringify([
        BASE_IDENTITY.projectNamespace,
        BASE_IDENTITY.entityClass,
        BASE_IDENTITY.normalizedSignature,
        BASE_IDENTITY.structuralContext,
      ]),
    );

    expect(
      buildSemanticIdentityMaterial({
        projectNamespace: "ab",
        entityClass: "File",
        normalizedSignature: "c",
        structuralContext: "d",
      }),
    ).not.toBe(
      buildSemanticIdentityMaterial({
        projectNamespace: "a",
        entityClass: "File",
        normalizedSignature: "bc",
        structuralContext: "d",
      }),
    );
  });

  it("isolates every identity component", () => {
    const variants: SemanticIdentityComponents[] = [
      { ...BASE_IDENTITY, projectNamespace: "other/payments" },
      { ...BASE_IDENTITY, entityClass: "Method" },
      { ...BASE_IDENTITY, normalizedSignature: "approveProposal()" },
      { ...BASE_IDENTITY, structuralContext: "ProposalController" },
    ];

    for (const variant of variants) {
      expect(generateSemanticId(variant)).not.toBe(
        generateSemanticId(BASE_IDENTITY),
      );
    }
  });

  it("supports schema-valid empty signature and context", () => {
    const id = generateSemanticId({
      projectNamespace: "acme/payments",
      entityClass: "File",
      normalizedSignature: "",
      structuralContext: "",
    });

    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an empty project namespace", () => {
    expect(() =>
      generateSemanticId({
        ...BASE_IDENTITY,
        projectNamespace: "",
      }),
    ).toThrow("projectNamespace must not be empty");
  });
});

const SOURCE_SEMANTIC_ID = "a".repeat(64);
const TARGET_SEMANTIC_ID = "b".repeat(64);

const BASE_RELATION_IDENTITY: SemanticRelationIdentityComponents = {
  projectNamespace: "acme/payments",
  sourceSemanticId: SOURCE_SEMANTIC_ID,
  relationType: "CALLS",
  targetSemanticId: TARGET_SEMANTIC_ID,
  scope: { kind: "direct", file: "src/a.ts" },
};

describe("SACG semantic relation ID generation", () => {
  it("matches a stable full SHA-256 vector", () => {
    expect(generateSemanticRelationId(BASE_RELATION_IDENTITY)).toBe(
      "23ae1d2a3b07fc7b170da034db112d0b667e9546bddfbdad31908b4ccdb947ae",
    );
  });

  it("canonicalizes scope key order", () => {
    expect(buildSemanticRelationIdentityMaterial(BASE_RELATION_IDENTITY)).toBe(
      JSON.stringify([
        "acme/payments",
        SOURCE_SEMANTIC_ID,
        "CALLS",
        TARGET_SEMANTIC_ID,
        JSON.stringify({ file: "src/a.ts", kind: "direct" }),
      ]),
    );

    expect(
      generateSemanticRelationId({
        ...BASE_RELATION_IDENTITY,
        scope: { file: "src/a.ts", kind: "direct" },
      }),
    ).toBe(generateSemanticRelationId(BASE_RELATION_IDENTITY));
  });

  it("isolates logical relation components", () => {
    expect(
      generateSemanticRelationId({
        ...BASE_RELATION_IDENTITY,
        relationType: "IMPORTS",
      }),
    ).not.toBe(generateSemanticRelationId(BASE_RELATION_IDENTITY));
  });

  it("rejects empty endpoint identities", () => {
    expect(() =>
      generateSemanticRelationId({
        ...BASE_RELATION_IDENTITY,
        sourceSemanticId: "",
      }),
    ).toThrow("sourceSemanticId must not be empty");
  });
});

const BASE_EVIDENCE_IDENTITY: EvidenceIdentityComponents = {
  projectNamespace: "acme/payments",
  evidenceType: "structural",
  sourceHash: "c".repeat(64),
  sourcePath: "src/a.ts",
  startLine: 12,
  endLine: 12,
  symbolSemanticId: SOURCE_SEMANTIC_ID,
  extractorVersion: "resolve@1",
};

describe("SACG evidence ID generation", () => {
  it("matches a stable full SHA-256 vector", () => {
    expect(generateEvidenceId(BASE_EVIDENCE_IDENTITY)).toBe(
      "07b6dabe04aa80a2e604f70a241616f1fe9e396aec709c673b352c6dc3e7d17f",
    );
  });

  it("frames nullable location fields explicitly", () => {
    expect(buildEvidenceIdentityMaterial(BASE_EVIDENCE_IDENTITY)).toBe(
      JSON.stringify([
        "acme/payments",
        "structural",
        "c".repeat(64),
        "src/a.ts",
        12,
        12,
        SOURCE_SEMANTIC_ID,
        "resolve@1",
      ]),
    );
  });

  it("isolates location fields", () => {
    expect(
      generateEvidenceId({
        ...BASE_EVIDENCE_IDENTITY,
        startLine: 13,
        endLine: 13,
      }),
    ).not.toBe(generateEvidenceId(BASE_EVIDENCE_IDENTITY));
  });

  it("rejects an empty source hash", () => {
    expect(() =>
      generateEvidenceId({
        ...BASE_EVIDENCE_IDENTITY,
        sourceHash: "",
      }),
    ).toThrow("sourceHash must not be empty");
  });
});
