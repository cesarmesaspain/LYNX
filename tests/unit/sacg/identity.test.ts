import { describe, expect, it } from "vitest";
import {
  buildSemanticIdentityMaterial,
  generateSemanticId,
  type SemanticIdentityComponents,
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
