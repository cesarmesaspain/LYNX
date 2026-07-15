import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hidden tests for pilot B3 (bug-fix task).
 *
 * The injected bug changes `machine: true` to `machine: false` in
 * the token-auth path of enforceOpsRequest (src/lib/ops/api.ts).
 * The correct fix restores `machine: true`.
 */

const hiddenTestsDir = path.dirname(fileURLToPath(import.meta.url));
 const apiPath = path.resolve(hiddenTestsDir, "../src/lib/ops/api.ts");

describe("enforceOpsRequest token authentication (B3 hidden tests)", () => {
  it("returns machine: true only for token-authenticated requests", () => {
    const content = fs.readFileSync(apiPath, "utf-8");
    const tokenBranchStart = content.indexOf(
      "if (token && headerToken && headerToken === token) {",
    );
    const tokenBranchEnd = content.indexOf(
      "\n\n  const auth =",
      tokenBranchStart,
    );

    expect(tokenBranchStart).toBeGreaterThanOrEqual(0);
    expect(tokenBranchEnd).toBeGreaterThan(tokenBranchStart);

    const tokenBranch = content.slice(tokenBranchStart, tokenBranchEnd);
    const userAuthBranch = content.slice(tokenBranchEnd);
    expect(tokenBranch).toContain("machine: true,");
    expect(userAuthBranch).toContain("machine: false,");
  });

  it("has the required imports for authentication", () => {
    const content = fs.readFileSync(apiPath, "utf-8");
    expect(content).toContain("import { enforceAuthenticatedRequest }");
    expect(content).toContain("import { readOpsToken }");
    expect(content).toContain("import { NextRequest, NextResponse }");
  });
});
