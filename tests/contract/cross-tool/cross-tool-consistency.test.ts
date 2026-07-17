import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../../../src/mcp/tools.js";
import { buildIndexContext, getToolRegistryIntegrity, listMcpTools, setDb, unsetDb, validateToolArguments } from "../../../src/mcp/server.js";
import { LynxDatabase } from "../../../src/store/database.js";
import { upsertFileHash } from "../../../src/store/memory.js";
import { handleIndexStatus } from "../../../src/mcp/handlers/index_status.js";
import { handleGetArchitecture } from "../../../src/mcp/handlers/get_architecture.js";
import { handleDetectChanges } from "../../../src/mcp/handlers/detect_changes.js";
import { handleAssessImpact } from "../../../src/mcp/handlers/assess_impact.js";

const PROJECT = "cross-tool-contract-fixture";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const stableChanges = (value: Record<string, unknown>) => ({
  project: value.project,
  contract_version: value.contract_version,
  category_counts: value.category_counts,
  changed_files: value.changed_files,
  total_changed_files: value.total_changed_files,
  total_affected_nodes: value.total_affected_nodes,
  llm_usage: value.llm_usage,
});

describe("generated cross-tool consistency contracts", () => {
  let root: string;
  let db: LynxDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lynx-cross-tool-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
    writeFileSync(join(root, "tests/math.test.ts"), 'import { add } from "../src/math"; void add(1, 2);\n');
    git(root, "init");
    git(root, "config", "user.email", "contract@example.invalid");
    git(root, "config", "user.name", "Contract Fixture");
    git(root, "add", ".");
    git(root, "commit", "-m", "fixture baseline");

    db = LynxDatabase.openMemory();
    db.upsertProject(PROJECT, root);
    const ins = db.db.prepare("INSERT INTO nodes (project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run(PROJECT, "File", "math.ts", "src.math.ts", "src/math.ts", 1, 1, 0, 0, 0, "{}");
    ins.run(PROJECT, "File", "math.test.ts", "tests.math.test.ts", "tests/math.test.ts", 1, 1, 0, 1, 0, "{}");
    const add = Number(ins.run(PROJECT, "Function", "add", "src.math.add", "src/math.ts", 1, 1, 1, 0, 0, JSON.stringify({ cyclomaticComplexity: 1 })).lastInsertRowid);
    const testAdd = Number(ins.run(PROJECT, "Function", "testAdd", "tests.math.testAdd", "tests/math.test.ts", 1, 1, 0, 1, 0, "{}").lastInsertRowid);
    db.db.prepare("INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)").run(PROJECT, testAdd, add, "TESTS", "{}");
    for (const relPath of ["src/math.ts", "tests/math.test.ts"]) {
      const filePath = join(root, relPath);
      const source = readFileSync(filePath);
      const stat = statSync(filePath);
      upsertFileHash(db, PROJECT, relPath, createHash("sha256").update(source).digest("hex"), Math.floor(stat.mtimeMs * 1_000_000), stat.size);
    }
    setDb(PROJECT, db);
    writeFileSync(join(root, "src/math.ts"), "export const add = (a: number, b: number) => a + b + 0;\n");
  });

  afterEach(() => {
    unsetDb(PROJECT, { close: false });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("derives the public contract dynamically from the registry", () => {
    const previous = process.env.LYNX_TOOL_PROFILE;
    process.env.LYNX_TOOL_PROFILE = "full";
    try {
      const listed = listMcpTools();
      expect(listed.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name));
      expect(new Set(listed.map(tool => tool.name)).size).toBe(TOOLS.length);
      for (const tool of listed) {
        expect(tool.inputSchema).toEqual(TOOLS.find(candidate => candidate.name === tool.name)?.inputSchema);
      }
      expect(getToolRegistryIntegrity()).toEqual({
        ok: true,
        duplicate_registry_names: [],
        missing_handlers: [],
        unpublished_handlers: [],
      });
    } finally {
      if (previous === undefined) delete process.env.LYNX_TOOL_PROFILE;
      else process.env.LYNX_TOOL_PROFILE = previous;
    }
  });

  it("rejects registry/handler drift before a broken tool can be advertised", () => {
    expect(getToolRegistryIntegrity(["search", "search", "orphan"], ["search", "hidden"])).toEqual({
      ok: false,
      duplicate_registry_names: ["search"],
      missing_handlers: ["orphan"],
      unpublished_handlers: ["hidden"],
    });
  });

  it("keeps identity and health/coverage claims consistent", async () => {
    const status = await handleIndexStatus({ project: PROJECT }) as Record<string, unknown>;
    const architecture = await handleGetArchitecture({ project: PROJECT, aspects: ["file_tree", "node_labels", "edge_types"] }) as Record<string, unknown>;
    const context = buildIndexContext({ project: PROJECT }) as Record<string, unknown>;
    expect(status.project).toBe(PROJECT);
    expect(architecture.project).toBe(PROJECT);
    expect(context.project).toBe(PROJECT);
    expect(status.nodes).toBe(architecture.total_nodes);
    expect(status.edges).toBe(architecture.total_edges);
    expect(status.files).toBe(2);
    expect((status.coverage as Record<string, unknown>).indexed_files_with_nodes).toBe(status.files);
    expect((architecture.file_tree as unknown[]).length).toBeGreaterThanOrEqual(Number(status.files));
    expect(status.indexed).toBe(true);
    expect(["ready", "stale", "drifted"]).toContain(status.freshness);
  });

  it("is bounded, deterministic, default-no-LLM, and agrees on changed scope", async () => {
    const args = { project: PROJECT, include_committed: false, include_diff: false, depth: 1 };
    const first = await handleDetectChanges(args) as Record<string, unknown>;
    const second = await handleDetectChanges(args) as Record<string, unknown>;
    const impact = await handleAssessImpact({ project: PROJECT, files: ["src/math.ts"], max_findings: 10 }) as Record<string, unknown>;
    expect(stableChanges(second)).toEqual(stableChanges(first));
    expect(JSON.stringify(first).length).toBeLessThan(40000);
    expect(first.llm_usage).toMatchObject({ enabled: false, used: false });
    expect(first.total_changed_files).toBe(1);
    expect(first.changed_files).toContainEqual(expect.objectContaining({ file: "src/math.ts" }));
    expect(impact.project).toBe(PROJECT);
    expect((impact.scope as Record<string, unknown>).files).toEqual(["src/math.ts"]);
    expect(Number(impact.returned_findings)).toBeLessThanOrEqual(10);
  });

  it("returns structured errors consistently", async () => {
    expect(validateToolArguments("index_status", {})).toMatchObject({
      valid: false,
      error: "INVALID_TOOL_ARGUMENTS",
      problems: [expect.stringContaining("Missing required argument")],
    });
    expect(validateToolArguments("not_a_tool", {})).toMatchObject({
      valid: false,
      error: "INVALID_TOOL_ARGUMENTS",
      problems: [expect.stringContaining("Unknown tool")],
    });
    const bad = await handleDetectChanges({ project: PROJECT, path_filter: "[" }) as Record<string, unknown>;
    expect(bad).toMatchObject({ project: PROJECT, recoverable: true });
    expect(typeof bad.error).toBe("string");
    expect(typeof bad.hint).toBe("string");
    expect((bad.llm_usage as Record<string, unknown>).used).toBe(false);

    const missing = await handleAssessImpact({ project: "missing-cross-tool-project" }) as Record<string, unknown>;
    expect(missing).toMatchObject({
      project: "missing-cross-tool-project",
      summary: "Project not indexed.",
      total_findings: 0,
      findings: [],
    });
    expect((missing.uncertainties as string[]).length).toBeGreaterThan(0);
    expect((missing.recommended_inspection as string[]).length).toBeGreaterThan(0);
  });
});
