import { describe, expect, it } from "vitest";
import {
  normalizeEvidencePayload,
  serializeEvidencePayload,
} from "../../../src/sacg/index.js";

describe("SACG evidence payload normalization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const normalized = normalizeEvidencePayload({
      z: 1,
      nested: { beta: true, alpha: "first" },
      items: [{ y: 2, x: 1 }, "second"],
      a: null,
    });

    expect(Object.keys(normalized)).toEqual(["a", "items", "nested", "z"]);
    expect(Object.keys(normalized.nested as object)).toEqual(["alpha", "beta"]);
    expect(Object.keys((normalized.items as object[])[0])).toEqual(["x", "y"]);
    expect(normalized.items).toEqual([{ x: 1, y: 2 }, "second"]);
  });

  it("produces stable canonical JSON regardless of insertion order", () => {
    expect(
      serializeEvidencePayload({
        syntax: "openDb(config)",
        callee_name: "openDb",
        caller_line: 45,
      }),
    ).toBe(
      serializeEvidencePayload({
        caller_line: 45,
        callee_name: "openDb",
        syntax: "openDb(config)",
      }),
    );
    expect(
      serializeEvidencePayload({
        syntax: "openDb(config)",
        callee_name: "openDb",
        caller_line: 45,
      }),
    ).toBe(
      '{"callee_name":"openDb","caller_line":45,"syntax":"openDb(config)"}',
    );
  });

  it("returns a detached normalized payload without mutating the input", () => {
    const input = {
      nested: { z: 2, a: 1 },
      items: [{ b: 2, a: 1 }],
    };
    const normalized = normalizeEvidencePayload(input);

    expect(normalized).not.toBe(input);
    expect(normalized.nested).not.toBe(input.nested);
    expect(normalized.items).not.toBe(input.items);
    expect(input).toEqual({
      nested: { z: 2, a: 1 },
      items: [{ b: 2, a: 1 }],
    });
  });

  it("normalizes negative zero to its canonical JSON representation", () => {
    expect(normalizeEvidencePayload({ strength_delta: -0 })).toEqual({
      strength_delta: 0,
    });
  });

  it.each([
    ["undefined", { value: undefined }],
    ["non-finite number", { value: Number.NaN }],
    ["bigint", { value: BigInt(1) }],
    ["date", { value: new Date("2026-01-01T00:00:00.000Z") }],
    ["array root", []],
  ])("rejects %s payload data", (_label, payload) => {
    expect(() => normalizeEvidencePayload(payload)).toThrow(TypeError);
  });

  it("rejects circular references", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(() => normalizeEvidencePayload(payload)).toThrow(
      "evidence payload.self contains a circular reference",
    );
  });
});
