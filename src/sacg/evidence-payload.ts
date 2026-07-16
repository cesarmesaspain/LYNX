import type { JsonObject, JsonValue } from "./types.js";

function normalizeJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeJsonValue(item, `${path}[${index}]`, ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} contains symbol-keyed properties`);
    }

    const normalized: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function normalizeEvidencePayload(input: unknown): JsonObject {
  const normalized = normalizeJsonValue(input, "evidence payload", new Set());
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new TypeError("evidence payload must be a JSON object");
  }
  return normalized;
}

export function serializeEvidencePayload(input: unknown): string {
  return JSON.stringify(normalizeEvidencePayload(input));
}
