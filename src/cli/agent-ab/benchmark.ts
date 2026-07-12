/*
 * agent-ab/benchmark.ts — LLM agent A/B benchmark.
 *
 * 5 deterministic tasks through DeepSeek LLM agent.
 * ONLY difference between conditions: LYNX tools exposed or not.
 *
 * Fresh conversation per task × condition × run. No shared history or cache.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// `process.argv[1]` is stable in both ESM source runs and the packaged CLI.
// Avoid `import.meta.url`: pkg executes its bundled entry through CommonJS.
const benchmarkDir = path.dirname(process.argv[1] || process.cwd());

import { LynxDatabase } from "../../store/database.js";
import { runPipeline } from "../../pipeline/orchestrator.js";
import { setDb } from "../../mcp/server.js";
import { clearFederatedConfig } from "../../federation/handler-bridge.js";
import { handleSearchGraph } from "../../mcp/handlers/search_graph.js";
import { handleTracePath } from "../../mcp/handlers/trace_path.js";
import { handleExplainSymbol } from "../../mcp/handlers/explain_symbol.js";
import { handleFindTests } from "../../mcp/handlers/find_tests.js";
import { handleFindDeadCode } from "../../mcp/handlers/find_dead_code.js";
import { clearSessionDedup } from "../../usage/metrics.js";
import {
  chatCompletion,
  computeCost,
  getApiKey,
  redactSecrets,
  sha256Hash,
  DEFAULT_BASE_URL,
} from "./api-client.js";
import { readAgentABIndex, aggregateAgentABHistory } from "./history.js";

const AGENT_AB_DEFAULT_MODEL = "deepseek-v4-flash";
import type {
  AgentABConfig,
  AgentABRun,
  AgentABResult,
  AgentABSummary,
  AgentMessage,
  AgentToolCall,
  AgentToolDefinition,
  ApiUsage,
  ToolTraceStep,
  EvaluationKind,
} from "./types.js";
import {
  assertPaidMicrobenchmarkProtocol,
  buildExperimentProtocol,
} from "./experiment.js";

// ── Progress callback ──────────────────────────────────────────

export interface ProgressEvent {
  /** 1-based counter across all runs. */
  current: number;
  /** Total planned runs. */
  total: number;
  /** The run that just completed. */
  run: AgentABRun;
  /** All completed runs so far (accumulated). */
  allRuns: AgentABRun[];
}

export type ProgressCallback = (evt: ProgressEvent) => void;

// Reuse fixture generation from ab-benchmark
import { generateFixture } from "../ab-benchmark.js";

// ── System prompt (identical for both conditions) ─────────────

const SYSTEM_PROMPT = `You are a code intelligence agent. You help developers understand code by answering questions precisely and concisely.

Rules:
- Answer based on the tools and information available.
- When MCP tools are available, their names, descriptions, and argument schemas are authoritative. Choose the smallest relevant tool set needed for the requested evidence; do not assume undocumented behavior.
- When using tools, call them one at a time. Wait for each result before proceeding.
- Verify only material uncertainty, and reuse evidence already collected instead of repeating equivalent investigation.
- When the available evidence is sufficient, stop investigating and provide a concise final answer.
- Do NOT invent information. If you cannot find something, say so.
- Output your final answer as a single JSON object with the exact fields requested. Nothing else.`;

// ── Shared params (identical across conditions) ───────────────

function getSharedParams(config: AgentABConfig) {
  return {
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    seed: config.seed,
  };
}

function evaluationKind(task: BenchmarkTask): EvaluationKind {
  if (task.evaluation_kind) return task.evaluation_kind;
  return Object.keys(task.expected).length > 0
    ? "deterministic"
    : "designed-only";
}

export function isEvaluationEligible(task: BenchmarkTask): boolean {
  const kind = evaluationKind(task);
  return kind === "partial" || (kind === "deterministic" && Object.keys(task.expected).length > 0);
}

// ── Tool definitions ──────────────────────────────────────────

export function makeLynxTools(): AgentToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "search_graph",
        description:
          "Search the code knowledge graph. Returns matching symbols with their exact file path and line number — use this to locate where any function, class, or variable is defined.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Full-text search query" },
            label: {
              type: "string",
              description: "Filter: Function, Class, Method, etc.",
            },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "trace_path",
        description:
          "Trace call graph from a function: find callers or callees.",
        parameters: {
          type: "object",
          properties: {
            function_name: {
              type: "string",
              description: "Function to trace from",
            },
            direction: {
              type: "string",
              enum: ["inbound", "outbound", "both"],
            },
            depth: { type: "number", description: "Search depth (default 3)" },
          },
          required: ["function_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "explain_symbol",
        description:
          "Analyze a symbol's semantics in depth: callers, callees, complexity, dependencies, and behavior patterns. Use only after the symbol's definition is already located via search_graph — explain_symbol does NOT tell you where a symbol is defined.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Symbol name" },
            qualified_name: {
              type: "string",
              description: "Fully qualified name",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_tests",
        description: "Find test functions that cover a given symbol.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Symbol name to find tests for",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file's full source code from the project. Use to confirm or inspect a definition that was already located by search_graph or grep.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path in the project",
            },
          },
          required: ["path"],
        },
      },
    },
  ];
}

export function makeBaselineTools(): AgentToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file's full source code from the project. Use to confirm or inspect a definition that was already located by search_graph or grep.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path in the project",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search for a text pattern in project files.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Text or regex pattern to search for",
            },
            include: {
              type: "string",
              description: "File pattern to include (e.g. *.ts)",
            },
          },
          required: ["pattern"],
        },
      },
    },
  ];
}

// ── Path safety ───────────────────────────────────────────────

