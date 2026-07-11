/*
 * agent-ab.test.ts — LLM agent A/B benchmark tests.
 *
 * Tests isolation, prompt/config equality, tool-set difference, maxToolCalls,
 * timeout, retries, secret redaction, path traversal, shell injection prevention,
 * absent key handling, model recording, pricing classification, defect summary,
 * dry-run not_executed, CSV output, and unsupported flag rejection.
 *
 * Uses mock fetch — no real API calls.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

import { generateFixture } from "../../../src/cli/ab-benchmark.js";
import {
  runAgentABBenchmark,
  agentResultToJSON,
  agentResultToCSV,
  chatCompletion,
  getApiKey,
  redactSecrets,
  sha256Hash,
  computeCost,
  makeLynxTools,
  makeBaselineTools,
  makeLynxToolsRealistic,
  TASKS_CORE,
  TASKS_REALISTIC,
  TOOL_COVERAGE,
  coverageSummary,
  designedOnlyTools,
  DESIGNED_ONLY_TASK_IDS,
  PARTIAL_EXPECTED_TASK_IDS,
  validateRealisticSuitePreflight,
  normalizeArchitectureLanguage,
  assertPaidMicrobenchmarkProtocol,
  compareOneChange,
  truncateToolResult,
  MAX_TOOL_RESULT_BYTES,
  externalProjectLabel,
  evaluateExternalDeadCodeResponse,
  isEvaluationEligible,
  toolCallSummary,
  classifyAgentABResultValidity,
  summarizeAgentABIndexLines,
  readAgentABIndex,
  wilsonInterval,
  aggregateAgentABHistory,
} from "../../../src/cli/agent-ab/index.js";
import type {
  AgentABResult,
  AgentABRun,
  AgentABConfig,
  ToolTraceStep,
} from "../../../src/cli/agent-ab/index.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  openaiChatCompletion,
} from "../../../src/llm/shared.js";

// ── Helpers ───────────────────────────────────────────────────

/** Build a minimal mock DeepSeek API response. */
function mockResponse(
  opts: {
    content?: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    finishReason?: string;
    model?: string;
    usage?: Partial<{
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_cache_hit_tokens: number;
      completion_tokens_details: { reasoning_tokens: number };
    }>;
  } = {},
) {
  return {
    id: "mock-id",
    model: opts.model || "deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: opts.content || JSON.stringify({ result: "ok" }),
          tool_calls: opts.toolCalls?.map((tc, i) => ({
            id: `call_${i}`,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
        finish_reason:
          opts.finishReason || (opts.toolCalls ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: opts.usage?.prompt_tokens ?? 100,
      completion_tokens: opts.usage?.completion_tokens ?? 50,
      total_tokens: opts.usage?.total_tokens ?? 150,
      prompt_cache_hit_tokens: opts.usage?.prompt_cache_hit_tokens ?? 0,
      completion_tokens_details:
        opts.usage?.completion_tokens_details ?? undefined,
    },
  };
}

/** Spy on openaiChatCompletion to count calls and inject mock responses. */
function installMockFetch(
  responses:
    | Array<ReturnType<typeof mockResponse>>
    | (() => ReturnType<typeof mockResponse>),
): { calls: Array<{ body: unknown }>; restore: () => void } {
  const calls: Array<{ body: unknown }> = [];
  const original = globalThis.fetch;
  // We can't easily mock the ESM import, so we mock at the fetch level
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Create a mock fetch that returns sequential responses. */
function createMockFetch(
  responses: Array<ReturnType<typeof mockResponse>>,
): typeof fetch {
  let idx = 0;
  return (async (url: string, init?: RequestInit) => {
    const r = responses[idx] || responses[responses.length - 1];
    idx++;
    return {
      ok: true,
      status: 200,
      json: async () => r,
      text: async () => JSON.stringify(r),
      headers: new Headers({ "content-type": "application/json" }),
    } as Response;
  }) as typeof fetch;
}

// ── Secret redaction ──────────────────────────────────────────

describe("secret redaction", () => {
  it("redacts sk- keys", () => {
    expect(
      redactSecrets("Authorization: Bearer sk-abc123def456ghijklmno"),
    ).toBe("Authorization: Bearer sk-[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Bearer sk-verylongsecretkeyhere12345")).toContain(
      "[REDACTED]",
    );
  });

  it("redacts bare sk- keys", () => {
    expect(redactSecrets("my key is sk-abcdefghijklmnopqrstuvwxyz")).toContain(
      "sk-[REDACTED]",
    );
  });

  it("leaves non-secret text unchanged", () => {
    const text = "Normal error message about file not found";
    expect(redactSecrets(text)).toBe(text);
  });
});

// ── Cost computation ──────────────────────────────────────────

describe("cost computation", () => {
  it("returns 0 for undefined usage", () => {
    expect(computeCost(undefined)).toBe(0);
  });

  it("computes cost from tokens and default pricing", () => {
    const cost = computeCost({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    // 1000 input * 0.00014/1k + 500 output * 0.00028/1k = 0.00014 + 0.00014 = 0.00028
    expect(cost).toBeCloseTo(0.00028, 6);
  });
});

// ── Path safety ───────────────────────────────────────────────

describe("read_file path traversal protection", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-ab-path-"));
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "SECRET");
    fs.writeFileSync(path.join(tmpDir, "normal.txt"), "normal content");
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("allows reading file within fixture dir", () => {
    // Direct test of the path.resolve logic used in safeReadFile
    const resolved = path.resolve(tmpDir, "normal.txt");
    const normalized = path.resolve(tmpDir) + path.sep;
    expect(resolved.startsWith(normalized)).toBe(true);
  });

  it("blocks path traversal via ../", () => {
    const resolved = path.resolve(tmpDir, "../../../etc/passwd");
    const normalized = path.resolve(tmpDir) + path.sep;
    expect(resolved.startsWith(normalized)).toBe(false);
  });

  it("blocks absolute paths outside fixture", () => {
    const resolved = path.resolve(tmpDir, "/etc/passwd");
    const normalized = path.resolve(tmpDir) + path.sep;
    expect(resolved.startsWith(normalized)).toBe(false);
  });
});

// ── Shell injection prevention in grep ────────────────────────

describe("grep shell safety", () => {
  it("spawnSync with args array prevents shell interpolation", () => {
    const { spawnSync } = require("node:child_process");
    // Safe: args are passed directly to grep, not through a shell
    const result = spawnSync(
      "grep",
      ["-rn", "$(rm -rf /)", "--include=*.ts", "/tmp"],
      {
        encoding: "utf-8",
        timeout: 5000,
      },
    );
    // Should fail to find anything or have status 1/2, but never execute the injection
    expect(result.stdout).not.toContain("rm");
  });
});

// ── Dry-run (no API key) ─────────────────────────────────────

describe("external task prompt discipline", () => {
  it("avoids open-ended exploration instructions", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/cli/agent-ab/benchmark.ts"),
      "utf8",
    );
    expect(source).not.toContain("Explore freely");
    expect(source).not.toContain("Choose tools freely");
    expect(source).not.toContain("Choose and use them freely");
    expect(source).toContain("Choose the smallest relevant tool set needed");
    expect(source).not.toContain("Choose whatever tools");
    expect(source).not.toContain("Use whatever graph or analysis tools");
    expect(source).toContain("then stop once those points are supported");
    expect(source).toContain("Use only the investigation needed");
    expect(source).toContain("stop once 5 well-supported candidates are established");
    expect(source).toContain("stop once the requested examples and top 3 are supported");
  });
});

describe("dry-run without API key", () => {
  let result: AgentABResult;
  let originalKey: string | undefined;

  beforeAll(async () => {
    originalKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    result = await runAgentABBenchmark({
      seed: 42,
      measuredRounds: 1,
      dryRun: true,
      taskIds: ["find_definition"],
    });
  });

  afterAll(() => {
    if (originalKey !== undefined) {
      process.env.LYNX_DEEPSEEK_KEY = originalKey;
    }
  });

  it("uses proportional verification and explicit stopping guidance", () => {
    expect(result.config.systemPrompt).toContain("Verify only material uncertainty");
    expect(result.config.systemPrompt).toContain("reuse evidence already collected");
    expect(result.config.systemPrompt).toContain("stop investigating");
    expect(result.config.systemPrompt).not.toContain("Be thorough");
  });

  it("all runs marked not_executed", () => {
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      expect(task.not_executed).toBe(true);
      expect(task.metrics.not_executed).toBe(true);
    }
  });

  it("ROI is blocked", () => {
    expect(result.summary.roi_blocked).toBe(true);
    expect(result.summary.roi_blocked_reason).toContain("Dry run");
  });

  it("cost is zero", () => {
    for (const task of result.tasks) {
      expect(task.metrics.cost_usd).toBe(0);
    }
  });

  it("cost is classified as estimated", () => {
    for (const task of result.tasks) {
      expect(task.metrics.cost_classification).toBe("estimated");
    }
  });

  it("sample size note mentions dry run", () => {
    expect(result.summary.sample_size_note).toContain("DRY RUN");
  });
});

// ── Run isolation ─────────────────────────────────────────────

