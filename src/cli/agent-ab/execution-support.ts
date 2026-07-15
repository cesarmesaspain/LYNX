/* Tool adapters, deterministic task definitions, and evaluators for agent A/B runs. */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { LynxDatabase } from "../../store/database.js";
import { handleSearchGraph } from "../../mcp/handlers/search_graph.js";
import { handleTracePath } from "../../mcp/handlers/trace_path.js";
import { handleExplainSymbol } from "../../mcp/handlers/explain_symbol.js";
import { handleFindTests } from "../../mcp/handlers/find_tests.js";
import { handleFindDeadCode } from "../../mcp/handlers/find_dead_code.js";
import { redactSecrets } from "./api-client.js";
import type { AgentToolDefinition, EvaluationKind } from "./types.js";

// ── Path safety ───────────────────────────────────────────────

export function safeReadFile(
  fixtureDir: string,
  requestedPath: string,
): string {
  // Resolve and verify path stays within fixtureDir
  const resolved = path.resolve(fixtureDir, requestedPath);
  const normalizedFixture = path.resolve(fixtureDir) + path.sep;
  if (!resolved.startsWith(normalizedFixture)) {
    return `Error: path traversal denied for "${requestedPath}"`;
  }
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return `Error: cannot read file "${requestedPath}"`;
  }
}

export function resolveB3TestPattern(fixtureDir: string): string {
  const hiddenTestsDir = path.join(fixtureDir, "hidden-tests");
  try {
    const files = fs.readdirSync(hiddenTestsDir);
    if (files.some((file) => /^b3-.*\.test\.ts$/.test(file))) {
      return "hidden-tests/b3-*.test.ts";
    }
    if (files.some((file) => /^b3-.*\.test\.js$/.test(file))) {
      return "hidden-tests/b3-*.test.js";
    }
  } catch {
    // Preserve the source-test default until the fixture has been prepared.
  }
  return "hidden-tests/b3-*.test.ts";
}

export function resolveB3BuildCommand(fixtureDir: string): {
  args: string[];
  label: string;
} {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };
    if (packageJson.scripts?.typecheck) {
      return { args: ["run", "typecheck"], label: "Typecheck" };
    }
  } catch {
    // Fall back to the conventional build script for generic fixtures.
  }
  return { args: ["run", "build"], label: "Build" };
}

export function ensureB3VitestConfig(fixtureDir: string): string {
  const hiddenTestsDir = path.join(fixtureDir, "hidden-tests");
  fs.mkdirSync(hiddenTestsDir, { recursive: true });
  const configPath = path.join(hiddenTestsDir, "vitest.b3.config.mjs");
  fs.writeFileSync(
    configPath,
    [
      "export default {",
      "  root: process.cwd(),",
      "  test: {",
      "    environment: 'node',",
      "    include: ['hidden-tests/b3-*.test.ts', 'hidden-tests/b3-*.test.js'],",
      "    exclude: [],",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf-8",
  );
  return configPath;
}

export function runB3Build(fixtureDir: string) {
  const command = resolveB3BuildCommand(fixtureDir);
  const result = spawnSync("npm", command.args, {
    cwd: fixtureDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, CI: "true" },
  });
  return { command, result };
}

export function runB3Tests(fixtureDir: string, testFile?: string) {
  const configPath = ensureB3VitestConfig(fixtureDir);
  const args = ["vitest", "run", "--config", configPath];
  if (testFile && !/[*?{}[\]]/.test(testFile)) {
    args.push(testFile);
  }
  return spawnSync("npx", args, {
    cwd: fixtureDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env },
  });
}

// ── Tool executors ────────────────────────────────────────────