function safeReadFile(fixtureDir: string, requestedPath: string): string {
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

// ── Tool executors ────────────────────────────────────────────

async function executeLynxTool(
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

function executeBaselineTool(
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

function makeExternalProjectTasks(projectLabel: string): BenchmarkTask[] {
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

const EXTERNAL_TASK_TOOL_PROFILES: Record<string, readonly string[]> = {
  external_simple_techstack: ['get_architecture', 'search_graph', 'read_file'],
  external_multi_turn: ['get_architecture', 'analyze_hotspots', 'trace_path', 'find_tests', 'read_file'],
  external_dead_code: ['find_dead_code', 'read_file'],
  external_generic_architecture: ['get_architecture', 'analyze_hotspots', 'search_graph', 'read_file'],
  external_generic_flow: ['get_architecture', 'search_graph', 'trace_path', 'get_code_snippet', 'read_file'],
  external_generic_change_impact: ['get_architecture', 'search_graph', 'trace_path', 'find_tests', 'read_file'],
  external_generic_incident: ['get_architecture', 'search_graph', 'trace_path', 'get_code_snippet', 'read_file'],
  external_missing_tests: ['analyze_hotspots', 'search_graph', 'query_graph', 'read_file'],
  external_semantic_discovery: ['semantic_search', 'get_code_snippet', 'read_file'],
  external_scalability_snapshot: ['get_architecture', 'analyze_hotspots', 'query_graph', 'read_file'],
};

const TASKS: BenchmarkTask[] = [
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
];

// ── Evaluation ────────────────────────────────────────────────

function evaluateResponse(
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

  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : responseText.trim();

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
  verifiedCandidates?: Array<{ name?: unknown; file_path?: unknown; kind?: unknown }>,
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
    : await handleFindDeadCode({ project, limit: 100 }) as {
        candidates?: Array<{ name?: unknown; file_path?: unknown; kind?: unknown }>;
      };
  const candidates = verification.candidates || [];
  const seen = new Set<string>();
  const normalizedKind = (value: unknown) => String(value).toLowerCase();
  const normalizePath = (value: unknown) => String(value)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

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
      errors.push(`unused_symbols[${index}]: name, file, and function/method/class kind are required`);
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
      const kindMatches = kind === "class"
        ? verifiedKind === "class"
        : verifiedKind === "function" || verifiedKind === "method";
      return verified.name === name && normalizePath(verified.file_path) === file && kindMatches;
    });
    if (!match) {
      defects++;
      errors.push(`unused_symbols[${index}]: not a verified zero-reference definition: ${identity}`);
    }
  }

  return { result, correct: defects === 0, defects, errors };
}

function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Run ID generation ─────────────────────────────────────────

let runCounter = 0;

function generateRunId(): string {
  runCounter++;
  const rand = createHash("sha256")
    .update(`${runCounter}-${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
  return `run_${runCounter.toString(36)}_${rand}`;
}

// ── Main runner ───────────────────────────────────────────────

export async function runAgentABBenchmark(
  configOverrides: Partial<AgentABConfig> = {},
  runOpts: {
    includeTrace?: boolean;
    onProgress?: ProgressCallback;
    checkpointPath?: string;
    suite?: "default" | "realistic";
    chained?: boolean;
  } = {},
): Promise<AgentABResult> {
  const apiKey = configOverrides.apiKey || getApiKey();
  const isDryRun = configOverrides.dryRun === true || !apiKey;
  const isRealistic = runOpts.suite === "realistic";
  const isChained = !!runOpts.chained;

  const config: AgentABConfig = {
    tier: configOverrides.tier ?? "official",
    seed: configOverrides.seed ?? 42,
    model: configOverrides.model ?? AGENT_AB_DEFAULT_MODEL,
    baseUrl: configOverrides.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: apiKey || "",
    systemPrompt: configOverrides.systemPrompt ?? SYSTEM_PROMPT,
    temperature: configOverrides.temperature ?? 0.0,
    maxTokens:
      configOverrides.maxTokens ??
      (configOverrides.tier === "screening" ? 1024 : undefined),
    maxToolCalls:
      configOverrides.maxToolCalls ??
      (configOverrides.projectDir ? 8 : configOverrides.tier === "screening" ? 12 : undefined),
    timeoutMs: configOverrides.timeoutMs,
    maxRetries: configOverrides.maxRetries,
    warmupRounds: configOverrides.warmupRounds ?? 0,
    measuredRounds: configOverrides.measuredRounds ?? 1,
    taskIds: configOverrides.taskIds,
    fixtureDir: configOverrides.fixtureDir,
    projectDir: configOverrides.projectDir,
    dryRun: isDryRun,
  };
  const isExternalProject = !!config.projectDir;

  // A live benchmark is a paid microbenchmark: do not permit model/provider
  // substitutions or stochastic configuration drift.
  if (!isDryRun && config.tier === "official") {
    assertPaidMicrobenchmarkProtocol(config);
  }

  const warnings: string[] = [];
  if (isDryRun && !configOverrides.dryRun) {
    warnings.push(
      "No API key configured — running in dry-run mode (not_executed).",
    );
  }
  if (config.measuredRounds < 3 && !isDryRun) {
    warnings.push(
      `Only ${config.measuredRounds} measured round(s). At least 3 recommended.`,
    );
  }

  // ── Setup isolated environment ──────────────────────────────
  // The benchmark always owns baseDir. projectDir is read-only input and must
  // never be placed under a directory cleaned up by this runner.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-agent-ab-"));
  const originalLynxHome = process.env.LYNX_HOME;
  const tempLynxHome = path.join(baseDir, "lynx-home");
  process.env.LYNX_HOME = tempLynxHome;
  fs.mkdirSync(tempLynxHome, { recursive: true });

  let db: LynxDatabase | null = null;
  const project = config.projectDir
    ? `agent-ab-external-${sha256Hash(path.resolve(config.projectDir))}`
    : "agent-ab-fixture";

  // ── Suite selection ─────────────────────────────────────────
  let tasks: BenchmarkTask[];
  let suiteOverrides: {
    lynxTools?: AgentToolDefinition[];
    lynxToolsForTask?: (task: BenchmarkTask) => AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
      task?: BenchmarkTask,
    ) => Promise<string>;
  } = {};
  let validatePreflight:
    ((fixtureDir: string) => { ok: boolean; errors: string[] }) | undefined;

  if (config.projectDir) {
    const projectDir = path.resolve(config.projectDir);
    const projectLabel = path.basename(projectDir);
    if (!fs.statSync(projectDir).isDirectory())
      throw new Error(`External project is not a directory: ${projectDir}`);
    tasks = makeExternalProjectTasks(projectLabel).filter(
      (task) => task.id !== 'external_missing_tests',
    );
    warnings.push(
      'External suite excludes untested-symbol discovery until it has a dedicated, verifiable graph operation.',
    );
    if (config.taskIds)
      tasks = tasks.filter((task) => config.taskIds!.includes(task.id));
    const realistic = await import("./realistic-suite.js");
    const allTools = realistic.makeLynxToolsRealistic();
    // Free/local screening is a directional filter, not a production-equivalent
    // catalogue test. Keep the tools needed by the external workflows so a
    // provider's small TPM allowance is not exhausted by unused schemas.
    const screeningTools = new Set<string>(["read_file"]);
    const toolsByTask = EXTERNAL_TASK_TOOL_PROFILES;
    for (const task of tasks) {
      for (const tool of toolsByTask[task.id] || []) screeningTools.add(tool);
    }
    suiteOverrides = {
      lynxToolsForTask: (task) => allTools.filter((tool) =>
        (toolsByTask[task.id] || ['read_file']).includes(tool.function.name) &&
        (config.tier !== "screening" || screeningTools.has(tool.function.name))
      ),
      lynxExecutor: (toolName, args, toolProject, fixtureDir, task) => {
        if (task?.id === 'external_dead_code' && toolName === 'find_dead_code') {
          args = { ...args, limit: Math.min(5, Number(args.limit) || 5) };
        }
        return realistic.executeLynxToolRealistic(toolName, args, toolProject, fixtureDir);
      },
    };
    if (config.tier === "screening") {
      warnings.push(
        `Screening uses a task-specific compact tool profile (${[...screeningTools].join(", ")}); official runs expose the full catalogue.`,
      );
    }
    warnings.push(
      `External project mode: read-only source at ${projectDir}; LYNX state remains temporary.`,
    );
  } else if (isRealistic) {
    const realistic = await import("./realistic-suite.js");
    tasks = realistic.TASKS_REALISTIC as BenchmarkTask[];
    suiteOverrides = {
      lynxTools: realistic.makeLynxToolsRealistic(),
      lynxExecutor: realistic.executeLynxToolRealistic,
    };
    validatePreflight = (fixtureDir) =>
      realistic.validateRealisticSuitePreflight(
        fixtureDir,
        realistic.makeLynxToolsRealistic().map((tool) => tool.function.name),
      );
    warnings.push(
      `Realistic suite: ${realistic.TASKS_REALISTIC.length} tasks, ${realistic.makeLynxToolsRealistic().length} LYNX tools.`,
    );
    const designedOnly = realistic.designedOnlyTools();
    if (designedOnly.length > 0) {
      warnings.push(
        `Designed-only tools (no deterministic assertion): ${designedOnly.join(", ")}`,
      );
    }
    const cov = realistic.coverageSummary();
    const taskKinds = realistic.taskEvaluationSummary(
      tasks as typeof realistic.TASKS_REALISTIC,
    );
    warnings.push(
      `Coverage: ${cov.executable} executable, ${cov.designed_only} designed-only, ${cov.excluded} excluded (${cov.total} total).`,
    );
    warnings.push(
      `Evaluation: ${taskKinds.deterministic} deterministic, ${taskKinds.partial} partial, ${taskKinds["designed-only"]} designed-only tasks.`,
    );
  } else {
    tasks = config.taskIds
      ? TASKS.filter((t) => config.taskIds!.includes(t.id))
      : TASKS;
  }

  // Allow taskIds to further filter the selected suite
  if (config.taskIds && isRealistic) {
    tasks = tasks.filter((t) => config.taskIds!.includes(t.id));
  }

  try {
    const fixtureDir = config.projectDir
      ? path.resolve(config.projectDir)
      : generateFixture(config.fixtureDir || baseDir);

    db = LynxDatabase.openProject(project);
    await runPipeline(db, fixtureDir, project, {
      mode: "fast",
      incremental: false,
      testSkipProjectBrief: true,
    });
    setDb(project, db);
    clearSessionDedup(project);
    const preflight = validatePreflight?.(fixtureDir);
    if (preflight && !preflight.ok) {
      throw new Error(
        `Realistic benchmark preflight failed: ${preflight.errors.join("; ")}`,
      );
    }
    if (preflight)
      warnings.push(
        "Realistic preflight passed: fixture, expectations, tool exposure, and coverage manifest are synchronized.",
      );

    // ── Counterbalanced order ──────────────────────────────
    const rng = seededRandom(config.seed);
    const shuffledTasks = shuffle(tasks, rng);
    const midPoint = Math.ceil(shuffledTasks.length / 2);
    const orderings: Array<{
      task: (typeof TASKS)[0];
      order: Array<"with_lynx" | "without_lynx">;
    }> = [];
    for (let i = 0; i < shuffledTasks.length; i++) {
      if (i < midPoint) {
        orderings.push({
          task: shuffledTasks[i],
          order: ["with_lynx", "without_lynx"],
        });
      } else {
        orderings.push({
          task: shuffledTasks[i],
          order: ["without_lynx", "with_lynx"],
        });
      }
    }

    // ── Warmup rounds (only if not dry run) ────────────────
    if (!isDryRun && config.warmupRounds > 0) {
      for (let w = 0; w < config.warmupRounds; w++) {
        if (isChained) {
          const taskPairs: [BenchmarkTask, BenchmarkTask][] = [];
          for (let i = 0; i < tasks.length; i += 2) {
            if (i + 1 < tasks.length) taskPairs.push([tasks[i], tasks[i + 1]]);
          }
          for (const pair of taskPairs) {
            for (const condition of [
              "with_lynx",
              "without_lynx",
            ] as const) {
              await runChainedAgentTasks(
                pair,
                condition,
                config,
                project,
                fixtureDir,
                false,
                suiteOverrides,
              );
            }
          }
        } else {
          for (const { task, order } of orderings) {
            for (const condition of order) {
              await runSingleAgentTask(
                task,
                condition,
                config,
                project,
                fixtureDir,
                false,
                suiteOverrides,
              );
            }
          }
        }
      }
    }

    // ── Measured rounds ───────────────────────────────────
    const totalMeasured = isDryRun ? 1 : config.measuredRounds;
    const totalRuns = totalMeasured * orderings.length * 2; // 2 conditions per task
    const { onProgress, checkpointPath } = runOpts;
    const allRuns: AgentABRun[] = [];

    // Resume only checkpoints created for the exact same experiment. A completed
    // task/condition/seed tuple is never paid for twice.
    if (checkpointPath && fs.existsSync(checkpointPath)) {
      try {
        const checkpoint = JSON.parse(
          fs.readFileSync(checkpointPath, "utf-8"),
        ) as AgentABResult;
        const checkpointConfig = checkpoint.config as AgentABConfig;
        const sameTaskIds =
          JSON.stringify(checkpointConfig.taskIds ?? []) ===
          JSON.stringify(config.taskIds ?? []);
        const compatible =
          checkpointConfig.seed === config.seed &&
          checkpointConfig.model === config.model &&
          checkpointConfig.projectDir === config.projectDir &&
          checkpointConfig.measuredRounds === config.measuredRounds &&
          sameTaskIds;
        if (compatible && Array.isArray(checkpoint.tasks)) {
          const selectedTaskIds = new Set(tasks.map((task) => task.id));
          for (const run of checkpoint.tasks) {
            if (selectedTaskIds.has(run.task_id) && !run.not_executed)
              allRuns.push(run);
          }
          if (allRuns.length > 0)
            warnings.push(
              `Resumed ${allRuns.length} completed run(s) from checkpoint; completed API calls were not repeated.`,
            );
        }
      } catch {
        warnings.push(
          "Existing checkpoint could not be resumed safely and was ignored.",
        );
      }
    }

    const completedRunKeys = new Set(
      allRuns.map((run) => `${run.task_id}|${run.condition}|${run.seed}`),
    );

    const writeCheckpoint = () => {
      if (!checkpointPath) return;
      const partial: AgentABResult = {
        config: (() => {
          const { apiKey: _, ...safe } = config;
          return safe;
        })(),
        methodology: ["checkpoint — benchmark in progress"],
        tasks: [...allRuns],
        summary: buildAgentSummary(
          allRuns.filter((r) => r.condition === "with_lynx"),
          allRuns.filter((r) => r.condition === "without_lynx"),
          tasks.length,
          config,
        ),
        warnings,
      };
      const tmp = checkpointPath + ".tmp";
      fs.writeFileSync(tmp, agentResultToJSON(partial, !!runOpts.includeTrace));
      fs.renameSync(tmp, checkpointPath);
    };

    for (let r = 0; r < totalMeasured; r++) {
      if (isChained) {
        // Chained mode: pair tasks [t0,t1], [t2,t3], ... each pair shares one conversation
        const taskPairs: [BenchmarkTask, BenchmarkTask][] = [];
        for (let i = 0; i < tasks.length; i += 2) {
          if (i + 1 < tasks.length) taskPairs.push([tasks[i], tasks[i + 1]]);
        }
        if (taskPairs.length === 0) {
          throw new Error(
            "Chained mode requires at least 2 tasks to form a pair",
          );
        }
        const chainedTotal = totalMeasured * taskPairs.length * 2; // 2 conditions per pair
        for (let pi = 0; pi < taskPairs.length; pi++) {
          for (const condition of ["with_lynx", "without_lynx"] as const) {
            const roundSeed = config.seed + r * 1000;
            const runKey = `${taskPairs[pi][0].id}+${taskPairs[pi][1].id}|${condition}|${roundSeed}`;
            if (completedRunKeys.has(runKey)) continue;
            const roundConfig = { ...config, seed: roundSeed };
            const pairRuns = await runChainedAgentTasks(
              taskPairs[pi],
              condition,
              roundConfig,
              project,
              fixtureDir,
              !!runOpts.includeTrace,
              suiteOverrides,
            );
            for (let j = 0; j < pairRuns.length; j++) {
              pairRuns[j].order_position = pi * 2 + j;
              pairRuns[j].seed = config.seed + r * 1000;
              allRuns.push(pairRuns[j]);
            }

            if (checkpointPath) writeCheckpoint();
            if (onProgress) {
              onProgress({
                current: allRuns.length,
                total: chainedTotal,
                run: pairRuns[0],
                allRuns: [...allRuns],
              });
            }
          }
        }
      } else {
        for (let pos = 0; pos < orderings.length; pos++) {
          const { task, order } = orderings[pos];
          for (const condition of order) {
            const roundSeed = config.seed + r * 1000;
            const runKey = `${task.id}|${condition}|${roundSeed}`;
            if (completedRunKeys.has(runKey)) continue;
            const roundConfig = { ...config, seed: roundSeed };
            const run = await runSingleAgentTask(
              task,
              condition,
              roundConfig,
              project,
              fixtureDir,
              !!runOpts.includeTrace,
              suiteOverrides,
            );
            run.order_position = pos;
            run.seed = config.seed + r * 1000;
            allRuns.push(run);

            if (checkpointPath) writeCheckpoint();
            if (onProgress) {
              onProgress({
                current: allRuns.length,
                total: totalRuns,
                run,
                allRuns: [...allRuns],
              });
            }
          }
        }
      }
    }

    const withRuns = allRuns.filter((r) => r.condition === "with_lynx");
    const withoutRuns = allRuns.filter((r) => r.condition === "without_lynx");
    const summary = buildAgentSummary(
      withRuns,
      withoutRuns,
      tasks.length,
      config,
    );
    const screeningToolNames = (suiteOverrides.lynxTools || [])
      .map((tool) => tool.function.name)
      .join(", ");

    return {
      config: (() => {
        const { apiKey: _, ...safe } = config;
        return safe;
      })(),
      methodology: [
        isExternalProject
          ? `One read-only external-project analysis task executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent; it is operationally measured but not success-scored.`
          : isRealistic
            ? `${tasks.filter((t) => evaluationKind(t) === "deterministic").length} deterministic, ${tasks.filter((t) => evaluationKind(t) === "partial").length} partial, and ${tasks.filter((t) => evaluationKind(t) === "designed-only").length} designed-only tasks (5 core + 10 workflow) executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent.`
            : `5 deterministic tasks executed through a ${config.tier === "screening" ? "screening" : "DeepSeek"} LLM agent.`,
        isRealistic || isExternalProject
          ? config.tier === "screening"
            ? `with_lynx: LLM has access to a task-specific compact LYNX profile (${screeningToolNames}).`
            : "with_lynx: LLM has access only to the task-specific LYNX tool profile plus read_file."
          : "with_lynx: LLM has access to LYNX graph tools (search_graph, trace_path, explain_symbol, find_tests) + read_file.",
        "without_lynx: LLM has access to read_file + grep only.",
        "Fresh conversation per task x condition x run. No shared history or cache between conditions.",
        config.tier === "screening"
          ? "Screening tier: provider/model results are exploratory only and are excluded from the official DeepSeek history and acceptance decisions."
          : "Paid microbenchmark protocol: exact deepseek-v4-flash, temperature 0, fixed per-round seeds, identical prompts/order/limits/runtime; no model or provider fallback.",
        `Mode: ${isDryRun ? "dry-run (not_executed)" : "live API calls"}. Suite: ${isExternalProject ? "external-project" : isRealistic ? "realistic" : "default"}.`,
        config.tier === "screening"
          ? "Screening cost is not comparable to the official pricing series. Wall time includes API latency."
          : "Cost is estimated from token usage and configured pricing. Wall time includes API latency.",
        ...(isExternalProject && config.maxToolCalls !== undefined
          ? [`External-project budget: each condition is capped at ${config.maxToolCalls} tool calls per task to prevent an unsupported workflow from consuming unbounded paid context.`]
          : []),
        "ROI claims blocked when baseline invalid or sample size too small.",
      ],
      tasks: allRuns,
      summary,
      warnings,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    clearFederatedConfig();
    clearSessionDedup(project);
    if (originalLynxHome !== undefined) {
      process.env.LYNX_HOME = originalLynxHome;
    } else {
      delete process.env.LYNX_HOME;
    }
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Single task runner ────────────────────────────────────────

async function runSingleAgentTask(
  task: BenchmarkTask,
  condition: "with_lynx" | "without_lynx",
  config: AgentABConfig,
  project: string,
  fixtureDir: string,
  includeTrace: boolean,
  overrides?: {
    lynxTools?: AgentToolDefinition[];
    lynxToolsForTask?: (task: BenchmarkTask) => AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
      task?: BenchmarkTask,
    ) => Promise<string>;
  },
): Promise<AgentABRun> {
  const runId = generateRunId();
  const isWithLynx = condition === "with_lynx";

  // Fresh messages array per run — deep copy to guarantee isolation
  const messages: AgentMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: task.userPrompt },
  ];

  const tools = isWithLynx
    ? (overrides?.lynxToolsForTask?.(task) ?? overrides?.lynxTools ?? makeLynxTools())
    : makeBaselineTools();
  const shared = getSharedParams(config);

  let usage: ApiUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let modelVersion: string | null = null;
  let apiLatency = 0;
  let responseContent = "";
  let allToolCalls: AgentToolCall[] = [];
  const filesRead = new Set<string>();
  let bytesRead = 0;
  let notExecuted = false;
  let notExecutedReason: string | undefined;
  let toolLoopExhausted = false;
  let finalizationError: string | undefined;
  const executionErrors: string[] = [];
  const traceSteps: ToolTraceStep[] = [];

  const startTime = Date.now();

  if (config.dryRun) {
    notExecuted = true;
    notExecutedReason = "dry-run mode — no API key configured";
  } else {
    try {
      const result = await chatCompletion(
        {
          model: shared.model,
          messages,
          tools,
          temperature: shared.temperature,
          seed: shared.seed,
          ...(config.maxTokens !== undefined
            ? { max_tokens: config.maxTokens }
            : {}),
        },
        {
          onToolCall: async (tc) => {
            const args = JSON.parse(tc.function.arguments || "{}");
            if (isWithLynx) {
              if (overrides?.lynxExecutor) {
                return overrides.lynxExecutor(
                  tc.function.name,
                  args,
                  project,
                  fixtureDir,
                  task,
                );
              }
              return executeLynxTool(
                tc.function.name,
                args,
                project,
                fixtureDir,
              );
            }
            return executeBaselineTool(tc.function.name, args, fixtureDir);
          },
          onTrace: includeTrace
            ? (step: ToolTraceStep) => {
                traceSteps.push(step);
              }
            : undefined,
        },
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          ...(shared.timeoutMs !== undefined
            ? { timeoutMs: shared.timeoutMs }
            : {}),
          ...(shared.maxRetries !== undefined
            ? { maxRetries: shared.maxRetries }
            : {}),
          ...(config.maxToolCalls !== undefined
            ? { maxToolCalls: config.maxToolCalls }
            : {}),
        },
      );

      allToolCalls = result.toolCalls;
      usage = result.usage;
      modelVersion = result.model || null;
      apiLatency = result.latencyMs;
      toolLoopExhausted = result.toolLoopExhausted;
      finalizationError = result.finalizationError;

      // Extract final assistant response
      const lastAssistant = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.content);
      responseContent = lastAssistant?.content || "";

      // Track files read by tools
      for (const tc of result.toolCalls) {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (tc.function.name === "read_file" && args.path) {
          const resolved = path.resolve(fixtureDir, String(args.path));
          const normalized = path.resolve(fixtureDir) + path.sep;
          if (resolved.startsWith(normalized)) {
            filesRead.add(resolved);
            try {
              bytesRead += fs.statSync(resolved).size;
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (err) {
      const errMsg = redactSecrets(String(err));
      // chatCompletion no longer throws on exhaustion — only real failures reach here
      responseContent = `Error: ${errMsg}`;
      executionErrors.push(`provider_request_failed: ${errMsg}`);
    }
  }

  const totalTime = Date.now() - startTime;
  if (modelVersion && modelVersion !== config.model) {
    executionErrors.push(
      `provider_model_mismatch: expected ${config.model}, received ${modelVersion}`,
    );
  }
  const kind = evaluationKind(task);
  const evaluation = notExecuted
    ? {
        result: {} as Record<string, unknown>,
        correct: false,
        defects: Object.keys(task.expected).length,
        errors: ["not_executed"],
      }
    : task.id === "external_dead_code"
      ? await evaluateExternalDeadCodeResponse(responseContent, project)
      : evaluateResponse(responseContent, task.expected);

  const cost = config.tier === "screening" ? 0 : computeCost(usage);

  return {
    run_id: runId,
    task_id: task.id,
    condition,
    order_position: 0,
    seed: 0,
    messages,
    toolCalls: allToolCalls,
    response: responseContent,
    responseHash: sha256Hash(responseContent),
    metrics: {
      model: config.model,
      model_version: modelVersion,
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      cached_tokens: usage.prompt_cache_hit_tokens || 0,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      tool_call_count: allToolCalls.length,
      files_read: filesRead.size,
      bytes_read: bytesRead,
      wall_time_ms: totalTime,
      api_latency_ms: apiLatency,
      cost_usd: cost,
      cost_classification: "estimated" as const,
      functional_success:
        kind !== "designed-only" &&
        evaluation.correct &&
        executionErrors.length === 0,
      defects_introduced: kind === "designed-only" ? 0 : evaluation.defects,
      fixes_needed: kind === "designed-only" ? 0 : evaluation.defects,
      not_executed: notExecuted,
    },
    result: evaluation.result,
    expected: task.expected,
    correct: evaluation.correct && executionErrors.length === 0,
    evaluation_eligible: isEvaluationEligible(task),
    evaluation_kind: kind,
    errors: [...evaluation.errors, ...executionErrors],
    not_executed: notExecuted,
    not_executed_reason: notExecutedReason,
    tool_loop_exhausted: toolLoopExhausted,
    finalization_error: finalizationError,
    ...(includeTrace && traceSteps.length > 0 ? { trace: traceSteps } : {}),
  };
}

// ── Chained multi-turn runner ──────────────────────────────────

async function runChainedAgentTasks(
  tasks: [BenchmarkTask, BenchmarkTask],
  condition: "with_lynx" | "without_lynx",
  config: AgentABConfig,
  project: string,
  fixtureDir: string,
  includeTrace: boolean,
  overrides?: {
    lynxTools?: AgentToolDefinition[];
    lynxExecutor?: (
      toolName: string,
      args: Record<string, unknown>,
      project: string,
      fixtureDir: string,
    ) => Promise<string>;
  },
): Promise<[AgentABRun, AgentABRun]> {
  const isWithLynx = condition === "with_lynx";
  const shared = getSharedParams(config);
  const tools = isWithLynx
    ? (overrides?.lynxTools ?? makeLynxTools())
    : makeBaselineTools();

  // Shared conversation — starts with task1's prompt
  const messages: AgentMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: tasks[0].userPrompt },
  ];

  async function runOneTask(
    task: BenchmarkTask,
    taskIndex: number,
  ): Promise<{
    run: AgentABRun;
    toolResult: {
      allToolCalls: AgentToolCall[];
      usage: ApiUsage;
      modelVersion: string | null;
      apiLatency: number;
      toolLoopExhausted: boolean;
      finalizationError: string | undefined;
      traceSteps: ToolTraceStep[];
      responseContent: string;
      filesRead: Set<string>;
      bytesRead: number;
    };
  }> {
    const runId = generateRunId();
    let usage: ApiUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let modelVersion: string | null = null;
    let apiLatency = 0;
    let responseContent = "";
    let allToolCalls: AgentToolCall[] = [];
    const filesRead = new Set<string>();
    let bytesRead = 0;
    let toolLoopExhausted = false;
    let finalizationError: string | undefined;
    const executionErrors: string[] = [];
    const traceSteps: ToolTraceStep[] = [];
    const startTime = Date.now();

    if (!config.dryRun) {
      try {
        const result = await chatCompletion(
          {
            model: shared.model,
            messages,
          tools,
          temperature: shared.temperature,
          seed: shared.seed + taskIndex * 1000,
          ...(config.maxTokens !== undefined
            ? { max_tokens: config.maxTokens }
            : {}),
          },
          {
            onToolCall: async (tc) => {
              const args = JSON.parse(tc.function.arguments || "{}");
              if (isWithLynx) {
                if (overrides?.lynxExecutor) {
                  return overrides.lynxExecutor(
                    tc.function.name,
                    args,
                    project,
                    fixtureDir,
                  );
                }
                return executeLynxTool(
                  tc.function.name,
                  args,
                  project,
                  fixtureDir,
                );
              }
              return executeBaselineTool(tc.function.name, args, fixtureDir);
            },
            onTrace: includeTrace
              ? (step: ToolTraceStep) => {
                  traceSteps.push(step);
                }
              : undefined,
          },
          {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            ...(shared.timeoutMs !== undefined
              ? { timeoutMs: shared.timeoutMs }
              : {}),
            ...(shared.maxRetries !== undefined
              ? { maxRetries: shared.maxRetries }
              : {}),
            ...(config.maxToolCalls !== undefined
              ? { maxToolCalls: config.maxToolCalls }
              : {}),
          },
        );

        // chatCompletion mutates messages in place — all tool results and assistant
        // responses are already appended. We just add task2's prompt as user message.
        allToolCalls = result.toolCalls;
        usage = result.usage;
        modelVersion = result.model || null;
        apiLatency = result.latencyMs;
        toolLoopExhausted = result.toolLoopExhausted;
        finalizationError = result.finalizationError;

        const lastAssistant = [...result.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.content);
        responseContent = lastAssistant?.content || "";

        for (const tc of result.toolCalls) {
          const args = JSON.parse(tc.function.arguments || "{}");
          if (tc.function.name === "read_file" && args.path) {
            const resolved = path.resolve(fixtureDir, String(args.path));
            if (resolved.startsWith(path.resolve(fixtureDir) + path.sep)) {
              filesRead.add(resolved);
              try {
                bytesRead += fs.statSync(resolved).size;
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err) {
        const errMsg = redactSecrets(String(err));
        responseContent = `Error: ${errMsg}`;
        executionErrors.push(`provider_request_failed: ${errMsg}`);
      }
    }

    const totalTime = Date.now() - startTime;
    const kind = evaluationKind(task);
    const isDry = !!config.dryRun;
    const evaluation = isDry
      ? {
          result: {} as Record<string, unknown>,
          correct: false,
          defects: Object.keys(task.expected).length,
          errors: ["not_executed"],
        }
      : task.id === "external_dead_code"
        ? await evaluateExternalDeadCodeResponse(responseContent, project)
        : evaluateResponse(responseContent, task.expected);

    const cost = config.tier === "screening" ? 0 : computeCost(usage);

    const run: AgentABRun = {
      run_id: runId,
      task_id: task.id,
      condition,
      order_position: taskIndex,
      seed: shared.seed + taskIndex * 1000,
      messages: messages.map((m) => ({ ...m })), // snapshot
      toolCalls: allToolCalls,
      response: responseContent,
      responseHash: sha256Hash(responseContent),
      metrics: {
        model: config.model,
        model_version: modelVersion,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cached_tokens: usage.prompt_cache_hit_tokens || 0,
        reasoning_tokens:
          usage.completion_tokens_details?.reasoning_tokens || 0,
        tool_call_count: allToolCalls.length,
        files_read: filesRead.size,
        bytes_read: bytesRead,
        wall_time_ms: totalTime,
        api_latency_ms: apiLatency,
        cost_usd: cost,
        cost_classification: "estimated" as const,
        functional_success:
          kind !== "designed-only" &&
          evaluation.correct &&
          executionErrors.length === 0,
        defects_introduced: kind === "designed-only" ? 0 : evaluation.defects,
        fixes_needed: kind === "designed-only" ? 0 : evaluation.defects,
        not_executed: isDry,
      },
      result: evaluation.result,
      expected: task.expected,
      correct: evaluation.correct && executionErrors.length === 0,
      evaluation_eligible: isEvaluationEligible(task),
      evaluation_kind: kind,
      errors: [...evaluation.errors, ...executionErrors],
      not_executed: isDry,
      not_executed_reason: isDry ? "dry-run mode" : undefined,
      tool_loop_exhausted: toolLoopExhausted,
      finalization_error: finalizationError,
      ...(includeTrace && traceSteps.length > 0 ? { trace: traceSteps } : {}),
    };

    return {
      run,
      toolResult: {
        allToolCalls,
        usage,
        modelVersion,
        apiLatency,
        toolLoopExhausted,
        finalizationError,
        traceSteps,
        responseContent,
        filesRead,
        bytesRead,
      },
    };
  }

  // Task 1
  const { run: run1 } = await runOneTask(tasks[0], 0);

  // Append task 2's prompt and continue the SAME conversation
  messages.push({ role: "user", content: tasks[1].userPrompt });

  // Task 2
  const { run: run2 } = await runOneTask(tasks[1], 1);

  return [run1, run2];
}

// ── Summary builder ───────────────────────────────────────────

function buildAgentSummary(
  withRuns: AgentABRun[],
  withoutRuns: AgentABRun[],
  taskCount: number,
  config: AgentABConfig,
): AgentABSummary {
  const withWall = withRuns.map((r) => r.metrics.wall_time_ms);
  const withoutWall = withoutRuns.map((r) => r.metrics.wall_time_ms);
  const withInput = withRuns.map((r) => r.metrics.input_tokens);
  const withoutInput = withoutRuns.map((r) => r.metrics.input_tokens);
  const withOutput = withRuns.map((r) => r.metrics.output_tokens);
  const withoutOutput = withoutRuns.map((r) => r.metrics.output_tokens);
  const withTools = withRuns.map((r) => r.metrics.tool_call_count);
  const withoutTools = withoutRuns.map((r) => r.metrics.tool_call_count);
  const withCost = withRuns.map((r) => r.metrics.cost_usd);
  const withoutCost = withoutRuns.map((r) => r.metrics.cost_usd);

  const sort = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const med = (arr: number[]) => {
    const s = sort(arr);
    return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
  };
  const p95 = (arr: number[]) => {
    const s = sort(arr);
    return s.length === 0
      ? 0
      : s[Math.ceil(s.length * 0.95) - 1] || s[s.length - 1];
  };
  const total = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const withEvaluated = withRuns.filter((r) => r.evaluation_eligible);
  const withoutEvaluated = withoutRuns.filter((r) => r.evaluation_eligible);
  const withDeterministic = withRuns.filter(
    (r) => r.evaluation_kind === "deterministic" && r.evaluation_eligible,
  );
  const withoutDeterministic = withoutRuns.filter(
    (r) => r.evaluation_kind === "deterministic" && r.evaluation_eligible,
  );
  const withCorrect = withEvaluated.filter((r) => r.correct).length;
  const withoutCorrect = withoutEvaluated.filter((r) => r.correct).length;

  // buildCond uses its OWN runs for defects_per_task — FIXED from previous version
  const buildCond = (
    runs: AgentABRun[],
    wall: number[],
    inputT: number[],
    outputT: number[],
    tools: number[],
    cost: number[],
    correct: number,
    totalRuns: number,
  ) => ({
    wall_time_ms: { median: med(wall), p95: p95(wall) },
    input_tokens: { median: med(inputT), total: total(inputT) },
    output_tokens: { median: med(outputT), total: total(outputT) },
    cached_tokens: {
      median: med(runs.map((r) => r.metrics.cached_tokens)),
      total: total(runs.map((r) => r.metrics.cached_tokens)),
    },
    reasoning_tokens: {
      median: med(runs.map((r) => r.metrics.reasoning_tokens)),
      total: total(runs.map((r) => r.metrics.reasoning_tokens)),
    },
    tool_calls: { median: med(tools), total: total(tools) },
    cost_usd: { median: med(cost), total: total(cost) },
    functional_success_rate: totalRuns > 0 ? correct / totalRuns : 0,
    evaluated_runs: totalRuns,
    excluded_from_evaluation: runs.length - totalRuns,
    defects_per_task:
      totalRuns > 0
        ? total(
            runs
              .filter((r) => r.evaluation_eligible)
              .map((r) => r.metrics.defects_introduced),
          ) / totalRuns
        : 0,
  });

  const withCond = buildCond(
    withRuns,
    withWall,
    withInput,
    withOutput,
    withTools,
    withCost,
    withCorrect,
    withEvaluated.length,
  );
  const withoutCond = buildCond(
    withoutRuns,
    withoutWall,
    withoutInput,
    withoutOutput,
    withoutTools,
    withoutCost,
    withoutCorrect,
    withoutEvaluated.length,
  );

  const pctDelta = (a: number, b: number) => {
    if (b === 0) return a === 0 ? "0%" : "N/A";
    return `${(((a - b) / b) * 100).toFixed(1)}%`;
  };

  const notExecuted =
    withRuns.every((r) => r.not_executed) ||
    withoutRuns.every((r) => r.not_executed);

  const comparison = [
    {
      metric: "Median wall time",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.wall_time_ms.median}ms`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.wall_time_ms.median}ms`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.wall_time_ms.median,
            withoutCond.wall_time_ms.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no measurements taken"
        : "Wall time including API latency",
    },
    {
      metric: "Input tokens (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.input_tokens.median}`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.input_tokens.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.input_tokens.median,
            withoutCond.input_tokens.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no tokens consumed"
        : "Input tokens from API usage",
    },
    {
      metric: "Output tokens (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.output_tokens.median}`,
      without_lynx: notExecuted
        ? "N/A"
        : `${withoutCond.output_tokens.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.output_tokens.median,
            withoutCond.output_tokens.median,
          ),
      interpretation: notExecuted
        ? "Dry run — no tokens consumed"
        : "Output tokens from API usage",
    },
    {
      metric: "Tool calls (median)",
      class: "measured" as const,
      with_lynx: notExecuted ? "N/A" : `${withCond.tool_calls.median}`,
      without_lynx: notExecuted ? "N/A" : `${withoutCond.tool_calls.median}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(withCond.tool_calls.median, withoutCond.tool_calls.median),
      interpretation: notExecuted
        ? "Dry run — no tool calls"
        : "Number of tool call turns",
    },
    {
      metric: "Cost USD (median)",
      class: "estimated" as const,
      with_lynx: notExecuted
        ? "N/A"
        : `$${withCond.cost_usd.median.toFixed(6)}`,
      without_lynx: notExecuted
        ? "N/A"
        : `$${withoutCond.cost_usd.median.toFixed(6)}`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(withCond.cost_usd.median, withoutCond.cost_usd.median),
      interpretation: notExecuted
        ? "Dry run — no cost"
        : "Estimated from token usage and published pricing",
    },
    {
      metric: "Functional success rate",
      class: "measured" as const,
      with_lynx: notExecuted
        ? "N/A"
        : `${(withCond.functional_success_rate * 100).toFixed(0)}%`,
      without_lynx: notExecuted
        ? "N/A"
        : `${(withoutCond.functional_success_rate * 100).toFixed(0)}%`,
      delta: notExecuted
        ? "N/A"
        : pctDelta(
            withCond.functional_success_rate,
            withoutCond.functional_success_rate,
          ),
      interpretation: notExecuted
        ? "Dry run — not evaluated"
        : "Correctness of task results vs expected",
    },
  ];

  // Partial assertions remain useful operational evidence, but cannot unlock ROI.
  const sampleSize = Math.min(
    withDeterministic.length,
    withoutDeterministic.length,
  );
  const roiBlocked = sampleSize < 6 || config.dryRun;

  return {
    with_lynx: withCond,
    without_lynx: withoutCond,
    comparison,
    sample_size_note: config.dryRun
      ? "DRY RUN — no API calls were executed. All metrics are N/A."
      : `Based on ${sampleSize} deterministic measured runs with real API calls (${Math.min(withEvaluated.length, withoutEvaluated.length)} evaluated including partial assertions).`,
    roi_blocked: roiBlocked,
    roi_blocked_reason: roiBlocked
      ? config.dryRun
        ? "Dry run — no real API cost data."
        : `Deterministic sample size too small (${sampleSize} runs). Need at least 6.`
      : null,
  };
}