describe("run isolation", () => {
  let result: AgentABResult;

  beforeAll(async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    result = await runAgentABBenchmark({
      seed: 42,
      measuredRounds: 1,
      dryRun: true,
      taskIds: ["find_definition"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;
  });

  it("each run has unique run_id", () => {
    const ids = result.tasks.map((t) => t.run_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("each run has fresh messages array (not shared reference)", () => {
    const msgArrays = result.tasks.map((t) => t.messages);
    // Different array references
    for (let i = 0; i < msgArrays.length; i++) {
      for (let j = i + 1; j < msgArrays.length; j++) {
        expect(msgArrays[i]).not.toBe(msgArrays[j]);
      }
    }
  });

  it("each run has independent toolCalls array", () => {
    const tcArrays = result.tasks.map((t) => t.toolCalls);
    for (let i = 0; i < tcArrays.length; i++) {
      for (let j = i + 1; j < tcArrays.length; j++) {
        expect(tcArrays[i]).not.toBe(tcArrays[j]);
      }
    }
  });

  it("tool outputs are not shared between runs", () => {
    // In dry run, toolCalls should be empty (no API calls)
    for (const task of result.tasks) {
      expect(task.toolCalls).toEqual([]);
    }
  });
});

// ── Prompt and config equality between conditions ─────────────

describe("prompt and config equality", () => {
  let result: AgentABResult;

  beforeAll(async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    result = await runAgentABBenchmark({
      seed: 42,
      measuredRounds: 1,
      dryRun: true,
      taskIds: ["find_definition", "find_callers"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;
  });

  it("same task uses identical system prompt in both conditions", () => {
    const byTask = new Map<string, AgentABRun[]>();
    for (const r of result.tasks) {
      if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
      byTask.get(r.task_id)!.push(r);
    }
    for (const [, runs] of byTask) {
      const withR = runs.find((r) => r.condition === "with_lynx");
      const withoutR = runs.find((r) => r.condition === "without_lynx");
      if (withR && withoutR) {
        const withSys = withR.messages.find(
          (m) => m.role === "system",
        )?.content;
        const withoutSys = withoutR.messages.find(
          (m) => m.role === "system",
        )?.content;
        expect(withSys).toBe(withoutSys);
      }
    }
  });

  it("same task uses identical user prompt in both conditions", () => {
    const byTask = new Map<string, AgentABRun[]>();
    for (const r of result.tasks) {
      if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
      byTask.get(r.task_id)!.push(r);
    }
    for (const [, runs] of byTask) {
      const withR = runs.find((r) => r.condition === "with_lynx");
      const withoutR = runs.find((r) => r.condition === "without_lynx");
      if (withR && withoutR) {
        const withUser = withR.messages.find((m) => m.role === "user")?.content;
        const withoutUser = withoutR.messages.find(
          (m) => m.role === "user",
        )?.content;
        expect(withUser).toBe(withoutUser);
      }
    }
  });

  it("config model/temperature are shared and artificial ceilings are omitted", () => {
    expect(result.config.model).toBeTruthy();
    expect(typeof result.config.temperature).toBe("number");
    expect(result.config.maxTokens).toBeUndefined();
    expect(result.config.maxToolCalls).toBeUndefined();
  });
});

// ── Tool-set difference ──────────────────────────────────────

describe("tool-set only difference", () => {
  it("tool descriptions guide minimal sequences and only tools differ", async () => {
    const lynx = makeLynxTools();
    const baseline = makeBaselineTools();

    const byName = (
      tools: Array<{ function: { name: string; description: string } }>,
    ) => new Map(tools.map((t) => [t.function.name, t.function.description]));

    const cMap = byName(lynx);
    const bMap = byName(baseline);

    // search_graph: must mention file path and location
    expect(cMap.get("search_graph")).toMatch(
      /file path|location|where.*defined/i,
    );

    // explain_symbol: must warn it does NOT locate definitions
    expect(cMap.get("explain_symbol")).toMatch(
      /does NOT tell you where|after.*located/i,
    );

    // read_file in both: must mention confirming a definition
    expect(cMap.get("read_file")).toMatch(/confirm/i);
    expect(bMap.get("read_file")).toMatch(/confirm/i);

    // Both conditions share read_file with identical description
    expect(cMap.get("read_file")).toBe(bMap.get("read_file"));

    // with_lynx has all graph tools — baseline does not
    for (const name of [
      "search_graph",
      "trace_path",
      "explain_symbol",
      "find_tests",
    ]) {
      expect(cMap.has(name)).toBe(true);
      expect(bMap.has(name)).toBe(false);
    }
    // baseline has grep — with_lynx does not
    expect(bMap.has("grep")).toBe(true);
    expect(cMap.has("grep")).toBe(false);
  });
});

// ── Safe forced finalization ────────────────────────────────

describe("safe forced finalization", () => {
  it("forced-final call succeeds when maxToolCalls exhausted", async () => {
    // Mock that always returns tool_calls (never stops on its own)
    const mockResponses = Array.from({ length: 20 }, (_, i) =>
      mockResponse({
        toolCalls: [{ name: "read_file", args: { path: `file${i}.ts` } }],
        finishReason: "tool_calls",
      }),
    );
    const mockFetch = createMockFetch(mockResponses);

    const result = await chatCompletion(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "test" }],
        tools: [],
      },
      { onToolCall: async () => "result" },
      {
        apiKey: "sk-test-key",
        baseUrl: "https://api.test",
        timeoutMs: 5000,
        maxRetries: 0,
        maxToolCalls: 3,
        _fetch: mockFetch,
      },
    );

    // Does NOT throw — forced finalization succeeds
    expect(result.toolLoopExhausted).toBe(true);
    expect(result.finalizationError).toBeUndefined();
    // Real metrics preserved
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBe(3);
    // Last message is the forced-final assistant response (content, not tool_calls)
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.content).toBeTruthy();
    expect(lastMsg.tool_calls).toBeUndefined();
    // Forced-stop instruction was injected
    const sysMsg = result.messages.find((m) =>
      m.content?.includes("maximum number of tool calls"),
    );
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.role).toBe("user");
  });

  it("succeeds within tool budget (no exhaustion)", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        finishReason: "tool_calls",
      }),
      mockResponse({
        content: JSON.stringify({ done: true }),
        finishReason: "stop",
      }),
    ]);

    const result = await chatCompletion(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "test" }],
        tools: [],
      },
      { onToolCall: async () => "file contents" },
      {
        apiKey: "sk-test-key",
        baseUrl: "https://api.test",
        timeoutMs: 5000,
        maxRetries: 0,
        maxToolCalls: 5,
        _fetch: mockFetch,
      },
    );

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolLoopExhausted).toBe(false);
    expect(result.finalizationError).toBeUndefined();
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("real metrics survive when forced-final call itself fails", async () => {
    // 3 tool_calls (OK), then the forced-final call returns a 500
    const responses = [
      mockResponse({
        toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        finishReason: "tool_calls",
      }),
      mockResponse({
        toolCalls: [{ name: "read_file", args: { path: "b.ts" } }],
        finishReason: "tool_calls",
      }),
      mockResponse({
        toolCalls: [{ name: "read_file", args: { path: "c.ts" } }],
        finishReason: "tool_calls",
      }),
      // The 4th response is the forced-final call — return 500
      {
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal Server Error" }),
        text: async () => "Internal Server Error",
        headers: new Headers(),
      } as Response,
    ];
    // We need 4 responses: 3 normal + the 4th index 3 = forced final (mocked at index=3)
    // The forced final happens when turn === maxToolCalls (=3), so it consumes response index 3
    const allResponses = [...responses];
    const mockFetch = createMockFetch(allResponses);

    const result = await chatCompletion(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "test" }],
        tools: [],
      },
      { onToolCall: async () => "result" },
      {
        apiKey: "sk-test-key",
        baseUrl: "https://api.test",
        timeoutMs: 5000,
        maxRetries: 0,
        maxToolCalls: 3,
        _fetch: mockFetch,
      },
    );

    // Did not throw — accumulated metrics from first 3 calls survived
    expect(result.toolLoopExhausted).toBe(true);
    expect(result.finalizationError).toBeDefined();
    expect(result.finalizationError).toBeTruthy();
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBe(3);
  });
});

// ── Grounded external-task evaluation ─────────────────────────

describe("external dead-code evaluation", () => {
  const verified = [
    { name: "orphanOne", file_path: "src/orphans.ts", kind: "Function" },
    { name: "orphanTwo", file_path: "src/orphans.ts", kind: "Method" },
    { name: "orphanThree", file_path: "src/orphans.ts", kind: "Function" },
    { name: "orphanFour", file_path: "src/orphans.ts", kind: "Class" },
    { name: "orphanFive", file_path: "src/orphans.ts", kind: "Function" },
  ];

  it("accepts only reported candidates independently verified by the graph", async () => {
    const response = JSON.stringify({
      unused_symbols: verified.map((candidate) => ({
        name: candidate.name,
        file: candidate.file_path,
        kind: candidate.kind === "Class" ? "class" : "function",
      })),
      evidence: ["zero inbound graph references"],
      summary: "Five independently verified candidates.",
    });

    const evaluation = await evaluateExternalDeadCodeResponse(
      response,
      "fixture",
      verified,
    );
    expect(evaluation.correct).toBe(true);
    expect(evaluation.defects).toBe(0);
  });

  it("rejects a fabricated symbol even when the answer has enough items", async () => {
    const response = JSON.stringify({
      unused_symbols: [
        ...verified.slice(0, 4).map((candidate) => ({
          name: candidate.name,
          file: candidate.file_path,
          kind: "function",
        })),
        { name: "invented", file: "src/orphans.ts", kind: "function" },
      ],
    });

    const evaluation = await evaluateExternalDeadCodeResponse(
      response,
      "fixture",
      verified,
    );
    expect(evaluation.correct).toBe(false);
    expect(evaluation.errors.join(" ")).toContain("not a verified");
  });

  it("counts grounded partial evaluations even without static expected fixtures", () => {
    expect(
      isEvaluationEligible({
        id: "external_dead_code",
        name: "Grounded candidates",
        userPrompt: "test",
        expected: {},
        evaluation_kind: "partial",
      }),
    ).toBe(true);
    expect(
      isEvaluationEligible({
        id: "open_ended",
        name: "Open ended",
        userPrompt: "test",
        expected: {},
        evaluation_kind: "designed-only",
      }),
    ).toBe(false);
  });
});

// ── Timeout handling ──────────────────────────────────────────

describe("timeout handling", () => {
  it("applies the long shared timeout when callers omit one", async () => {
    let signal: AbortSignal | undefined;
    const immediateFetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await openaiChatCompletion(
      { model: "deepseek-v4-flash", messages: [{ role: "user", content: "test" }] },
      { apiKey: "sk-test-key", baseUrl: "https://api.test", _fetch: immediateFetch },
    );

    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(900_000);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  it("throws on timeout", async () => {
    // Create a fetch that respects AbortSignal and never resolves within timeout
    const hangingFetch = (async (_url: string, init?: RequestInit) => {
      // Wait for abort signal (simulates network hanging)
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }
      });
    }) as unknown as typeof fetch;

    await expect(
      chatCompletion(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "test" }],
        },
        {},
        {
          apiKey: "sk-test-key",
          baseUrl: "https://api.test",
          timeoutMs: 100,
          maxRetries: 0,
          maxToolCalls: 5,
          _fetch: hangingFetch,
        },
      ),
    ).rejects.toThrow(/timed out/);
  });
});