export async function executeLynxTool(
  toolName: string,
  args: Record<string, unknown>,
  project: string,
  fixtureDir: string,
): Promise<string> {
  switch (toolName) {
    case "search_graph": {
      const result = await handleSearchGraph({
        project,
        query: String(args.query || ""),
        label: args.label ? String(args.label) : undefined,
        limit: args.limit ? Number(args.limit) : 10,
        enable_llm: false,
      });
      return JSON.stringify(result);
    }
    case "trace_path": {
      const result = await handleTracePath({
        project,
        function_name: String(args.function_name || ""),
        direction: (args.direction as string) || "both",
        depth: args.depth ? Number(args.depth) : 3,
        include_tests: false,
      });
      return JSON.stringify(result);
    }
    case "explain_symbol": {
      const result = await handleExplainSymbol({
        project,
        name: String(args.name || ""),
        qualified_name: args.qualified_name
          ? String(args.qualified_name)
          : undefined,
      });
      return JSON.stringify(result);
    }
    case "find_tests": {
      const result = await handleFindTests({
        project,
        name: String(args.name || ""),
      });
      return JSON.stringify(result);
    }
    case "read_file": {
      return safeReadFile(fixtureDir, String(args.path || ""));
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

export function executeBaselineTool(
  toolName: string,
  args: Record<string, unknown>,
  fixtureDir: string,
): string {
  switch (toolName) {
    case "read_file": {
      return safeReadFile(fixtureDir, String(args.path || ""));
    }
    case "grep": {
      const pattern = String(args.pattern || "");
      // Use spawnSync with args array — no shell interpolation
      const include = args.include ? String(args.include) : "*.ts";
      const result = spawnSync(
        "grep",
        ["-rn", pattern, `--include=${include}`, fixtureDir],
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 },
      );
      if (result.status === 1) return "(no matches)";
      if (result.error) return `Error: ${redactSecrets(result.error.message)}`;
      return result.stdout || "(no matches)";
    }
    case "write_file": {
      const filePath = String(args.path || "");
      const content = String(args.content || "");
      const resolved = path.resolve(fixtureDir, filePath);
      const normalizedFixture = path.resolve(fixtureDir) + path.sep;
      if (!resolved.startsWith(normalizedFixture)) {
        return `Error: path traversal denied for "${filePath}"`;
      }
      try {
        fs.writeFileSync(resolved, content, "utf-8");
        return `File written: ${filePath} (${content.length} bytes)`;
      } catch (err: any) {
        return `Error writing file: ${redactSecrets(String(err.message || err))}`;
      }
    }
    case "run_build": {
      const { command, result } = runB3Build(fixtureDir);
      return result.status === 0
        ? `${command.label} passed.\n${result.stdout.slice(-2000)}`
        : `${command.label} FAILED (exit ${result.status}):\n${(result.stderr || result.stdout).slice(-2000)}`;
    }
    case "run_tests": {
      const testFile = args.testFile
        ? String(args.testFile)
        : resolveB3TestPattern(fixtureDir);
      const result = runB3Tests(fixtureDir, testFile);
      return (
        result.stdout?.slice(-3000) ||
        result.stderr?.slice(-3000) ||
        "(no output)"
      );
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── Task definitions ──────────────────────────────────────────

export type BenchmarkTask = {
  id: string;
  name: string;
  userPrompt: string;
  expected: Record<string, unknown>;
  evaluation_kind?: EvaluationKind;
};

export function makeExternalProjectTasks(
  projectLabel: string,
): BenchmarkTask[] {
  return [
    {
      id: "external_simple_techstack",
      name: "Quick tech stack fingerprint",
      userPrompt: `What programming language, framework, and database does ${projectLabel} use? Respond with JSON: {"language":"...","framework":"...","database":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_multi_turn",
      name: "Multi-turn session: 2 tasks in same conversation",
      userPrompt: `I have two questions about ${projectLabel}. Answer them one after another in the same JSON response.

QUESTION 1: What programming language and framework does the project use? Also find one function with high complexity or many dependents — a potential hotspot.

QUESTION 2: Now, for that hotspot function you just found, tell me: what other functions call it? What functions does it call? What tests cover it?

Respond with a single JSON: {"question1":{"language":"...","framework":"...","hotspot_name":"...","hotspot_file":"...","why_hotspot":"..."},"question2":{"callers":["..."],"callees":["..."],"tests":["..."]},"summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_dead_code",
      name: "Find dead code — unused functions/classes",
      userPrompt: `I'm doing a ${projectLabel} cleanup sprint. Find symbols (functions, classes) in the codebase that have zero callers and zero usages — candidates for removal. List at least 5 concrete examples with their file paths and names. Do NOT invent symbols. Prefer a structural dead-code operation when available: its returned definition location and zero-incoming-edge evidence are sufficient; do not reopen every candidate unless that operation cannot provide the evidence, and stop once 5 well-supported candidates are established. Respond with JSON: {"unused_symbols":[{"name":"...","file":"...","kind":"function|class"}], "evidence":["..."], "summary":"..."}.`,
      expected: {},
      evaluation_kind: "partial",
    },
    {
      id: "external_generic_architecture",
      name: "Natural project architecture orientation",
      userPrompt: `You have just joined the ${projectLabel} team. Analyze only the evidence needed for a real onboarding orientation. Explain its architecture, principal entry points, important modules, technical hotspots, and the most important missing or existing tests, then stop once those points are supported. Respond with JSON: {"architecture":["..."],"entry_points":["..."],"important_modules":["..."],"hotspots":["..."],"test_observations":["..."],"evidence":["..."],"summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_generic_flow",
      name: "Trace a representative user workflow",
      userPrompt: `Identify one representative user-facing workflow in ${projectLabel} and trace it end to end through the code. Do not assume which tools to use. Explain the initiating action, control flow, state transitions, external boundaries, and failure points, citing concrete files and symbols. Respond with JSON: {"workflow_name":"...","flow":["..."],"state_transitions":["..."],"external_boundaries":["..."],"failure_points":["..."],"evidence":["..."],"summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_generic_change_impact",
      name: "Assess a realistic cross-cutting change",
      userPrompt: `The ${projectLabel} team wants to add a user-visible setting that must persist across launches and affect runtime behavior. Determine where this change should be implemented, which callers and dependencies would be affected, what migration or compatibility risks exist, and what tests should be added. Use only the investigation needed to establish the requested evidence, then stop and cite concrete evidence. Respond with JSON: {"change_areas":["..."],"affected_dependencies":["..."],"persistence_path":["..."],"risks":["..."],"test_plan":["..."],"evidence":["..."],"summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_generic_incident",
      name: "Triage a realistic startup incident",
      userPrompt: `Users report that ${projectLabel} sometimes launches but its main functionality is unavailable. Produce a first-principles investigation plan based on the actual codebase. Locate likely startup, state, process, configuration, and external-service paths; identify evidence to collect and safe containment actions. Use the smallest set of tools needed to establish the requested evidence, then stop; do not invent components. Respond with JSON: {"investigation_steps":["..."],"likely_components":["..."],"evidence_sources":["..."],"containment_actions":["..."],"evidence":["..."],"summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_missing_tests",
      name: "Find untested functions (graph-native)",
      userPrompt: `I'm auditing test coverage in ${projectLabel}. Find functions that have NO test coverage — meaning no test function calls or imports them. Give concrete examples with file paths and function names. Also identify the top 3 most complex functions that lack tests. Do NOT guess — verify each reported finding with structural evidence, and stop once the requested examples and top 3 are supported. Respond with JSON: {"untested": [{"name":"...","file":"...","complexity":N}], "top3_risky_untested": [{"name":"...","file":"...","complexity":N,"reason":"..."}], "methodology":"...", "summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_semantic_discovery",
      name: "Natural-language code discovery (semantic search)",
      userPrompt: `Without reading every file, find the code in ${projectLabel} that handles data persistence or storage. Use natural-language search if available — do NOT grep for specific keywords unless necessary. Identify the main storage layer, the key functions that write/read data, and any configuration related to the database connection. Respond with JSON: {"storage_layer":"...","key_write_functions":["..."],"key_read_functions":["..."],"db_config_location":"...","methodology":"...","summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
    {
      id: "external_scalability_snapshot",
      name: "Scalability snapshot — size, complexity, coupling",
      userPrompt: `Give me a scalability health check of ${projectLabel}. Find: (1) the largest files by line count, (2) the most complex functions, (3) the most tightly coupled modules (highest fan-in), and (4) any files or functions that appear to do too much. Use the smallest structural query or analysis result that supports all four categories. Do NOT read every file, and stop once the requested evidence is established. Respond with JSON: {"largest_files":[{"file":"...","lines":N}], "most_complex":[{"name":"...","file":"...","complexity":N}], "tightest_coupling":[{"name":"...","file":"...","fan_in":N}], "god_objects":[{"name":"...","file":"...","why":"..."}], "methodology":"...", "summary":"..."}.`,
      expected: {},
      evaluation_kind: "designed-only",
    },
  ];
}

export const EXTERNAL_TASK_TOOL_PROFILES: Record<string, readonly string[]> = {
  external_simple_techstack: ["get_architecture", "search_graph", "read_file"],
  external_multi_turn: [
    "get_architecture",
    "analyze_hotspots",
    "trace_path",
    "find_tests",
    "read_file",
  ],
  external_dead_code: ["find_dead_code", "read_file"],
  external_generic_architecture: [
    "get_architecture",
    "analyze_hotspots",
    "search_graph",
    "read_file",
  ],
  external_generic_flow: [
    "get_architecture",
    "search_graph",
    "trace_path",
    "get_code_snippet",
    "read_file",
  ],
  external_generic_change_impact: [
    "get_architecture",
    "search_graph",
    "trace_path",
    "find_tests",
    "read_file",
  ],
  external_generic_incident: [
    "get_architecture",
    "search_graph",
    "trace_path",
    "get_code_snippet",
    "read_file",
  ],
  external_missing_tests: [
    "analyze_hotspots",
    "search_graph",
    "query_graph",
    "read_file",
  ],
  external_semantic_discovery: [
    "semantic_search",
    "get_code_snippet",
    "read_file",
  ],
  external_scalability_snapshot: [
    "get_architecture",
    "analyze_hotspots",
    "query_graph",
    "read_file",
  ],
};

export const TASKS: BenchmarkTask[] = [
  {
    id: "find_definition",
    name: "Find lynxHome definition",
    userPrompt:
      'Find where the function "lynxHome" is defined. What file is it in? What does it return? ' +
      'Respond with JSON: {"found_file": "<relative path>", "function_name": "lynxHome", "returns_path": true/false}',
    expected: {
      found_file: "runtime.ts",
      function_name: "lynxHome",
      returns_path: true,
    },
    evaluation_kind: "deterministic",
  },
  {
    id: "find_callers",
    name: "Find callers of readConfig",
    userPrompt:
      'Find all functions that call "readConfig". List them as an array of {name, file_path} objects in JSON. ' +
      'Respond with JSON: {"callers": [{"name": "...", "file_path": "..."}]}',
    expected: {
      callers: [{ name: "openDb" }, { name: "dbPath" }],
    },
    evaluation_kind: "deterministic",
  },
  {
    id: "change_impact",
    name: "Assess impact of Config change",
    userPrompt:
      'Determine what functions are impacted if the "Config" interface changes in the project. ' +
      "List the names of impacted functions. " +
      'Respond with JSON: {"impacted_functions": ["func1", "func2"], "references": N}',
    expected: {
      impacted_functions: ["readConfig", "openDb"],
      references: 2,
    },
    evaluation_kind: "deterministic",
  },
  {
    id: "find_tests",
    name: "Find tests for lynxHome",
    userPrompt:
      'Find all test functions that test "lynxHome". List them as JSON: ' +
      '{"test_functions": [{"name": "...", "file_path": "..."}], "total_tests": N}',
    expected: {
      test_functions: [
        { name: "testLynxHomeReturnsString" },
        { name: "testLynxHomeRespectsEnv" },
      ],
    },
    evaluation_kind: "deterministic",
  },
  {
    id: "locate_definitions",
    name: "Locate multiple definitions",
    userPrompt:
      "Find the source locations (file and start line) for these three functions: lynxHome, openDb, formatPath. " +
      'Respond with JSON: {"definitions": [{"name": "...", "file_path": "...", "start_line": N}]}',
    expected: {
      definitions: [
        { name: "lynxHome", file_path: "runtime.ts" },
        { name: "openDb", file_path: "db.ts" },
        { name: "formatPath", file_path: "helpers.ts" },
      ],
    },
    evaluation_kind: "deterministic",
  },
  {
    id: "trace_dependency_chain",
    name: "Trace searchGraph dependency chain",
    userPrompt:
      'Trace the runtime call path from "searchGraph" to "lynxHome". ' +
      "List the functions in call order, including both endpoints. " +
      'Respond with JSON: {"call_chain": ["searchGraph", "...", "lynxHome"], "hops": N}',
    expected: {
      call_chain: ["searchGraph", "openDb", "readConfig", "lynxHome"],
      hops: 3,
    },
    evaluation_kind: "deterministic",
  },
];

// ── Evaluation ────────────────────────────────────────────────

export function evaluateResponse(
  responseText: string,
  expected: Record<string, unknown>,
): {
  result: Record<string, unknown>;
  correct: boolean;
  defects: number;
  errors: string[];
} {
  const errors: string[] = [];
  let result: Record<string, unknown> = {};

  const explicitJsonMatch = responseText.match(/```json\s*([\s\S]*?)```/i);
  const genericFenceMatch = responseText.match(/```\s*([\s\S]*?)```/);
  const jsonText = explicitJsonMatch
    ? explicitJsonMatch[1].trim()
    : genericFenceMatch
      ? genericFenceMatch[1].trim()
      : responseText.trim();

  try {
    result = JSON.parse(jsonText);
  } catch {
    const objMatch = responseText.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        result = JSON.parse(objMatch[0]);
      } catch {
        errors.push("Could not parse JSON from response");
        return {
          result: {},
          correct: false,
          defects: Object.keys(expected).length,
          errors,
        };
      }
    } else {
      errors.push("No JSON object found in response");
      return {
        result: {},
        correct: false,
        defects: Object.keys(expected).length,
        errors,
      };
    }
  }

  let defects = 0;
  const normalizeLanguage = (value: unknown) => {
    const text = String(value).trim().toLowerCase();
    return text === "ts" || text === "tsx" || text === "typescript"
      ? "TypeScript"
      : String(value);
  };

  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = result[key];
    if (expectedVal === undefined) continue;

    if (Array.isArray(expectedVal)) {
      const actualArr = Array.isArray(actualVal) ? actualVal : [];
      const expectedArr = expectedVal as unknown[];

      for (const exp of expectedArr) {
        if (typeof exp === "object" && exp !== null) {
          const found = actualArr.some((a: unknown) => {
            if (typeof a !== "object" || a === null) return false;
            return Object.entries(exp as Record<string, unknown>).every(
              ([ek, ev]) => {
                const av = (a as Record<string, unknown>)[ek];
                if (typeof ev === "string" && typeof av === "string") {
                  return av.includes(ev);
                }
                return av === ev;
              },
            );
          });
          if (!found) {
            defects++;
            errors.push(
              `Missing expected item in ${key}: ${JSON.stringify(exp)}`,
            );
          }
        } else {
          const expectedScalar =
            key === "languages" ? normalizeLanguage(exp) : String(exp);
          const found = actualArr.some((actual) => {
            const actualScalar =
              key === "languages" ? normalizeLanguage(actual) : String(actual);
            return (
              actualScalar === expectedScalar ||
              actualScalar.includes(expectedScalar)
            );
          });
          if (!found) {
            defects++;
            errors.push(`Missing expected item in ${key}: ${expectedScalar}`);
          }
        }
      }

      if (actualArr.length < expectedArr.length) {
        defects += expectedArr.length - actualArr.length;
      }
    } else if (typeof expectedVal === "string") {
      const actualStr =
        key === "primary_language"
          ? normalizeLanguage(actualVal ?? "")
          : String(actualVal ?? "");
      const expectedStr =
        key === "primary_language"
          ? normalizeLanguage(expectedVal)
          : expectedVal;
      if (actualStr !== expectedStr && !actualStr.includes(expectedStr)) {
        defects++;
        errors.push(
          `${key}: expected "${expectedStr}", got "${actualStr.slice(0, 80)}"`,
        );
      }
    } else if (typeof expectedVal === "number") {
      if (key === "references") {
        if (Number(actualVal) < (expectedVal as number)) {
          defects++;
          errors.push(
            `${key}: expected at least ${expectedVal}, got ${actualVal}`,
          );
        }
      } else if (Number(actualVal) !== expectedVal) {
        defects++;
        errors.push(`${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    } else if (typeof expectedVal === "boolean") {
      if (Boolean(actualVal) !== expectedVal) {
        defects++;
        errors.push(`${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    }
  }

  return { result, correct: defects === 0, defects, errors };
}

// ── Seeded shuffle ────────────────────────────────────────────

export function evaluateExternalScalabilityResponse(responseText: string): {
  result: Record<string, unknown>;
  correct: boolean;
  defects: number;
  errors: string[];
} {
  const parsed = evaluateResponse(responseText, {});
  if (parsed.errors.length > 0) return parsed;

  const result = parsed.result;
  const errors: string[] = [];
  let defects = 0;

  const requireItems = (key: string, fields: string[]) => {
    const items = result[key];
    if (!Array.isArray(items) || items.length === 0) {
      defects++;
      errors.push(`${key}: expected a non-empty array`);
      return;
    }
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        defects++;
        errors.push(`${key}[${index}]: expected an object`);
        continue;
      }
      for (const field of fields) {
        const value = (item as Record<string, unknown>)[field];
        if (value === undefined || value === null || value === "") {
          defects++;
          errors.push(`${key}[${index}].${field}: missing value`);
        }
      }
    }
  };

  requireItems("largest_files", ["file", "lines"]);
  requireItems("most_complex", ["name", "file", "complexity"]);
  requireItems("tightest_coupling", ["name", "file", "fan_in"]);
  requireItems("god_objects", ["name", "file", "why"]);

  if (
    typeof result.methodology !== "string" ||
    result.methodology.trim().length < 10
  ) {
    defects++;
    errors.push("methodology: expected a substantive string");
  }
  if (typeof result.summary !== "string" || result.summary.trim().length < 10) {
    defects++;
    errors.push("summary: expected a substantive string");
  }

  if (
    /nested loops?[^.]{0,120}(?:prove|proves|means|therefore|=>)\s*O\(n\^\d+\)/i.test(
      JSON.stringify(result),
    )
  ) {
    defects++;
    errors.push(
      "scalability: nested-loop claim with big-O proof requires verification — flagging as unverified",
    );
  }

  return { result, correct: defects === 0, defects, errors };
}

/**
 * Ground external dead-code answers in the same indexed repository for both
 * conditions. This checks precision (every claimed candidate is a real
 * definition with no indexed inbound reference); it deliberately does not
 * score recall because an open-ended cleanup task has no single exhaustive set.
 */
export async function evaluateExternalDeadCodeResponse(
  responseText: string,
  project: string,
  verifiedCandidates?: Array<{
    name?: unknown;
    file_path?: unknown;
    kind?: unknown;
  }>,
): Promise<{
  result: Record<string, unknown>;
  correct: boolean;
  defects: number;
  errors: string[];
}> {
  const parsed = evaluateResponse(responseText, {});
  if (parsed.errors.length > 0) return parsed;

  const result = parsed.result;
  const reported = result.unused_symbols;
  const errors: string[] = [];
  let defects = 0;
  if (!Array.isArray(reported) || reported.length < 5) {
    return {
      result,
      correct: false,
      defects: 1,
      errors: ["unused_symbols: expected at least 5 candidates"],
    };
  }

  const verification = verifiedCandidates
    ? { candidates: verifiedCandidates }
    : ((await handleFindDeadCode({ project, limit: 100 })) as {
        candidates?: Array<{
          name?: unknown;
          file_path?: unknown;
          kind?: unknown;
        }>;
      });
  const candidates = verification.candidates || [];
  const seen = new Set<string>();
  const normalizedKind = (value: unknown) => String(value).toLowerCase();
  const normalizePath = (value: unknown) =>
    String(value).replace(/\\/g, "/").replace(/^\.\//, "");

  for (const [index, item] of reported.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      defects++;
      errors.push(`unused_symbols[${index}]: expected an object`);
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const name = String(candidate.name || "").trim();
    const file = normalizePath(candidate.file);
    const kind = normalizedKind(candidate.kind);
    const identity = `${name}|${file}`;
    if (!name || !file || !["function", "method", "class"].includes(kind)) {
      defects++;
      errors.push(
        `unused_symbols[${index}]: name, file, and function/method/class kind are required`,
      );
      continue;
    }
    if (seen.has(identity)) {
      defects++;
      errors.push(`unused_symbols[${index}]: duplicate candidate ${identity}`);
      continue;
    }
    seen.add(identity);
    const match = candidates.some((verified) => {
      const verifiedKind = normalizedKind(verified.kind);
      const kindMatches =
        kind === "class"
          ? verifiedKind === "class"
          : verifiedKind === "function" || verifiedKind === "method";
      return (
        verified.name === name &&
        normalizePath(verified.file_path) === file &&
        kindMatches
      );
    });
    if (!match) {
      defects++;
      errors.push(
        `unused_symbols[${index}]: not a verified zero-reference definition: ${identity}`,
      );
    }
  }

  return { result, correct: defects === 0, defects, errors };
}

export function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