// ── Output generators ─────────────────────────────────────────

/** Sanitized aggregate for historical diagnosis; never includes tool arguments. */
export function toolCallSummary(
  toolCalls: AgentToolCall[] | undefined,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const call of toolCalls || []) {
    const name = call.function?.name || "unknown";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function agentResultToJSON(
  result: AgentABResult,
  includeTrace = false,
): string {
  return JSON.stringify(
    {
      config: result.config,
      methodology: result.methodology,
      summary: result.summary,
      experiment_protocol:
        result.config.tier === "screening" ? null : buildExperimentProtocol(result),
      tasks: result.tasks.map((r) => ({
        run_id: r.run_id,
        task_id: r.task_id,
        condition: r.condition,
        not_executed: r.not_executed,
        order_position: r.order_position,
        seed: r.seed,
        messages: r.messages,
        metrics: r.metrics,
        correct: r.correct,
        evaluation_eligible: r.evaluation_eligible,
        evaluation_kind: r.evaluation_kind,
        tool_loop_exhausted: r.tool_loop_exhausted,
        finalization_error: r.finalization_error,
        errors: r.errors,
        // Keep the final answer for qualitative A/B review; never serialize secrets.
        response: redactSecrets(r.response),
        response_hash: r.responseHash,
        tool_calls: r.toolCalls?.length ?? r.metrics.tool_call_count,
        tool_call_summary: toolCallSummary(r.toolCalls),
        ...(includeTrace && r.trace ? { trace: r.trace } : {}),
      })),
      warnings: result.warnings,
    },
    null,
    2,
  );
}

export function agentResultToCSV(result: AgentABResult): string {
  const header = [
    "run_id",
    "task_id",
    "condition",
    "not_executed",
    "order_position",
    "seed",
    "model",
    "model_version",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "tool_call_count",
    "files_read",
    "bytes_read",
    "wall_time_ms",
    "api_latency_ms",
    "cost_usd",
    "cost_classification",
    "functional_success",
    "defects_introduced",
    "evaluation_kind",
    "evaluation_eligible",
    "tool_loop_exhausted",
    "finalization_error",
    "correct",
    "errors",
  ].join(",");

  const csv = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const rows = result.tasks.map((r) =>
    [
      r.run_id,
      r.task_id,
      r.condition,
      r.not_executed,
      r.order_position,
      r.seed,
      r.metrics.model,
      r.metrics.model_version ?? "",
      r.metrics.input_tokens,
      r.metrics.output_tokens,
      r.metrics.cached_tokens,
      r.metrics.reasoning_tokens,
      r.metrics.tool_call_count,
      r.metrics.files_read,
      r.metrics.bytes_read,
      r.metrics.wall_time_ms,
      r.metrics.api_latency_ms,
      r.metrics.cost_usd,
      r.metrics.cost_classification,
      r.metrics.functional_success,
      r.metrics.defects_introduced,
      r.evaluation_kind,
      r.evaluation_eligible,
      r.tool_loop_exhausted,
      csv(r.finalization_error),
      r.correct,
      csv((r.errors || []).join("; ")),
    ].join(","),
  );

  return [header, ...rows].join("\n") + "\n";
}

// ── Auto-save ────────────────────────────────────────────────

function lynxRoot(): string {
  // Prefer the binary's project root (dist/cli/agent-ab/ → walk up).
  // This ensures benchmarks always save to the authoritative LYNX checkout,
  // not to a stale CWD copy.
  let dir = benchmarkDir;
  for (let i = 0; i < 4; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fall back to CWD
  return process.cwd();
}

export function externalProjectLabel(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  const leaf = path.basename(resolved);
  return leaf.toLowerCase() === "source"
    ? path.basename(path.dirname(resolved))
    : leaf;
}

export function classifyAgentABResultValidity(result: AgentABResult): {
  valid: boolean;
  reasons: string[];
  executed_runs: number;
  evaluated_runs: number;
  complete_pairs: number;
} {
  const reasons: string[] = [];
  const executed = result.tasks.filter((run) => !run.not_executed);
  const evaluated = executed.filter((run) => run.evaluation_eligible);
  const providerFailures = executed.filter((run) =>
    run.errors?.some((error) => error.startsWith("provider_request_failed:")),
  );
  const byPair = new Map<string, Set<AgentABRun["condition"]>>();

  for (const run of executed) {
    const key = run.task_id + ":" + run.seed + ":" + run.order_position;
    const conditions = byPair.get(key) || new Set<AgentABRun["condition"]>();
    conditions.add(run.condition);
    byPair.set(key, conditions);
  }

  const completePairs = [...byPair.values()].filter(
    (conditions) =>
      conditions.has("with_lynx") && conditions.has("without_lynx"),
  ).length;

  if (result.tasks.length === 0) reasons.push("no_runs");
  if (executed.length === 0) reasons.push("no_executed_runs");
  if (completePairs === 0) reasons.push("no_complete_pairs");
  if (providerFailures.length > 0) reasons.push("provider_request_failed");

  return {
    valid: reasons.length === 0,
    reasons,
    executed_runs: executed.length,
    evaluated_runs: evaluated.length,
    complete_pairs: completePairs,
  };
}

function autoSaveResult(
  result: AgentABResult,
  outPath: string | null,
  stderrPath: string | null,
): void {
  const root = lynxRoot();
  const resultsDir = result.config.tier === "screening"
    ? path.join(root, "benchmarks", "results", "screening")
    : path.join(root, "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const projectLabel = result.config.projectDir
    ? externalProjectLabel(result.config.projectDir)
    : (result.config as any).suite || "default";
  const seed = result.config.seed;
  const baseName = `${ts}_${projectLabel}_seed${seed}`;

  // 1. Full JSON
  const jsonPath = path.join(resultsDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // 2. Responses artifact (side-by-side full text, like Codex)
  const responses: Record<string, unknown> = {
    generated: now.toISOString(),
    project: projectLabel,
    seed,
    model: result.config.model,
    tier: result.config.tier,
    tasks: [] as Record<string, unknown>[],
  };
  // Group by task_id
  const byTask = new Map<string, AgentABRun[]>();
  for (const run of result.tasks) {
    const list = byTask.get(run.task_id) || [];
    list.push(run);
    byTask.set(run.task_id, list);
  }
  for (const [taskId, runs] of byTask) {
    const lynxRun = runs.find((r) => r.condition === "with_lynx");
    const baselineRun = runs.find((r) => r.condition === "without_lynx");
    (responses.tasks as Array<Record<string, unknown>>).push({
      task_id: taskId,
      lynx: lynxRun
        ? {
            response: lynxRun.response,
            wall_ms: lynxRun.metrics.wall_time_ms,
            tool_calls: lynxRun.metrics.tool_call_count,
            tool_call_summary: toolCallSummary(lynxRun.toolCalls),
            input_tokens: lynxRun.metrics.input_tokens,
            cost_usd: lynxRun.metrics.cost_usd,
            errors: lynxRun.errors,
            tool_loop_exhausted: lynxRun.tool_loop_exhausted,
            finalization_error: lynxRun.finalization_error,
          }
        : null,
      baseline: baselineRun
        ? {
            response: baselineRun.response,
            wall_ms: baselineRun.metrics.wall_time_ms,
            tool_calls: baselineRun.metrics.tool_call_count,
            tool_call_summary: toolCallSummary(baselineRun.toolCalls),
            input_tokens: baselineRun.metrics.input_tokens,
            cost_usd: baselineRun.metrics.cost_usd,
            errors: baselineRun.errors,
          }
        : null,
    });
  }
  fs.writeFileSync(
    path.join(resultsDir, `${baseName}.responses.json`),
    JSON.stringify(responses, null, 2),
  );

  // 3. Append to index
  const idxPath = path.join(resultsDir, "_index.jsonl");
  const lynxCost = result.summary.with_lynx.cost_usd?.total ?? 0;
  const baselineCost = result.summary.without_lynx.cost_usd?.total ?? 0;
  const lynxWall = result.summary.with_lynx.wall_time_ms?.median ?? 0;
  const baselineWall = result.summary.without_lynx.wall_time_ms?.median ?? 0;
  const lynxSuccess = result.summary.with_lynx.functional_success_rate;
  const baselineSuccess = result.summary.without_lynx.functional_success_rate;
  const validity = classifyAgentABResultValidity(result);
  const indexEntry = {
    timestamp: now.toISOString(),
    base_name: baseName,
    project: projectLabel,
    seed,
    model: result.config.model,
    tier: result.config.tier,
    tasks: result.tasks.length,
    valid: validity.valid,
    invalid_reasons: validity.reasons,
    executed_runs: validity.executed_runs,
    evaluated_runs: validity.evaluated_runs,
    complete_pairs: validity.complete_pairs,
    lynx: {
      success_rate: lynxSuccess,
      median_wall_ms: lynxWall,
      total_cost_usd: lynxCost,
    },
    baseline: {
      success_rate: baselineSuccess,
      median_wall_ms: baselineWall,
      total_cost_usd: baselineCost,
    },
    context_limit_hit: result.tasks.some(
      (r) =>
        r.condition === "without_lynx" &&
        r.errors?.some((e) => e.includes("maximum context length")),
    ),
  };
  fs.appendFileSync(idxPath, JSON.stringify(indexEntry) + "\n");

  // Log paths
  const stderr = outPath ? ` (also at ${outPath})` : "";
  console.error(`Saved ${baseName}.json${stderr}`);
  console.error(`Index: ${idxPath}`);

  // If there was a stderr file, copy it alongside
  if (stderrPath && fs.existsSync(stderrPath)) {
    try {
      fs.copyFileSync(stderrPath, path.join(resultsDir, `${baseName}.log`));
    } catch {
      /* best effort */
    }
  }
}

interface ParsedCliArgs {
  config: Partial<AgentABConfig>;
  jsonFlag: boolean;
  csvFlag: boolean;
  includeTrace: boolean;
  chainedFlag: boolean;
  outPath: string | null;
  suite: "default" | "realistic";
  screeningLocal: boolean;
  screeningGroq: boolean;
}

function handleHistoryCommand(args: string[]): boolean {
  if (!args.includes("--history")) return false; // not a history command, continue
  const historyIndexIdx = args.indexOf("--history-index");
  if (historyIndexIdx !== -1 && !args[historyIndexIdx + 1]) {
    console.error("Error: --history-index requires a path.");
    process.exit(1);
  }
  const indexPath = historyIndexIdx !== -1
    ? path.resolve(args[historyIndexIdx + 1])
    : path.join(lynxRoot(), "benchmarks", "results", "_index.jsonl");
  const history = readAgentABIndex(indexPath);
  const aggregate = aggregateAgentABHistory(history.included);
  console.log(JSON.stringify({
    index_path: indexPath,
    index_exists: fs.existsSync(indexPath),
    hygiene: {
      total_lines: history.total_lines,
      included_count: history.included_count,
      excluded_count: history.excluded_count,
      excluded_by_reason: history.excluded_by_reason,
    },
    aggregate,
  }, null, 2));
  return true; // handled: caller should return
}

function parseAgentABCliArgs(args: string[]): ParsedCliArgs {
  const flag = (name: string) => args.includes(name);
  const val = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const screeningGroq = flag("--screening-groq");
  const screeningLocal = flag("--screening-local");
  if (screeningGroq && screeningLocal) {
    throw new Error("Use only one screening provider: --screening-groq or --screening-local.");
  }
  const isScreening = screeningGroq || screeningLocal;
  const localBaseUrl = val("--local-base-url") || "http://127.0.0.1:8011/v1";

  if (flag("--html")) {
    console.error("Error: --html is not yet implemented.");
    process.exit(1);
  }

  return {
    screeningLocal,
    screeningGroq,
    config: {
      tier: isScreening ? "screening" : "official",
      seed: parseInt(val("--seed") || "42", 10) || 42,
      measuredRounds: Math.max(1, parseInt(val("--rounds") || "1", 10) || 1),
      warmupRounds: Math.max(0, parseInt(val("--warmup") || "0", 10) || 0),
      model: val("--model")
        || (screeningLocal ? "mlx-community/Qwen3.6-35B-A3B-4bit"
          : screeningGroq ? "meta-llama/llama-4-scout-17b-16e-instruct"
          : AGENT_AB_DEFAULT_MODEL),
      ...(screeningLocal
        ? { baseUrl: localBaseUrl, apiKey: "local-no-auth" }
        : screeningGroq
        ? { baseUrl: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY || "" }
        : {}),
      taskIds: val("--tasks")?.split(",").map(t => t.trim()).filter(Boolean),
      projectDir: val("--project-dir"),
      dryRun: flag("--dry-run"),
    },
    jsonFlag: flag("--json"),
    csvFlag: flag("--csv"),
    includeTrace: flag("--include-trace"),
    chainedFlag: flag("--chained"),
    outPath: val("--out") || null,
    suite: val("--suite") === "realistic" ? "realistic" : "default",
  };
}

// ── CLI entry ─────────────────────────────────────────────────

export async function cmdAgentABBenchmark(args: string[]): Promise<void> {
  if (handleHistoryCommand(args)) return;

  const { config, jsonFlag, csvFlag, includeTrace, chainedFlag, outPath, suite,
    screeningLocal, screeningGroq } = parseAgentABCliArgs(args);

  const isScreening = screeningLocal || screeningGroq;
  const hasKey = !!(config.apiKey || getApiKey());
  if (!hasKey && !config.dryRun) {
    console.error(
      screeningLocal
        ? "Local screening server is unavailable. Start it or set --local-base-url."
        : screeningGroq
        ? "No GROQ_API_KEY set. Running in dry-run mode (--dry-run implied)."
        : "No LYNX_DEEPSEEK_KEY or DEEPSEEK_API_KEY set. Running in dry-run mode (--dry-run implied).",
    );
    if (screeningLocal)
      console.error("Start the local OpenAI-compatible server before running screening.");
    else if (screeningGroq)
      console.error("Set GROQ_API_KEY to run experimental screening calls.");
    else
      console.error("Set LYNX_DEEPSEEK_KEY to run official DeepSeek calls.");
    config.dryRun = true;
  }

  const modeLabel = screeningLocal ? "SCREENING-LOCAL" : screeningGroq ? "SCREENING" : "OFFICIAL";
  console.error(
    `LYNX agent-ab ${modeLabel} benchmark — seed=${config.seed} rounds=${config.measuredRounds} model=${config.model} ${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  // ── Live progress state ───────────────────────────────────
  let pairCount = 0;
  let totalPairs = 0;
  let roundNum = 0;
  const lastPair: Map<string, AgentABRun> = new Map(); // task_id -> first condition run

  const checkpointPath =
    outPath && !csvFlag
      ? outPath.endsWith(".json")
        ? outPath + ".checkpoint"
        : outPath + ".json.checkpoint"
      : undefined;

  const flush = (msg: string) => {
    process.stderr.write(msg + "\n");
  };

  const result = await runAgentABBenchmark(config, {
    includeTrace,
    chained: chainedFlag,
    checkpointPath,
    suite,
    onProgress: (evt) => {
      const r = evt.run;
      const statusTag = r.not_executed
        ? "DRY"
        : !r.evaluation_eligible
          ? "DESIGNED"
          : r.correct
            ? "PASS"
            : "FAIL";
      const toolsTag = r.metrics.tool_call_count;

      // Per-run line
      const roundForRun =
        Math.floor((evt.current - 1) / (evt.total / config.measuredRounds!)) +
        1;
      flush(
        `[${String(evt.current).padStart(3)}/${evt.total}] round=${roundForRun}/${config.measuredRounds} task=${r.task_id} condition=${r.condition} status=${statusTag} wall=${r.metrics.wall_time_ms}ms tools=${toolsTag} tokens=${r.metrics.input_tokens + r.metrics.output_tokens} cost=$${r.metrics.cost_usd.toFixed(6)}`,
      );

      // Pair summary
      const pairKey = `${r.task_id}_r${roundForRun}`;
      const mate = lastPair.get(pairKey);
      if (!mate) {
        lastPair.set(pairKey, r);
        totalPairs = Math.max(totalPairs, lastPair.size);
      } else {
        // Both conditions done for this task×round
        lastPair.delete(pairKey);
        pairCount++;
        const lynxRun = r.condition === "with_lynx" ? r : mate;
        const baselineRun = r.condition === "without_lynx" ? r : mate;
        const statusFor = (run: AgentABRun) =>
          run.not_executed
            ? "DRY"
            : !run.evaluation_eligible
              ? "DESIGNED"
              : run.correct
                ? "PASS"
                : "FAIL";
        const lynxOk = statusFor(lynxRun);
        const baselineOk = statusFor(baselineRun);
        const wallDelta =
          baselineRun.metrics.wall_time_ms > 0
            ? (
                ((lynxRun.metrics.wall_time_ms -
                  baselineRun.metrics.wall_time_ms) /
                  baselineRun.metrics.wall_time_ms) *
                100
              ).toFixed(0)
            : "0";
        const deltaSign = Number(wallDelta) <= 0 ? "" : "+";
        flush(
          `  [pair ${pairCount}] ${r.task_id}: LYNX ${lynxRun.metrics.wall_time_ms}ms ${lynxOk} vs baseline ${baselineRun.metrics.wall_time_ms}ms ${baselineOk} | delta=${deltaSign}${wallDelta}%`,
        );
      }

      // Round completion summary
      if (pairCount === totalPairs && lastPair.size === 0 && totalPairs > 0) {
        roundNum++;
        const wRuns = evt.allRuns.filter((x) => x.condition === "with_lynx");
        const woRuns = evt.allRuns.filter(
          (x) => x.condition === "without_lynx",
        );
        if (wRuns.length > 0 && woRuns.length > 0) {
          const wOk = wRuns.filter((x) => x.correct || x.not_executed).length;
          const woOk = woRuns.filter((x) => x.correct || x.not_executed).length;
          const wCost = wRuns.reduce((s, x) => s + x.metrics.cost_usd, 0);
          const woCost = woRuns.reduce((s, x) => s + x.metrics.cost_usd, 0);
          const wWall = wRuns
            .map((x) => x.metrics.wall_time_ms)
            .sort((a, b) => a - b);
          const woWall = woRuns
            .map((x) => x.metrics.wall_time_ms)
            .sort((a, b) => a - b);
          const medW = wWall[Math.floor(wWall.length / 2)];
          const medWo = woWall[Math.floor(woWall.length / 2)];
          flush(
            `[round ${roundNum}/${config.measuredRounds} complete] LYNX: ${wOk}/${wRuns.length} ok median=${medW}ms cost=$${wCost.toFixed(6)} | baseline: ${woOk}/${woRuns.length} ok median=${medWo}ms cost=$${woCost.toFixed(6)}`,
          );
        }
        totalPairs = 0;
      }
    },
  });

  const noFormatFlag = !jsonFlag && !csvFlag;

  if (csvFlag) {
    const content = agentResultToCSV(result);
    if (outPath) {
      const filePath = outPath.endsWith(".csv") ? outPath : `${outPath}.csv`;
      fs.writeFileSync(filePath, content);
      console.error(`Wrote ${filePath}`);
    } else {
      console.log(content);
    }
  }

  if (jsonFlag || noFormatFlag) {
    const content = agentResultToJSON(result, includeTrace);
    if (outPath && !csvFlag) {
      const filePath = outPath.endsWith(".json") ? outPath : `${outPath}.json`;
      fs.writeFileSync(filePath, content);
      // Remove checkpoint on clean finish
      if (checkpointPath) {
        try {
          fs.rmSync(checkpointPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      console.error(`Wrote ${filePath}`);
    } else if (!csvFlag) {
      console.log(content);
    }
  }

  const s = result.summary;
  if (result.tasks.every((r) => r.not_executed)) {
    console.error("\nAll runs: not_executed (dry-run)");
  } else {
    console.error(
      `\nWith LYNX:    ${s.with_lynx.wall_time_ms.median}ms median, ${(s.with_lynx.functional_success_rate * 100).toFixed(0)}% success`,
    );
    console.error(
      `Without LYNX: ${s.without_lynx.wall_time_ms.median}ms median, ${(s.without_lynx.functional_success_rate * 100).toFixed(0)}% success`,
    );
  }
  if (s.roi_blocked) {
    console.error(`ROI: BLOCKED — ${s.roi_blocked_reason}`);
  }

  for (const w of result.warnings) {
    console.error(`WARNING: ${w}`);
  }

  // Auto-save to benchmarks/results/ regardless of --out
  if (!config.dryRun) {
    try {
      autoSaveResult(result, outPath, null);
    } catch (err) {
      console.error(`Auto-save failed: ${String(err)}`);
    }
  }
}