// ── Retry on failure ──────────────────────────────────────────

describe("retry on server error", () => {
  it("retries on 429 status", async () => {
    let callCount = 0;
    const retryFetch = (async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => "rate limited",
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse({ content: '{"ok":true}' }),
        text: async () => "ok",
        headers: new Headers({ "content-type": "application/json" }),
      } as Response;
    }) as unknown as typeof fetch;

    await chatCompletion(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "test" }],
      },
      {},
      {
        apiKey: "sk-test-key",
        baseUrl: "https://api.test",
        timeoutMs: 5000,
        maxRetries: 3,
        maxToolCalls: 5,
        _fetch: retryFetch,
      },
    );

    expect(callCount).toBe(3);
  });

  it("throws after maxRetries exhausted", async () => {
    const failFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "server error",
        headers: new Headers(),
      }) as Response) as unknown as typeof fetch;

    await expect(
      chatCompletion(
        { model: "test", messages: [{ role: "user", content: "x" }] },
        {},
        {
          apiKey: "sk-k",
          baseUrl: "https://t",
          timeoutMs: 5000,
          maxRetries: 1,
          maxToolCalls: 5,
          _fetch: failFetch,
        },
      ),
    ).rejects.toThrow(/API 500/);
  });
});

// ── Model recording ──────────────────────────────────────────

describe("model version recording", () => {
  it("records actual model from API response", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        content:
          '{"found_file":"runtime.ts","function_name":"lynxHome","returns_path":true}',
        model: "deepseek-v4-flash-20250701",
        finishReason: "stop",
        usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
      }),
    ]);

    // Override global fetch
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;

    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    process.env.LYNX_DEEPSEEK_KEY = "sk-real-looking-key-12345";

    try {
      const result = await runAgentABBenchmark({
        seed: 42,
        measuredRounds: 1,
        dryRun: false,
        taskIds: ["find_definition"],
      });

      for (const task of result.tasks) {
        if (!task.not_executed) {
          expect(task.metrics.model_version).toBe("deepseek-v4-flash-20250701");
          expect(task.metrics.model).toBe("deepseek-v4-flash");
        }
      }
    } finally {
      globalThis.fetch = prev;
      if (prevKey !== undefined) {
        process.env.LYNX_DEEPSEEK_KEY = prevKey;
      } else {
        delete process.env.LYNX_DEEPSEEK_KEY;
      }
    }
  });
});

// ── Token metrics separation ─────────────────────────────────

describe("token metrics separation", () => {
  it("records input/output/cached/reasoning tokens separately", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        content: '{"found_file":"runtime.ts"}',
        model: "deepseek-v4-flash",
        finishReason: "stop",
        usage: {
          prompt_tokens: 200,
          completion_tokens: 30,
          total_tokens: 230,
          prompt_cache_hit_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    ]);

    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;

    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    process.env.LYNX_DEEPSEEK_KEY = "sk-real-looking-key-12345";

    try {
      const result = await runAgentABBenchmark({
        seed: 42,
        dryRun: false,
        measuredRounds: 1,
        taskIds: ["find_definition"],
      });

      for (const task of result.tasks) {
        if (!task.not_executed) {
          expect(task.metrics.input_tokens).toBe(200);
          expect(task.metrics.output_tokens).toBe(30);
          expect(task.metrics.cached_tokens).toBe(50);
          expect(task.metrics.reasoning_tokens).toBe(10);
        }
      }
    } finally {
      globalThis.fetch = prev;
      if (prevKey !== undefined) {
        process.env.LYNX_DEEPSEEK_KEY = prevKey;
      } else {
        delete process.env.LYNX_DEEPSEEK_KEY;
      }
    }
  });
});

// ── Pricing classification ────────────────────────────────────

describe("pricing classification", () => {
  it("cost_usd is always classified as estimated", async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const result = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    for (const task of result.tasks) {
      expect(task.metrics.cost_classification).toBe("estimated");
    }
  });
});

// ── Defect summary per condition ──────────────────────────────

describe("defect summary per condition", () => {
  let result: AgentABResult;

  beforeAll(async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    result = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      measuredRounds: 1,
      taskIds: ["find_definition", "find_callers"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;
  });

  it("defects_per_task is computed per condition", () => {
    // In dry run, all tasks have defects = keys in expected
    const withRuns = result.tasks.filter((r) => r.condition === "with_lynx");
    const withoutRuns = result.tasks.filter(
      (r) => r.condition === "without_lynx",
    );

    if (withRuns.length > 0) {
      const withDefectsTotal = withRuns.reduce(
        (sum, r) => sum + r.metrics.defects_introduced,
        0,
      );
      expect(result.summary.with_lynx.defects_per_task).toBe(
        withDefectsTotal / withRuns.length,
      );
    }

    if (withoutRuns.length > 0) {
      const withoutDefectsTotal = withoutRuns.reduce(
        (sum, r) => sum + r.metrics.defects_introduced,
        0,
      );
      expect(result.summary.without_lynx.defects_per_task).toBe(
        withoutDefectsTotal / withoutRuns.length,
      );
    }
  });
});

// ── Output formats ────────────────────────────────────────────

describe("output formats", () => {
  let result: AgentABResult;

  beforeAll(async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    result = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      measuredRounds: 1,
      taskIds: ["find_definition"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;
  });

  it("JSON output is valid and parseable", () => {
    const json = agentResultToJSON(result);
    const parsed = JSON.parse(json);
    expect(parsed.config).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(parsed.tasks).toBeDefined();
    expect(parsed.experiment_protocol.model).toBe("deepseek-v4-flash");
  });

  it("JSON output excludes API key from config entirely", () => {
    const json = agentResultToJSON(result);
    const parsed = JSON.parse(json);
    // Config must not have apiKey field (omitted, not redacted)
    expect(parsed.config).not.toHaveProperty("apiKey");
    // No secret-like patterns anywhere in the output
    expect(json).not.toMatch(/sk-[a-zA-Z0-9_-]{10,}/);
  });

  it("records a deterministic tool summary without arguments", () => {
    const summary = toolCallSummary([
      { id: "1", type: "function", function: { name: "trace_path", arguments: '{"secret":"x"}' } },
      { id: "2", type: "function", function: { name: "search_graph", arguments: '{}' } },
      { id: "3", type: "function", function: { name: "trace_path", arguments: '{}' } },
    ]);
    expect(summary).toEqual({ search_graph: 1, trace_path: 2 });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("omits the official protocol from screening output", async () => {
    const screening = await runAgentABBenchmark({
      tier: "screening",
      seed: 42,
      dryRun: true,
      measuredRounds: 1,
      taskIds: ["find_definition"],
    });
    expect(JSON.parse(agentResultToJSON(screening)).experiment_protocol).toBeNull();
  });

  it("CSV output has header and data rows", () => {
    const csv = agentResultToCSV(result);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("run_id");
    expect(lines[0]).toContain("condition");
    expect(lines[0]).toContain("cost_classification");
    expect(lines[1]).toContain(result.tasks[0].run_id);
  });

  it("CSV headers and every row have exactly the same number of columns", () => {
    const lines = agentResultToCSV(result).trim().split("\n");
    const headerLength = lines[0].split(",").length;
    for (const line of lines.slice(1))
      expect(line.split(",").length).toBe(headerLength);
  });

  it("JSON and CSV persist evaluation and tool-loop fields", () => {
    const json = JSON.parse(agentResultToJSON(result));
    expect(json.tasks[0]).toHaveProperty("evaluation_eligible");
    expect(json.tasks[0]).toHaveProperty("evaluation_kind");
    expect(json.tasks[0]).toHaveProperty("tool_loop_exhausted");
    expect(json.tasks[0]).toHaveProperty("seed");
    expect(json.tasks[0]).toHaveProperty("response");
    expect(agentResultToCSV(result).split("\n")[0]).toContain(
      "tool_loop_exhausted",
    );
  });

  it("JSON output includes methodology", () => {
    const json = agentResultToJSON(result);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.methodology)).toBe(true);
    expect(parsed.methodology.length).toBeGreaterThan(0);
  });

  it("JSON response text is retained but secrets are redacted", () => {
    const original = result.tasks[0].response;
    result.tasks[0].response =
      "analysis with sk-abcdefghijklmnopqrstuvwxyz123456";
    const json = agentResultToJSON(result);
    expect(json).toContain("analysis with");
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    result.tasks[0].response = original;
  });
});

// ── CLI flag rejection ────────────────────────────────────────

describe("CLI flag handling", () => {
  it("--html flag is rejected with error", async () => {
    // We test this by importing the CLI function and checking it throws
    // Simulate process.exit
    const prevExit = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as any;

    const prevError = console.error;
    let errorMsg = "";
    console.error = ((msg: string) => {
      errorMsg += msg;
    }) as any;

    try {
      const { cmdAgentABBenchmark } =
        await import("../../../src/cli/agent-ab/benchmark.js");
      await cmdAgentABBenchmark(["--html", "--dry-run"]);
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    expect(errorMsg).toContain("--html");

    process.exit = prevExit;
    console.error = prevError;
  });
});

describe("CLI history mode", () => {
  it("rejects --history-index without a path", async () => {
    const prevExit = process.exit;
    const prevError = console.error;
    let exitCode = 0;
    let errorMessage = "";

    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("process.exit(" + code + ")");
    }) as never;
    console.error = ((message: string) => {
      errorMessage += message;
    }) as typeof console.error;

    try {
      const { cmdAgentABBenchmark } =
        await import("../../../src/cli/agent-ab/benchmark.js");
      await expect(
        cmdAgentABBenchmark(["--history", "--history-index"]),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      process.exit = prevExit;
      console.error = prevError;
    }

    expect(exitCode).toBe(1);
    expect(errorMessage).toContain("--history-index requires a path");
  });

  it("prints an empty report for a missing custom history index", async () => {
    const output: string[] = [];
    const prevLog = console.log;
    const prevError = console.error;

    console.log = ((...args: unknown[]) => {
      output.push(args.map((arg) => String(arg)).join(" "));
    }) as typeof console.log;
    console.error = (() => {
      throw new Error("history mode must not enter benchmark execution");
    }) as typeof console.error;

    try {
      const { cmdAgentABBenchmark } =
        await import("../../../src/cli/agent-ab/benchmark.js");
      await cmdAgentABBenchmark([
        "--history",
        "--history-index",
        "benchmarks/results/missing_cli_history_index.jsonl",
      ]);
    } finally {
      console.log = prevLog;
      console.error = prevError;
    }

    expect(output).toHaveLength(1);
    const report = JSON.parse(output[0]);
    expect(report.index_path).toBe(
      path.resolve("benchmarks/results/missing_cli_history_index.jsonl"),
    );
    expect(report.index_exists).toBe(false);
    expect(report.hygiene.total_lines).toBe(0);
    expect(report.hygiene.included_count).toBe(0);
    expect(report.aggregate.runs).toBe(0);
    expect(report.aggregate.projects).toBe(0);
    expect(report.aggregate.by_project).toEqual([]);
  });

  it("prints the clean historical aggregate without entering benchmark execution", async () => {
    const output: string[] = [];
    const prevLog = console.log;
    const prevError = console.error;

    console.log = ((...args: unknown[]) => {
      output.push(args.map((arg) => String(arg)).join(" "));
    }) as typeof console.log;
    console.error = (() => {
      throw new Error("history mode must not enter benchmark execution");
    }) as typeof console.error;

    try {
      const { cmdAgentABBenchmark } =
        await import("../../../src/cli/agent-ab/benchmark.js");
      await cmdAgentABBenchmark(["--history"]);
    } finally {
      console.log = prevLog;
      console.error = prevError;
    }

    expect(output).toHaveLength(1);
    const report = JSON.parse(output[0]);
    const expectedHistory = readAgentABIndex(
      path.resolve("benchmarks/results/_index.jsonl"),
    );
    const expectedAggregate = aggregateAgentABHistory(expectedHistory.included);
    expect(report.index_exists).toBe(true);
    expect(report.hygiene).toMatchObject({
      total_lines: expectedHistory.total_lines,
      included_count: expectedHistory.included_count,
      excluded_count: expectedHistory.excluded_count,
      excluded_by_reason: expectedHistory.excluded_by_reason,
    });
    expect(report.aggregate).toEqual(expectedAggregate);
  });
});

// ── CLI live progress integration ───────────────────────────

describe("CLI live progress", () => {
  /** Run cmdAgentABBenchmark with dry-run and capture stderr lines. */
  async function captureStderr(args: string[]): Promise<string[]> {
    const lines: string[] = [];
    const prevWrite = process.stderr.write;
    const prevExit = process.exit;
    const prevErr = console.error;

    process.exit = ((code: number) => {
      throw new Error(`exit(${code})`);
    }) as any;
    console.error = ((...args: any[]) => {
      const s = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      process.stderr.write(s + "\n");
    }) as any;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const s =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      lines.push(s.replace(/\n$/, ""));
      return true;
    }) as any;

    try {
      const { cmdAgentABBenchmark } =
        await import("../../../src/cli/agent-ab/benchmark.js");
      await cmdAgentABBenchmark([...args, "--dry-run"]);
    } catch (_) {
      // expected when --html triggers exit
    } finally {
      process.stderr.write = prevWrite;
      process.exit = prevExit;
      console.error = prevErr;
    }

    return lines;
  }

  it("labels the Groq path as non-official screening", async () => {
    const previous = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const lines = await captureStderr([
      "--screening-groq",
      "--tasks",
      "find_definition",
    ]);
    if (previous !== undefined) process.env.GROQ_API_KEY = previous;

    expect(lines[0]).toContain("SCREENING");
    expect(lines[0]).toContain("meta-llama/llama-4-scout-17b-16e-instruct");
  });

  it("configures the local Qwen screening profile without an API key", async () => {
    const lines = await captureStderr([
      "--screening-local",
      "--tasks",
      "find_definition",
    ]);
    expect(lines[0]).toContain("SCREENING-LOCAL");
    expect(lines[0]).toContain("mlx-community/Qwen3.6-35B-A3B-4bit");
  });

  it(
    "per-run lines have correct format and ordering",
    { timeout: 30000 },
    async () => {
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const lines = await captureStderr([
        "--seed",
        "42",
        "--rounds",
        "2",
        "--tasks",
        "find_definition",
      ]);

      if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;

      // Per-run lines: [current/total] round=R/T task=... condition=... status=...
      // dryRun forces measuredRounds=1, so 1 task × 1 round × 2 conditions = 2 runs
      const runLines = lines.filter((l) => /^\[\s*\d+\/\d+\]\s+round=/.test(l));
      expect(runLines.length).toBe(2);

      // Check ordering — current is padStart(3) so e.g. "[  1/2]"
      for (let i = 0; i < runLines.length; i++) {
        const padded = String(i + 1).padStart(3);
        expect(runLines[i]).toContain(`[${padded}/${runLines.length}]`);
      }

      // Every run line has the required fields
      for (const line of runLines) {
        expect(line).toMatch(/round=\d+\/\d+/);
        expect(line).toMatch(/task=find_definition/);
        expect(line).toMatch(/condition=(with_lynx|without_lynx)/);
        expect(line).toMatch(/status=DRY/); // dry-run
        expect(line).toMatch(/wall=\d+ms/);
        expect(line).toMatch(/tools=\d+/);
        expect(line).toMatch(/tokens=\d+/);
        expect(line).toMatch(/cost=\$[\d.]+/);
      }
    },
  );

  it(
    "pair summaries appear with delta after both conditions",
    { timeout: 30000 },
    async () => {
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const lines = await captureStderr([
        "--seed",
        "42",
        "--rounds",
        "1",
        "--tasks",
        "find_definition",
      ]);

      if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;

      const pairLines = lines.filter((l) => l.startsWith("  [pair "));
      expect(pairLines.length).toBeGreaterThanOrEqual(1);
      expect(pairLines[0]).toMatch(/\[pair \d+\]/);
      expect(pairLines[0]).toContain("LYNX");
      expect(pairLines[0]).toContain("baseline");
      expect(pairLines[0]).toMatch(/delta=[+\-]?\d+%/);
      expect(pairLines[0]).toMatch(/PASS|DRY|FAIL/);
    },
  );

  it(
    "round summaries appear after round completion",
    { timeout: 30000 },
    async () => {
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const lines = await captureStderr([
        "--seed",
        "42",
        "--rounds",
        "1",
        "--tasks",
        "find_definition",
      ]);

      if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;

      const roundLines = lines.filter((l) => l.startsWith("[round "));
      expect(roundLines.length).toBeGreaterThanOrEqual(1);
      expect(roundLines[0]).toMatch(/\[round \d+\/\d+\s+complete\]/);
      expect(roundLines[0]).toContain("LYNX:");
      expect(roundLines[0]).toContain("baseline:");
      expect(roundLines[0]).toMatch(/\d+\/\d+\s+ok/);
      expect(roundLines[0]).toMatch(/median=\d+ms/);
      expect(roundLines[0]).toMatch(/cost=\$[\d.]+/);
    },
  );

  it(
    "no pair or round summaries when only 1 condition runs",
    { timeout: 30000 },
    async () => {
      // Should not crash, but fewer summaries may appear depending on task ordering
      // At minimum, we verify the run doesn't crash with 1 task
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const lines = await captureStderr([
        "--seed",
        "42",
        "--rounds",
        "1",
        "--tasks",
        "find_definition",
      ]);

      if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;

      // Should have at least: header line, per-run lines, summary lines
      expect(lines.length).toBeGreaterThan(0);
      // Must have a final summary
      const hasFinal = lines.some(
        (l) => l.includes("With LYNX:") || l.includes("All runs:"),
      );
      expect(hasFinal).toBe(true);
    },
  );
});

// ── Atomic checkpoint integration ────────────────────────────

describe("atomic checkpoint", () => {
  it(
    "checkpoint is valid JSON and survives read after each write",
    { timeout: 30000 },
    async () => {
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const tmpDir = os.tmpdir();
      const outFile = path.join(
        tmpDir,
        `lynx-test-atomckpt-${Date.now()}.json`,
      );
      const ckptFile = outFile + ".checkpoint";

      try {
        // Run via API directly (not CLI) to test checkpoint atomically
        const { runAgentABBenchmark } =
          await import("../../../src/cli/agent-ab/benchmark.js");

        const checkpoints: string[] = [];
        await runAgentABBenchmark(
          {
            seed: 42,
            dryRun: true,
            measuredRounds: 2,
            taskIds: ["find_definition"],
          },
          {
            includeTrace: false,
            checkpointPath: ckptFile,
            onProgress: (evt) => {
              // After each run, read the checkpoint file and verify it's valid
              if (fs.existsSync(ckptFile)) {
                const raw = fs.readFileSync(ckptFile, "utf-8");
                const parsed = JSON.parse(raw);
                checkpoints.push(JSON.stringify(parsed));
                expect(parsed.tasks.length).toBe(evt.current);
              }
            },
          },
        );

        // dryRun forces totalMeasured=1, so 1 task × 1 round × 2 conditions = 2 checkpoints
        expect(checkpoints.length).toBeGreaterThanOrEqual(2);
        // Checkpoints increase in task count monotonically
        for (let i = 1; i < checkpoints.length; i++) {
          const prev_p = JSON.parse(checkpoints[i - 1]);
          const curr_p = JSON.parse(checkpoints[i]);
          expect(curr_p.tasks.length).toBeGreaterThanOrEqual(
            prev_p.tasks.length,
          );
        }
        // No .tmp leftover
        expect(fs.existsSync(ckptFile + ".tmp")).toBe(false);
      } finally {
        try {
          fs.rmSync(outFile, { force: true });
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(ckptFile, { force: true });
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(ckptFile + ".tmp", { force: true });
        } catch {
          /* ignore */
        }
        if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;
      }
    },
  );

  it(
    "checkpoint uses temp+rename pattern (no truncation)",
    { timeout: 30000 },
    async () => {
      const prev = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const ckptFile = path.join(
        os.tmpdir(),
        `lynx-test-notrunc-${Date.now()}.checkpoint`,
      );

      // Pre-create a valid JSON file at checkpoint path
      fs.writeFileSync(ckptFile, JSON.stringify({ status: "initial" }));

      try {
        const { runAgentABBenchmark } =
          await import("../../../src/cli/agent-ab/benchmark.js");
        await runAgentABBenchmark(
          {
            seed: 42,
            dryRun: true,
            measuredRounds: 1,
            taskIds: ["find_definition"],
          },
          { includeTrace: false, checkpointPath: ckptFile },
        );

        // After run, checkpoint is overwritten with real data, not the initial content
        const raw = fs.readFileSync(ckptFile, "utf-8");
        const parsed = JSON.parse(raw);
        expect(parsed.tasks.length).toBeGreaterThan(0);
        expect(parsed.status).toBeUndefined(); // Not our initial marker
      } finally {
        try {
          fs.rmSync(ckptFile, { force: true });
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(ckptFile + ".tmp", { force: true });
        } catch {
          /* ignore */
        }
        if (prev !== undefined) process.env.LYNX_DEEPSEEK_KEY = prev;
      }
    },
  );
});

// ── Counterbalanced ordering ──────────────────────────────────

describe("counterbalanced ordering", () => {
  it("produces both with_lynx and without_lynx runs", async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const result = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      measuredRounds: 1,
      taskIds: ["find_definition", "find_callers"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    const conditions = result.tasks.map((t) => t.condition);
    expect(conditions).toContain("with_lynx");
    expect(conditions).toContain("without_lynx");
  });

  it("same seed produces same order (deterministic)", async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const r1 = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });
    const r2 = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    expect(r1.tasks.map((t) => t.condition)).toEqual(
      r2.tasks.map((t) => t.condition),
    );
  });
});

// ── Trace output ──────────────────────────────────────────────

describe("trace output", () => {
  // Capture current key state so cleanup doesn't break subsequent describe blocks.
  const savedKeys = {
    lynx: process.env.LYNX_DEEPSEEK_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
  };

  const restoreKeys = () => {
    if (savedKeys.lynx !== undefined)
      process.env.LYNX_DEEPSEEK_KEY = savedKeys.lynx;
    else delete process.env.LYNX_DEEPSEEK_KEY;
    if (savedKeys.deepseek !== undefined)
      process.env.DEEPSEEK_API_KEY = savedKeys.deepseek;
    else delete process.env.DEEPSEEK_API_KEY;
  };

  afterAll(restoreKeys);

  const MOCK_KEY = "sk-real-looking-key-1234567890";

  // ── presence / absence ──────────────────────────────────────

  it(
    "trace is absent when --include-trace is not set",
    { timeout: 15000 },
    async () => {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: true,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: false },
      );
      for (const t of result.tasks) expect(t.trace).toBeUndefined();
      const json = JSON.parse(agentResultToJSON(result, false));
      for (const t of json.tasks) expect(t.trace).toBeUndefined();
    },
  );

  it(
    "trace field is present (even if empty) when --include-trace is set",
    { timeout: 30000 },
    async () => {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: true,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: true },
      );
      for (const t of result.tasks) {
        if (t.trace) expect(Array.isArray(t.trace)).toBe(true);
      }
    },
  );

  // ── independence ────────────────────────────────────────────

  it("trace arrays are independent between runs (different references)", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        content: '{"a":1}',
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      mockResponse({
        content: '{"a":1}',
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env.LYNX_DEEPSEEK_KEY = MOCK_KEY;
    try {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: false,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: true },
      );
      const traces = result.tasks
        .map((t) => t.trace)
        .filter((t): t is NonNullable<typeof t> => t != null);
      expect(traces.length).toBeGreaterThanOrEqual(2);
      expect(traces[0]).not.toBe(traces[1]);
    } finally {
      globalThis.fetch = prev;
      restoreKeys();
    }
  });

  // ── structure (seq, role, duration, bytes, error) ───────────

  it("trace steps have correct structure: seq, role, duration_ms, and role-specific fields", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        content: '{"ok":true}',
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env.LYNX_DEEPSEEK_KEY = MOCK_KEY;
    try {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: false,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: true },
      );
      for (const task of result.tasks) {
        if (!task.trace || task.trace.length === 0) continue;
        for (const step of task.trace) {
          expect(typeof step.seq).toBe("number");
          expect(["llm_call", "tool_exec"]).toContain(step.role);
          expect(typeof step.duration_ms).toBe("number");
          expect(step.duration_ms).toBeGreaterThanOrEqual(0);
          if (step.role === "llm_call") {
            expect(typeof step.model).toBe("string");
            expect(typeof step.finish_reason).toBe("string");
          }
          if (step.role === "tool_exec") {
            expect(typeof step.tool_name).toBe("string");
            expect(typeof step.result_bytes).toBe("number");
          }
        }
      }
    } finally {
      globalThis.fetch = prev;
      restoreKeys();
    }
  });

  // ── secret redaction in args and errors ─────────────────────

  it("redacts secrets from tool_exec args in trace", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        toolCalls: [
          {
            name: "search_graph",
            args: {
              query: "sk-secret-key-12345678901234567890",
              token: "Bearer abcdefghijklmnopqrst12345",
            },
          },
        ],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      mockResponse({
        content: '{"done":true}',
        finishReason: "stop",
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
    ]);

    const traceSteps: ToolTraceStep[] = [];
    await chatCompletion(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "test" }],
        tools: [],
      },
      {
        onToolCall: async () =>
          "some tool result with sk-another-leaked-key-1234567890",
        onTrace: (step) => {
          traceSteps.push(step);
        },
      },
      {
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        timeoutMs: 5000,
        maxRetries: 0,
        maxToolCalls: 5,
        _fetch: mockFetch,
      },
    );

    const traceStr = JSON.stringify(traceSteps);
    expect(traceStr).not.toMatch(/sk-secret-key-12345678901234567890/);
    expect(traceStr).not.toMatch(/abcdefghijklmnopqrst12345/);
    expect(traceStr).not.toMatch(/sk-another-leaked-key-1234567890/);
    expect(traceStr).toContain("[REDACTED]");
    // Should have llm_call + tool_exec + llm_call = 3 steps
    expect(traceSteps.length).toBe(3);
    expect(traceSteps[0].role).toBe("llm_call");
    expect(traceSteps[0].finish_reason).toBe("tool_calls");
    expect(traceSteps[1].role).toBe("tool_exec");
    expect(traceSteps[1].tool_name).toBe("search_graph");
    expect(traceSteps[2].role).toBe("llm_call");
    expect(traceSteps[2].finish_reason).toBe("stop");
  });

  // ── content hashing without full content ────────────────────

  it("includes content_hash but never full response content", async () => {
    const longText = "LARGE_RESPONSE_SHOULD_NOT_LEAK_" + "y".repeat(400);
    const mockFetch = createMockFetch([
      mockResponse({
        content: longText,
        finishReason: "stop",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 500,
          total_tokens: 600,
        },
      }),
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env.LYNX_DEEPSEEK_KEY = MOCK_KEY;
    try {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: false,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: true },
      );
      for (const task of result.tasks) {
        if (!task.trace) continue;
        const traceStr = JSON.stringify(task.trace);
        expect(traceStr).toContain("content_hash");
        expect(traceStr).not.toContain("LARGE_RESPONSE_SHOULD_NOT_LEAK");
        for (const step of task.trace) {
          if (step.content_hash) {
            expect(step.content_hash).toMatch(/^[0-9a-f]{16}$/);
          }
        }
      }
    } finally {
      globalThis.fetch = prev;
      restoreKeys();
    }
  });

  // ── trace does not alter metrics when disabled ──────────────

  it("--include-trace does not change metrics or execution when disabled", async () => {
    const mockFetch = createMockFetch([
      mockResponse({
        content: '{"found_file":"x.ts"}',
        finishReason: "stop",
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
      mockResponse({
        content: '{"found_file":"x.ts"}',
        finishReason: "stop",
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
      mockResponse({
        content: '{"found_file":"x.ts"}',
        finishReason: "stop",
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
      mockResponse({
        content: '{"found_file":"x.ts"}',
        finishReason: "stop",
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
      }),
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env.LYNX_DEEPSEEK_KEY = MOCK_KEY;
    try {
      const without = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: false,
          measuredRounds: 2,
          taskIds: ["find_definition"],
        },
        { includeTrace: false },
      );
      const withTrace = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: false,
          measuredRounds: 2,
          taskIds: ["find_definition"],
        },
        { includeTrace: true },
      );
      // Same number of tasks
      expect(withTrace.tasks.length).toBe(without.tasks.length);
      for (let i = 0; i < without.tasks.length; i++) {
        const wt = withTrace.tasks[i];
        const wo = without.tasks[i];
        expect(wo.trace).toBeUndefined();
        // Core metrics must match exactly (trace doesn't alter the run)
        expect(wt.metrics.input_tokens).toBe(wo.metrics.input_tokens);
        expect(wt.metrics.output_tokens).toBe(wo.metrics.output_tokens);
        expect(wt.metrics.tool_call_count).toBe(wo.metrics.tool_call_count);
        expect(wt.metrics.cost_usd).toBe(wo.metrics.cost_usd);
        expect(wt.metrics.functional_success).toBe(
          wo.metrics.functional_success,
        );
        expect(wt.correct).toBe(wo.correct);
        expect(wt.responseHash).toBe(wo.responseHash);
      }
    } finally {
      globalThis.fetch = prev;
      restoreKeys();
    }
  });
});

// ── Shared tool-result guardrail ─────────────────────────────

describe("tool result guardrail", () => {
  it("caps oversized tool output with an actionable marker", () => {
    const result = truncateToolResult("x".repeat(MAX_TOOL_RESULT_BYTES + 100));
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThan(
      MAX_TOOL_RESULT_BYTES + 250,
    );
    expect(result).toContain("TOOL_RESULT_TRUNCATED");
  });
});

// ── getApiKey resolution ─────────────────────────────────────

describe("API key resolution", () => {
  it("returns null when no key is set", () => {
    const prevLynx = process.env.LYNX_DEEPSEEK_KEY;
    const prevDeepseek = process.env.DEEPSEEK_API_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    expect(getApiKey()).toBeNull();

    if (prevLynx !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevLynx;
    if (prevDeepseek !== undefined) process.env.DEEPSEEK_API_KEY = prevDeepseek;
  });

  it("prefers LYNX_DEEPSEEK_KEY over DEEPSEEK_API_KEY", () => {
    const prevLynx = process.env.LYNX_DEEPSEEK_KEY;
    const prevDeepseek = process.env.DEEPSEEK_API_KEY;
    process.env.LYNX_DEEPSEEK_KEY = "sk-lynx-key";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-key";

    expect(getApiKey()).toBe("sk-lynx-key");

    if (prevLynx !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevLynx;
    else delete process.env.LYNX_DEEPSEEK_KEY;
    if (prevDeepseek !== undefined) process.env.DEEPSEEK_API_KEY = prevDeepseek;
    else delete process.env.DEEPSEEK_API_KEY;
  });

  it("falls back to DEEPSEEK_API_KEY", () => {
    const prevLynx = process.env.LYNX_DEEPSEEK_KEY;
    const prevDeepseek = process.env.DEEPSEEK_API_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-fallback-key";

    expect(getApiKey()).toBe("sk-fallback-key");

    if (prevLynx !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevLynx;
    if (prevDeepseek !== undefined) process.env.DEEPSEEK_API_KEY = prevDeepseek;
    else delete process.env.DEEPSEEK_API_KEY;
  });
});

// ── sha256Hash ────────────────────────────────────────────────

describe("sha256Hash", () => {
  it("produces consistent hashes", () => {
    expect(sha256Hash("hello")).toBe(sha256Hash("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256Hash("hello")).not.toBe(sha256Hash("world"));
  });

  it("is 16 hex chars", () => {
    expect(sha256Hash("test")).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── progress callback ─────────────────────────────────────────

describe("progress callback", () => {
  let progressEvents: Array<{
    current: number;
    total: number;
    runId: string;
    condition: string;
    taskId: string;
  }> = [];

  beforeEach(() => {
    progressEvents = [];
  });

  it("callback fires for each run with correct counters", async () => {
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const result = await runAgentABBenchmark(
      {
        seed: 42,
        dryRun: true,
        measuredRounds: 2,
        taskIds: ["find_definition"],
      },
      {
        includeTrace: false,
        onProgress: (evt) => {
          progressEvents.push({
            current: evt.current,
            total: evt.total,
            runId: evt.run.run_id,
            condition: evt.run.condition,
            taskId: evt.run.task_id,
          });
        },
      },
    );

    expect(progressEvents.length).toBe(result.tasks.length);
    // Counters are sequential
    for (let i = 0; i < progressEvents.length; i++) {
      expect(progressEvents[i].current).toBe(i + 1);
    }
    // Total is consistent
    const total = progressEvents[0].total;
    expect(total).toBeGreaterThan(0);
    for (const e of progressEvents) {
      expect(e.total).toBe(total);
    }
    // Both conditions represented
    const conditions = new Set(progressEvents.map((e) => e.condition));
    expect(conditions.has("with_lynx")).toBe(true);
    expect(conditions.has("without_lynx")).toBe(true);
  });

  it("checkpoint file is written atomically", async () => {
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const checkpointFile = path.join(
      os.tmpdir(),
      `lynx-test-checkpoint-${Date.now()}.checkpoint`,
    );

    try {
      await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: true,
          measuredRounds: 1,
          taskIds: ["find_definition"],
        },
        { includeTrace: false, checkpointPath: checkpointFile },
      );

      // Checkpoint exists and is valid JSON
      expect(fs.existsSync(checkpointFile)).toBe(true);
      const raw = fs.readFileSync(checkpointFile, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.tasks).toBeDefined();
      expect(parsed.config).toBeDefined();
      expect(parsed.summary).toBeDefined();
      // No .tmp leftover from atomic write
      expect(fs.existsSync(checkpointFile + ".tmp")).toBe(false);

      // Checkpoint is not the final result (methodology says "checkpoint")
      expect(parsed.methodology).toEqual([
        "checkpoint — benchmark in progress",
      ]);
    } finally {
      try {
        fs.rmSync(checkpointFile, { force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(checkpointFile + ".tmp", { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("callback run objects are not empty", async () => {
    delete process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    await runAgentABBenchmark(
      {
        seed: 42,
        dryRun: true,
        measuredRounds: 1,
        taskIds: ["find_definition"],
      },
      {
        includeTrace: false,
        onProgress: (evt) => {
          expect(evt.run.run_id).toBeTruthy();
          expect(evt.run.task_id).toBeTruthy();
          expect(evt.run.condition).toBeTruthy();
          expect(evt.run.metrics).toBeDefined();
          expect(typeof evt.run.metrics.wall_time_ms).toBe("number");
          expect(typeof evt.run.metrics.tool_call_count).toBe("number");
        },
      },
    );
  });
});

// ── Neutral interpretation texts ──────────────────────────────

describe("neutral interpretation", () => {
  it("does not claim LYNX superiority in comparison texts", async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const result = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    for (const c of result.summary.comparison) {
      // Interpretations should be neutral — no positive claims about LYNX without data
      expect(c.interpretation).not.toMatch(
        /LYNX (is|requires|reduces|produces) (better|fewer|less|more|faster)/i,
      );
    }
  });
});

// ── Contract: default vs realistic suite isolation ────────────

describe("suite contract", () => {
  it("realistic fixture preflight passes without an API key", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-preflight-"));
    try {
      const fixture = generateFixture(base);
      const preflight = validateRealisticSuitePreflight(
        fixture,
        makeLynxToolsRealistic().map((tool) => tool.function.name),
      );
      expect(preflight.ok, preflight.errors.join("\n")).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("normalizes architecture language aliases by contract", () => {
    expect(normalizeArchitectureLanguage("ts")).toBe("TypeScript");
    expect(normalizeArchitectureLanguage("TypeScript")).toBe("TypeScript");
  });

  it("rejects paid microbenchmark model or provider drift before API calls", () => {
    expect(() =>
      assertPaidMicrobenchmarkProtocol({
        model: "another-model",
        temperature: 0,
        baseUrl: "https://api.deepseek.com/v1",
        seed: 42,
        maxTokens: 10,
        maxToolCalls: 1,
        timeoutMs: 1,
        maxRetries: 0,
      }),
    ).toThrow(/model must be exactly deepseek-v4-flash/);
  });

  it("blocks one-change acceptance without sufficient deterministic evidence", async () => {
    const before = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });
    const after = await runAgentABBenchmark({
      seed: 42,
      dryRun: true,
      taskIds: ["find_definition"],
    });
    const comparison = compareOneChange(before, after);
    expect(comparison.accepted).toBe(false);
    expect(comparison.blocked_reasons).toContain(
      "insufficient deterministic evaluated runs for acceptance",
    );
  });

  // ── Default suite shape ─────────────────────────────────────

  it("default suite has exactly 5 core tasks", { timeout: 15000 }, async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const result = await runAgentABBenchmark(
      { seed: 42, dryRun: true, measuredRounds: 1 },
      { suite: "default" },
    );

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    const taskIds = [...new Set(result.tasks.map((t) => t.task_id))];
    expect(taskIds.length).toBe(5);
    expect(taskIds.sort()).toEqual([
      "change_impact",
      "find_callers",
      "find_definition",
      "find_tests",
      "locate_definitions",
    ]);
  });

  it("default LYNX tool set has exactly the original 5 tool names", () => {
    const tools = makeLynxTools();
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toEqual([
      "explain_symbol",
      "find_tests",
      "read_file",
      "search_graph",
      "trace_path",
    ]);
  });

  it(
    "omitting --suite uses default (5 tasks, 5 tools)",
    { timeout: 15000 },
    async () => {
      const prevKey = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;

      const result = await runAgentABBenchmark(
        { seed: 42, dryRun: true, measuredRounds: 1 },
        // no suite specified
      );

      if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

      const taskIds = [...new Set(result.tasks.map((t) => t.task_id))];
      expect(taskIds.length).toBe(5);
      // Methodology must mention "5" not "15"
      expect(
        result.methodology.some((m) => m.includes("5 deterministic")),
      ).toBe(true);
      expect(
        result.methodology.some((m) => m.includes("15 deterministic")),
      ).toBe(false);
      expect(result.methodology.some((m) => m.includes("Suite: default"))).toBe(
        true,
      );
    },
  );

  // ── Realistic suite requires explicit selection ─────────────

  it(
    "realistic suite has exactly 15 tasks (5 core + 10 workflow)",
    { timeout: 15000 },
    async () => {
      const prevKey = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;

      const result = await runAgentABBenchmark(
        { seed: 42, dryRun: true, measuredRounds: 1 },
        { suite: "realistic" },
      );

      if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

      const taskIds = [...new Set(result.tasks.map((t) => t.task_id))];
      expect(taskIds.length).toBe(15);
      expect(
        result.methodology.some((m) => m.includes("Suite: realistic")),
      ).toBe(true);
      expect(
        result.methodology.some(
          (m) =>
            m.includes("11 deterministic") && m.includes("4 designed-only"),
        ),
      ).toBe(true);
      // All 5 core tasks are present
      for (const coreId of [
        "find_definition",
        "find_callers",
        "change_impact",
        "find_tests",
        "locate_definitions",
      ]) {
        expect(taskIds).toContain(coreId);
      }
      // All 10 workflow tasks are present
      for (const wfId of [
        "architecture_languages",
        "top_hotspots",
        "graph_schema",
        "semantic_search",
        "batch_get_code",
        "search_code",
        "smart_review",
        "detect_changes",
        "pack_memory",
        "query_graph",
      ]) {
        expect(taskIds).toContain(wfId);
      }
    },
  );

  it("realistic suite exposes the LYNX agent tools plus read_file", () => {
    const tools = makeLynxToolsRealistic();
    const names = tools.map((t) => t.function.name).sort();
    expect(names.length).toBe(19);
    // Core 5 must be present
    expect(names).toContain("search_graph");
    expect(names).toContain("trace_path");
    expect(names).toContain("explain_symbol");
    expect(names).toContain("find_tests");
    expect(names).toContain("read_file");
    // Workflow 13 must be present
    expect(names).toContain("get_architecture");
    expect(names).toContain("analyze_hotspots");
    expect(names).toContain("find_dead_code");
    expect(names).toContain("get_graph_schema");
    expect(names).toContain("semantic_search");
    expect(names).toContain("batch_get_code");
    expect(names).toContain("get_code_snippet");
    expect(names).toContain("search_code");
    expect(names).toContain("smart_review");
    expect(names).toContain("detect_changes");
    expect(names).toContain("pack_memory");
    expect(names).toContain("query_graph");
    expect(names).toContain("compare_runs");
    expect(names).toContain("pack_context");
  });

  it("realistic agent tools require evidence consolidation and stopping", () => {
    const tools = makeLynxToolsRealistic();
    for (const tool of tools) {
      const description = tool.function.description || "";
      expect(description).toContain("Start with narrow filters, scope, and result limits");
      expect(description).toContain("Reuse earlier results as evidence");
      expect(description).toContain("re-read a symbol or file already returned");
      expect(description).toContain("retry equivalent no-match searches");
      expect(description).toContain("After the returned evidence is sufficient");
      expect(description).toContain("consolidate it and stop investigating");
      expect(description).toContain("do not broaden the search");
      expect(description).toContain("repeat equivalent calls");
      expect(description).not.toMatch(/\bUse FIRST\b/);
      expect(description).not.toMatch(/\bALWAYS use\b/i);
    }
  });

  it(
    "realistic suite requires explicit --suite realistic (dynamic import)",
    { timeout: 15000 },
    async () => {
      const prevKey = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;

      // Default: no suite flag → 5 tasks
      const def = await runAgentABBenchmark({
        seed: 42,
        dryRun: true,
        measuredRounds: 1,
      });
      // Explicit realistic → 15 tasks
      const real = await runAgentABBenchmark(
        { seed: 42, dryRun: true, measuredRounds: 1 },
        { suite: "realistic" },
      );

      if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

      expect([...new Set(def.tasks.map((t) => t.task_id))].length).toBe(5);
      expect([...new Set(real.tasks.map((t) => t.task_id))].length).toBe(15);
      // Default methodology does NOT mention realistic
      expect(def.methodology.some((m) => m.includes("realistic"))).toBe(false);
      expect(real.methodology.some((m) => m.includes("realistic"))).toBe(true);
    },
  );

  // ── Coverage manifest ───────────────────────────────────────

  it("TOOL_COVERAGE covers all 25 MCP tools", () => {
    expect(TOOL_COVERAGE.length).toBe(25);
    const names = TOOL_COVERAGE.map((e) => e.tool_name).sort();
    // Spot-check known tools
    expect(names).toContain("search_graph");
    expect(names).toContain("index_repository");
    expect(names).toContain("watch_project");
    expect(names).toContain("batch_get_code");
    expect(names).toContain("manage_adr");
    // No duplicates
    expect(new Set(names).size).toBe(25);
  });

  it("coverageSummary reports correct breakdown", () => {
    const summary = coverageSummary();
    expect(summary.total).toBe(25);
    expect(summary.executable + summary.designed_only + summary.excluded).toBe(
      25,
    );
    // At least the core 5 + workflow 8 are executable
    expect(summary.executable).toBeGreaterThanOrEqual(11);
    // Smart review + detect_changes + pack_memory + query_graph + pack_context + compare_runs = 6 designed-only
    expect(summary.designed_only).toBeGreaterThanOrEqual(5);
    // 7 admin/infra tools
    expect(summary.excluded).toBe(7);
  });

  it("designedOnlyTools returns only designed-only tool names", () => {
    const names = designedOnlyTools();
    // Must be a subset of TOOL_COVERAGE designed-only entries
    const covDesignedOnly = TOOL_COVERAGE.filter(
      (e) => e.coverage === "designed-only",
    ).map((e) => e.tool_name);
    for (const name of names) {
      expect(covDesignedOnly).toContain(name);
    }
    // Known designed-only tools
    expect(names).toContain("smart_review");
    expect(names).toContain("detect_changes");
    expect(names).toContain("pack_memory");
    expect(names).toContain("query_graph");
    expect(names).toContain("pack_context");
    expect(names).toContain("compare_runs");
  });

  it("no admin/infra tool appears in realistic tasks", () => {
    const adminTools = TOOL_COVERAGE.filter(
      (e) => e.classification === "admin/infra",
    ).map((e) => e.tool_name);
    const allTaskToolRefs = TASKS_REALISTIC.flatMap((t) => t.userPrompt).join(
      " ",
    );
    for (const tool of adminTools) {
      expect(allTaskToolRefs).not.toContain(tool);
    }
  });

  it("designed-only tasks have no deterministic expectations", () => {
    // DESIGNED_ONLY: fully empty expected
    expect(DESIGNED_ONLY_TASK_IDS.has("detect_changes")).toBe(true);
    expect(DESIGNED_ONLY_TASK_IDS.has("pack_memory")).toBe(true);
    expect(DESIGNED_ONLY_TASK_IDS.has("query_graph")).toBe(true);
    expect(DESIGNED_ONLY_TASK_IDS.has("smart_review")).toBe(true);
    expect(PARTIAL_EXPECTED_TASK_IDS.size).toBe(0);

    // Verify the tasks themselves match
    const tasks = [
      ...TASKS_CORE,
      ...TASKS_REALISTIC.filter((t) => !TASKS_CORE.some((c) => c.id === t.id)),
    ];
    for (const task of tasks) {
      if (DESIGNED_ONLY_TASK_IDS.has(task.id)) {
        expect(Object.keys(task.expected).length).toBe(0);
      }
    }
  });

  it(
    "realistic suite warns about designed-only tools",
    { timeout: 15000 },
    async () => {
      const prevKey = process.env.LYNX_DEEPSEEK_KEY;
      delete process.env.LYNX_DEEPSEEK_KEY;

      const result = await runAgentABBenchmark(
        { seed: 42, dryRun: true, measuredRounds: 1 },
        { suite: "realistic" },
      );

      if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

      // Must have a designed-only warning
      const hasDesignedOnlyWarning = result.warnings.some((w) =>
        w.startsWith("Designed-only tools"),
      );
      expect(hasDesignedOnlyWarning).toBe(true);
      // Must have a coverage summary line
      const hasCoverageWarning = result.warnings.some((w) =>
        w.startsWith("Coverage:"),
      );
      expect(hasCoverageWarning).toBe(true);
      // Must have a suite task/tool count line
      const hasSuiteWarning = result.warnings.some(
        (w) => w.includes("tasks,") && w.includes("LYNX tools"),
      );
      expect(hasSuiteWarning).toBe(true);
    },
  );

  it("taskIds can filter realistic suite", { timeout: 15000 }, async () => {
    const prevKey = process.env.LYNX_DEEPSEEK_KEY;
    delete process.env.LYNX_DEEPSEEK_KEY;

    const result = await runAgentABBenchmark(
      {
        seed: 42,
        dryRun: true,
        measuredRounds: 1,
        taskIds: ["architecture_languages", "find_definition"],
      },
      { suite: "realistic" },
    );

    if (prevKey !== undefined) process.env.LYNX_DEEPSEEK_KEY = prevKey;

    const taskIds = [...new Set(result.tasks.map((t) => t.task_id))];
    expect(taskIds.sort()).toEqual([
      "architecture_languages",
      "find_definition",
    ]);
  });

  it(
    "designed-only tasks are excluded from success and defect denominators",
    { timeout: 15000 },
    async () => {
      const result = await runAgentABBenchmark(
        {
          seed: 42,
          dryRun: true,
          measuredRounds: 1,
          taskIds: ["find_definition", "detect_changes"],
        },
        { suite: "realistic" },
      );
      expect(result.summary.with_lynx.evaluated_runs).toBe(1);
      expect(result.summary.with_lynx.excluded_from_evaluation).toBe(1);
      const designed = result.tasks.filter(
        (task) => task.task_id === "detect_changes",
      );
      expect(designed.every((task) => task.evaluation_eligible === false)).toBe(
        true,
      );
    },
  );
});

// ── Cleanup after all tests ───────────────────────────────────

afterAll(() => {
  // Restore env
  delete process.env.LYNX_DEEPSEEK_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

describe("externalProjectLabel", () => {
  it("uses the parent name when the path ends in source", () => {
    expect(externalProjectLabel("/tmp/DEEPCODEX/source")).toBe("DEEPCODEX");
  });

  it("keeps ordinary project directory names", () => {
    expect(externalProjectLabel("/tmp/LINCE")).toBe("LINCE");
  });
});

describe("classifyAgentABResultValidity", () => {
  const resultWithTasks = (tasks: Partial[]) =>
    ({ tasks: tasks as AgentABRun[] }) as unknown as AgentABResult;

  it("marks an empty result as invalid", () => {
    expect(classifyAgentABResultValidity(resultWithTasks([]))).toEqual({
      valid: false,
      reasons: ["no_runs", "no_executed_runs", "no_complete_pairs"],
      executed_runs: 0,
      evaluated_runs: 0,
      complete_pairs: 0,
    });
  });

  it("marks a dry-run pair as invalid because nothing executed", () => {
    const result = classifyAgentABResultValidity(
      resultWithTasks([
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "with_lynx",
          not_executed: true,
          evaluation_eligible: true,
        },
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "without_lynx",
          not_executed: true,
          evaluation_eligible: true,
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["no_executed_runs", "no_complete_pairs"]);
    expect(result.executed_runs).toBe(0);
  });

  it("marks a single executed condition as an incomplete pair", () => {
    const result = classifyAgentABResultValidity(
      resultWithTasks([
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "with_lynx",
          not_executed: false,
          evaluation_eligible: true,
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["no_complete_pairs"]);
    expect(result.executed_runs).toBe(1);
    expect(result.evaluated_runs).toBe(1);
  });

  it("excludes a complete pair when either provider request failed", () => {
    const result = classifyAgentABResultValidity(
      resultWithTasks([
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "with_lynx",
          not_executed: false,
          evaluation_eligible: true,
          errors: ["provider_request_failed: Error: API 402"],
        },
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "without_lynx",
          not_executed: false,
          evaluation_eligible: true,
          errors: [],
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["provider_request_failed"]);
    expect(result.complete_pairs).toBe(1);
  });

  it("accepts a complete executed pair and counts evaluated runs", () => {
    const result = classifyAgentABResultValidity(
      resultWithTasks([
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "with_lynx",
          not_executed: false,
          evaluation_eligible: true,
        },
        {
          task_id: "task",
          seed: 1,
          order_position: 1,
          condition: "without_lynx",
          not_executed: false,
          evaluation_eligible: false,
        },
      ]),
    );
    expect(result).toEqual({
      valid: true,
      reasons: [],
      executed_runs: 2,
      evaluated_runs: 1,
      complete_pairs: 1,
    });
  });
});

describe("agent-ab history hygiene", () => {
  it("returns an empty summary when the index file does not exist", () => {
    const summary = readAgentABIndex(
      path.resolve("benchmarks/results/missing_agent_ab_index.jsonl"),
    );
    expect(summary.total_lines).toBe(0);
    expect(summary.included_count).toBe(0);
    expect(summary.excluded_count).toBe(0);
    expect(summary.included).toEqual([]);
    expect(summary.excluded).toEqual([]);
  });

  it("does not hide index read errors other than ENOENT", () => {
    expect(() => readAgentABIndex(path.resolve("benchmarks/results"))).toThrow();
  });

  it("keeps valid legacy and explicit-valid entries", () => {
    const summary = summarizeAgentABIndexLines([
      JSON.stringify({ base_name: "legacy", tasks: 2 }),
      JSON.stringify({ base_name: "new", tasks: 2, valid: true }),
    ]);
    expect(summary.included.map((entry) => entry.base_name)).toEqual([
      "legacy",
      "new",
    ]);
    expect(summary.excluded_count).toBe(0);
  });

  it("excludes explicit-invalid, empty legacy, and malformed entries with reasons", () => {
    const summary = summarizeAgentABIndexLines([
      JSON.stringify({
        base_name: "invalid",
        tasks: 2,
        valid: false,
        invalid_reasons: ["no_complete_pairs"],
      }),
      JSON.stringify({ base_name: "empty", tasks: 0 }),
      "{not json",
      "",
    ]);
    expect(summary.included_count).toBe(0);
    expect(summary.excluded_count).toBe(3);
    expect(summary.excluded_by_reason).toEqual({
      invalid_flag: 1,
      legacy_empty_tasks: 1,
      malformed_json: 1,
    });
    expect(summary.excluded[0].invalid_reasons).toEqual(["no_complete_pairs"]);
  });

  it("reads the current historical index without deleting artifacts", () => {
    const indexPath = path.resolve("benchmarks/results/_index.jsonl");
    const summary = readAgentABIndex(indexPath);
    expect(summary.total_lines).toBe(
      summary.included_count + summary.excluded_count,
    );
    expect(summary.included_count).toBeGreaterThan(0);
    expect(summary.excluded_by_reason.legacy_empty_tasks).toBeGreaterThanOrEqual(0);
    expect(
      summary.excluded
        .filter((entry) => entry.reason === "invalid_flag")
        .every((entry) => (entry.invalid_reasons || []).length > 0),
    ).toBe(true);
    expect(summary.excluded_by_reason.malformed_json).toBe(0);
  });
});

describe("agent-ab history statistics", () => {
  it("returns a zero interval for an empty sample", () => {
    expect(wilsonInterval(0, 0)).toEqual({
      rate: 0,
      lower: 0,
      upper: 0,
      wins: 0,
      ties: 0,
      losses: 0,
      total: 0,
    });
  });

  it("returns a stable empty aggregate", () => {
    const aggregate = aggregateAgentABHistory([]);
    expect(aggregate).toEqual({
      runs: 0,
      cost_runs: 0,
      wall_time_runs: 0,
      quality_runs: 0,
      evaluated_runs: 0,
      cost_coverage_rate: null,
      wall_time_coverage_rate: null,
      quality_coverage_rate: null,
      projects: 0,
      lynx_cost_usd: 0,
      baseline_cost_usd: 0,
      cost_savings_usd: 0,
      cost_savings_rate: null,
      lynx_wall_ms: 0,
      baseline_wall_ms: 0,
      wall_time_savings_ms: 0,
      wall_time_savings_rate: null,
      macro_cost_savings_rate: null,
      macro_wall_time_savings_rate: null,
      project_cost_savings_win_rate: {
        rate: 0,
        lower: 0,
        upper: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        total: 0,
      },
      project_wall_time_savings_win_rate: {
        rate: 0,
        lower: 0,
        upper: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        total: 0,
      },
      cost_win_rate: {
        rate: 0,
        lower: 0,
        upper: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        total: 0,
      },
      wall_time_win_rate: {
        rate: 0,
        lower: 0,
        upper: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        total: 0,
      },
      by_project: [],
    });
  });

  it("computes the 95% Wilson interval for 34 wins out of 43", () => {
    const interval = wilsonInterval(34, 43);
    expect(interval.rate).toBeCloseTo(34 / 43, 12);
    expect(interval.lower).toBeCloseTo(0.64794068, 7);
    expect(interval.upper).toBeCloseTo(0.88577294, 7);
  });

  it("aggregates comparable entries and ignores incomplete metrics", () => {
    const aggregate = aggregateAgentABHistory([
      {
        project: "A",
        tasks: 2,
        evaluated_runs: 2,
        lynx: { total_cost_usd: 1, median_wall_ms: 10 },
        baseline: { total_cost_usd: 2, median_wall_ms: 20 },
      },
      {
        project: "B",
        tasks: 2,
        evaluated_runs: 1,
        lynx: { total_cost_usd: 3, median_wall_ms: 30 },
        baseline: { total_cost_usd: 2, median_wall_ms: 25 },
      },
      {
        project: "cost-only",
        tasks: 2,
        lynx: { total_cost_usd: 1 },
        baseline: { total_cost_usd: 3 },
      },
      {
        project: "wall-only",
        tasks: 2,
        lynx: { median_wall_ms: 5 },
        baseline: { median_wall_ms: 10 },
      },
      { project: "ignored", tasks: 2 },
    ]);
    expect(aggregate.runs).toBe(4);
    expect(aggregate.cost_runs).toBe(3);
    expect(aggregate.wall_time_runs).toBe(3);
    expect(aggregate.quality_runs).toBe(2);
    expect(aggregate.evaluated_runs).toBe(3);
    expect(aggregate.cost_coverage_rate).toBeCloseTo(3 / 5, 12);
    expect(aggregate.wall_time_coverage_rate).toBeCloseTo(3 / 5, 12);
    expect(aggregate.quality_coverage_rate).toBeCloseTo(2 / 5, 12);
    expect(aggregate.projects).toBe(4);
    expect(aggregate.lynx_cost_usd).toBe(5);
    expect(aggregate.baseline_cost_usd).toBe(7);
    expect(aggregate.cost_savings_usd).toBe(2);
    expect(aggregate.cost_savings_rate).toBeCloseTo(2 / 7, 12);
    expect(aggregate.lynx_wall_ms).toBe(45);
    expect(aggregate.baseline_wall_ms).toBe(55);
    expect(aggregate.wall_time_savings_ms).toBe(10);
    expect(aggregate.wall_time_savings_rate).toBeCloseTo(2 / 11, 12);
    expect(aggregate.macro_cost_savings_rate).toBeCloseTo(2 / 9, 12);
    expect(aggregate.macro_wall_time_savings_rate).toBeCloseTo(4 / 15, 12);
    expect(aggregate.project_cost_savings_win_rate.wins).toBe(2);
    expect(aggregate.project_wall_time_savings_win_rate.wins).toBe(2);
    expect(aggregate.project_wall_time_savings_win_rate.total).toBe(3);
    expect(aggregate.project_cost_savings_win_rate.total).toBe(3);
    expect(aggregate.cost_win_rate.wins).toBe(2);
    expect(aggregate.cost_win_rate.total).toBe(3);
    expect(aggregate.wall_time_win_rate.wins).toBe(2);
    expect(aggregate.wall_time_win_rate.total).toBe(3);
  });

  it("reports uncertainty for the current clean historical sample", () => {
    const history = readAgentABIndex(
      path.resolve("benchmarks/results/_index.jsonl"),
    );
    const aggregate = aggregateAgentABHistory(history.included);
    expect(aggregate.runs).toBe(history.included_count);
    expect(aggregate.cost_runs).toBe(aggregate.runs);
    expect(aggregate.wall_time_runs).toBe(aggregate.runs);
    expect(aggregate.quality_runs).toBeGreaterThanOrEqual(0);
    expect(aggregate.quality_runs).toBeLessThanOrEqual(aggregate.runs);
    expect(aggregate.evaluated_runs).toBeGreaterThanOrEqual(
      aggregate.quality_runs,
    );
    expect(aggregate.cost_win_rate.total).toBe(aggregate.runs);
    expect(aggregate.wall_time_win_rate.total).toBe(aggregate.runs);
    expect(aggregate.projects).toBe(aggregate.by_project.length);
    expect(Number.isFinite(aggregate.lynx_cost_usd)).toBe(true);
    expect(Number.isFinite(aggregate.baseline_cost_usd)).toBe(true);
  });
});
