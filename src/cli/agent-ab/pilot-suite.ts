/*
 * agent-ab/pilot-suite.ts — Pilot benchmark suite for agent A/B.
 *
 * 3 tasks (A2, A5, B3) against an external project. Ground truth is
 * extracted once and frozen before the benchmark loop.
 *
 * A2: Find callers (deterministic — ground truth from trace_path)
 * A5: Scalability snapshot (partial — ground truth from analyze_hotspots)
 * B3: Fix injected bug + hidden tests (deterministic — worktree isolated)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { LynxDatabase } from "../../store/database.js";
import { handleTracePath } from "../../mcp/handlers/trace_path.js";
import { handleAnalyzeHotspots } from "../../mcp/handlers/analyze_hotspots.js";
import {
  evaluateResponse,
  runB3Build,
  runB3Tests,
  safeReadFile,
  type BenchmarkTask,
} from "./execution-support.js";
import { redactSecrets } from "./api-client.js";
import type { AgentToolDefinition, PilotGroundTruth } from "./types.js";

// ── Hidden tests directory (inside LYNX repo, outside any worktree) ──

export const HIDDEN_TESTS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "hidden-tests",
);

// ── Ground truth extraction ────────────────────────────────────

export async function extractPilotGroundTruth(
  project: string,
  projectDir: string,
): Promise<PilotGroundTruth> {
  const commit = execSync("git rev-parse HEAD", {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: 10000,
  }).trim();

  const [trace, hotspots] = await Promise.all([
    handleTracePath({
      project,
      function_name: "lib.ops.api.enforceOpsRequest",
      direction: "inbound",
      depth: 1,
      include_tests: false,
    }),
    handleAnalyzeHotspots({ project, limit: 20 }),
  ]);

  const a2Callers = ((trace as any).callers || [])
    .slice(0, 10)
    .map((c: any) => ({ name: c.name, file_path: c.file_path }));

  return {
    a2_callers: a2Callers,
    a5_largest_files: ((hotspots as any).largest_files || []).slice(0, 5),
    a5_most_complex: ((hotspots as any).most_complex || []).slice(0, 5),
    a5_tightest_coupling: ((hotspots as any).tightest_coupling || []).slice(
      0,
      5,
    ),
    a5_god_objects: ((hotspots as any).god_components || [])
      .slice(0, 5)
      .map((g: any) => ({
        name: g.name,
        file: g.file_path || g.file,
        lines: g.lines || g.complexity,
      })),
    b3_commit: commit,
    b3_bug_file: "src/lib/ops/api.ts",
    b3_bug_description:
      "machine: true changed to machine: false in token-auth return path of enforceOpsRequest",
  };
}

// ── Task construction ──────────────────────────────────────────

export function makePilotTasks(gt: PilotGroundTruth): BenchmarkTask[] {
  return [
    {
      id: "pilot_find_callers",
      name: "Find callers of enforceOpsRequest",
      userPrompt:
        'Find all functions that directly call "enforceOpsRequest" in this project. ' +
        'Use trace_path to trace inbound callers (direction="inbound", depth=1). ' +
        "List each caller with its name and file_path. " +
        "Respond ONLY with a JSON object:\n" +
        '{"callers": [{"name": "POST", "file_path": "src/app/api/admin/audit-log/route.ts"}, ...]}',
      expected: { callers: gt.a2_callers },
      evaluation_kind: "deterministic",
    },
    {
      id: "pilot_scalability",
      name: "Scalability snapshot of the project",
      userPrompt:
        "Give me a scalability health check of this project. Find:\n" +
        "1. The top 5 largest files by line count\n" +
        "2. The top 5 most complex functions\n" +
        "3. The top 5 most tightly coupled modules (highest fan-in)\n" +
        "4. The top 5 god objects (files/modules that do too much)\n" +
        "Use analyze_hotspots. " +
        "Respond ONLY with a JSON object:\n" +
        '{"largest_files":[{"file":"src/...","lines":N},...], ' +
        '"most_complex":[{"name":"...","file":"src/...","complexity":N},...], ' +
        '"tightest_coupling":[{"name":"...","file":"src/...","fan_in":N},...], ' +
        '"god_objects":[{"name":"...","file":"src/...","lines":N},...], ' +
        '"methodology":"...", "summary":"..."}',
      expected: {
        largest_files: gt.a5_largest_files,
        most_complex: gt.a5_most_complex,
        tightest_coupling: gt.a5_tightest_coupling,
        god_objects: gt.a5_god_objects,
      },
      evaluation_kind: "partial",
    },
    {
      id: "pilot_bug_fix",
      name: "Fix injected bug and pass hidden tests",
      userPrompt:
        "IMPORTANT: Follow these steps in order. Do NOT skip any step.\n\n" +
        "1. FIRST, run the hidden tests with run_tests — they will tell you exactly what is broken.\n" +
        "2. Read src/lib/ops/api.ts and find the enforceOpsRequest function.\n" +
        "3. The hidden test failure message will say what string is missing or wrong. " +
        "Fix ONLY the specific boolean constant that is wrong — change machine: false back to machine: true " +
        "in the return statement. Use write_file with ONLY the changed lines around line 26, NOT the whole file!\n" +
        "4. Run run_build to confirm the project compiles.\n" +
        "5. Run run_tests again to confirm all tests pass.\n\n" +
        "After completing ALL steps, respond with JSON:\n" +
        '{"bug_found": "description of the bug", ' +
        '"file_changed": "src/lib/ops/api.ts", ' +
        '"fix_applied": "description of the fix", ' +
        '"build_passed": true/false, "tests_run": N, "tests_passed": N}',
      expected: {
        file_changed: "src/lib/ops/api.ts",
        build_passed: true,
        tests_passed: 2,
        tests_run: 2,
      },
      evaluation_kind: "deterministic",
    },
  ];
}

// ── Tool profiles ─────────────────────────────────────────────

export const PILOT_TASK_TOOL_PROFILES: Record<string, readonly string[]> = {
  pilot_find_callers: ["trace_path", "search_graph", "read_file"],
  pilot_scalability: ["analyze_hotspots", "get_architecture", "read_file"],
  pilot_bug_fix: [
    "read_file",
    "search_graph",
    "get_code_snippet",
    "write_file",
    "run_build",
    "run_tests",
  ],
};

export async function makeLynxToolsForPilotTask(
  task: BenchmarkTask,
): Promise<AgentToolDefinition[]> {
  const realistic = await import("./realistic-suite.js");
  const allTools = realistic.makeLynxToolsRealistic();
  const allowed = PILOT_TASK_TOOL_PROFILES[task.id] || ["read_file"];

  // Add write_file, run_build, run_tests if needed (they're not LYNX MCP tools)
  const needsModTools = allowed.includes("write_file");

  const filtered = allTools.filter((tool) =>
    allowed.includes(tool.function.name),
  );

  if (needsModTools) {
    filtered.push({
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write or overwrite a file in the project with new content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path" },
            content: { type: "string", description: "New file content" },
          },
          required: ["path", "content"],
        },
      },
    });
    filtered.push({
      type: "function",
      function: {
        name: "run_build",
        description:
          "Run the project build command and return success/failure output.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    });
    filtered.push({
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the test suite and return results.",
        parameters: {
          type: "object",
          properties: {
            testFile: {
              type: "string",
              description: "Optional: specific test file pattern",
            },
          },
          required: [],
        },
      },
    });
  }

  return filtered;
}

export async function executePilotLynxTool(
  toolName: string,
  args: Record<string, unknown>,
  project: string,
  fixtureDir: string,
): Promise<string> {
  // Code-modification tools (not LYNX MCP — local filesystem/process)
  switch (toolName) {
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
      // Copy hidden tests into worktree so the agent can run them
      const targetTestDir = path.join(fixtureDir, "hidden-tests");
      if (fs.existsSync(HIDDEN_TESTS_DIR)) {
        copyDirSync(HIDDEN_TESTS_DIR, targetTestDir);
      }
      const testFile = args.testFile ? String(args.testFile) : undefined;
      const result = runB3Tests(fixtureDir, testFile);
      return (
        result.stdout?.slice(-3000) ||
        result.stderr?.slice(-3000) ||
        "(no output)"
      );
    }
    default: {
      // Delegate to realistic LYNX executor
      const realistic = await import("./realistic-suite.js");
      return realistic.executeLynxToolRealistic(
        toolName,
        args,
        project,
        fixtureDir,
      );
    }
  }
}

// ── B3 worktree isolation ──────────────────────────────────────

export function setupB3Worktree(opts: { projectDir: string; commit: string }): {
  worktreePath: string;
  cleanup: () => void;
} {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-b3-"));
  execSync(`git worktree add --detach "${worktreePath}" ${opts.commit}`, {
    cwd: opts.projectDir,
    stdio: "pipe",
    timeout: 30_000,
  });

  // Symlink node_modules from the source project so build/tests work.
  // The worktree only has source; dependencies are in the main worktree.
  const srcNodeModules = path.resolve(opts.projectDir, "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  if (fs.existsSync(srcNodeModules) && !fs.existsSync(worktreeNodeModules)) {
    fs.symlinkSync(srcNodeModules, worktreeNodeModules, "dir");
  }

  // Generated Prisma clients are gitignored but required by the project build.
  const srcGeneratedPrisma = path.resolve(
    opts.projectDir,
    "src/generated/prisma",
  );
  const worktreeGeneratedPrisma = path.join(
    worktreePath,
    "src/generated/prisma",
  );
  if (
    fs.existsSync(srcGeneratedPrisma) &&
    !fs.existsSync(worktreeGeneratedPrisma)
  ) {
    fs.mkdirSync(path.dirname(worktreeGeneratedPrisma), { recursive: true });
    fs.symlinkSync(srcGeneratedPrisma, worktreeGeneratedPrisma, "dir");
  }
  // Inject only the token-auth bug; user-auth legitimately remains machine: false.
  const apiFile = path.join(worktreePath, "src/lib/ops/api.ts");
  let content = fs.readFileSync(apiFile, "utf-8");
  const tokenBranchStart = content.indexOf(
    "if (token && headerToken && headerToken === token) {",
  );
  const tokenBranchEnd = content.indexOf(
    "\n\n  const auth =",
    tokenBranchStart,
  );
  if (tokenBranchStart < 0 || tokenBranchEnd < tokenBranchStart) {
    throw new Error(
      "B3 fixture source does not contain the expected token-auth branch",
    );
  }
  const tokenBranch = content.slice(tokenBranchStart, tokenBranchEnd);
  if (!tokenBranch.includes("machine: true,")) {
    throw new Error(
      "B3 fixture token-auth branch does not contain machine: true",
    );
  }
  content =
    content.slice(0, tokenBranchStart) +
    tokenBranch.replace("machine: true,", "machine: false,") +
    content.slice(tokenBranchEnd);
  fs.writeFileSync(apiFile, content, "utf-8");

  // Copy hidden tests into the worktree so the agent can run them
  const targetTestDir = path.join(worktreePath, "hidden-tests");
  copyDirSync(HIDDEN_TESTS_DIR, targetTestDir);

  return {
    worktreePath,
    cleanup: () => {
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: opts.projectDir,
          stdio: "pipe",
          timeout: 10_000,
        });
      } catch {
        /* worktree may already be removed */
      }
      try {
        // Remove symlinks (not their targets) before recursive rm
        if (fs.lstatSync(worktreeNodeModules).isSymbolicLink()) {
          fs.unlinkSync(worktreeNodeModules);
        }
      } catch {
        /* may not exist */
      }

      try {
        if (
          fs.existsSync(worktreeGeneratedPrisma) &&
          fs.lstatSync(worktreeGeneratedPrisma).isSymbolicLink()
        ) {
          fs.unlinkSync(worktreeGeneratedPrisma);
        }
      } catch {
        /* may not exist */
      }
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* dir may already be gone */
      }
    },
  };
}

// ── B3 scoring ─────────────────────────────────────────────────

export function parseVitestTestCounts(output: string): {
  passed: number;
  failed: number;
  total: number;
} {
  const plainOutput = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const summaryLine = plainOutput
    .split(/\r?\n/)
    .find((line) => /^\s*Tests\s+/.test(line));

  if (!summaryLine) {
    return { passed: 0, failed: 0, total: 0 };
  }

  const passed = Number(summaryLine.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const failed = Number(summaryLine.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const reportedTotal = Number(summaryLine.match(/\((\d+)\)/)?.[1] ?? 0);

  return {
    passed,
    failed,
    total: reportedTotal || passed + failed,
  };
}

export function evaluatePilotBugFix(
  worktreePath: string,
  hiddenTestsDir: string,
): {
  result: Record<string, unknown>;
  correct: boolean;
  defects: number;
  errors: string[];
  diff: string;
  testOutput: string;
} {
  const errors: string[] = [];
  let defects = 0;
  const result: Record<string, unknown> = {};

  // 1. Capture diff
  const diffResult = spawnSync("git", ["diff"], {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: 10_000,
  });
  const diff = diffResult.stdout || "";

  // Parse diff stats
  const linesAdded = (diff.match(/^\+(?!\+\+)/gm) || []).length;
  const linesRemoved = (diff.match(/^-(?!--)/gm) || []).length;
  const filesChanged = new Set(
    (diff.match(/^diff --git a\/(.+) b\/(.+)$/gm) || []).map((line) => {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      return m ? m[1] : "";
    }),
  ).size;

  result.diff_lines_added = linesAdded;
  result.diff_lines_removed = linesRemoved;
  result.diff_files_changed = filesChanged;

  // 2. Run build
  const { result: buildResult } = runB3Build(worktreePath);
  const buildPassed = buildResult.status === 0;
  result.build_passed = buildPassed;
  if (!buildPassed) {
    defects++;
    errors.push("Build failed after agent fix");
  }

  // 3. Run hidden tests
  const targetTestDir = path.join(worktreePath, "hidden-tests");
  copyDirSync(hiddenTestsDir, targetTestDir);

  const testResult = runB3Tests(worktreePath);
  const output = [testResult.stdout, testResult.stderr]
    .filter(Boolean)
    .join("\n");
  const testOutput = output.slice(-5000);

  const {
    passed: testsPassed,
    failed: testsFailed,
    total: testsTotal,
  } = parseVitestTestCounts(output);

  result.tests_passed = testsPassed;
  result.tests_total = testsTotal;

  if (testsTotal === 0) {
    defects++;
    errors.push("No hidden tests were executed");
  } else if (testsFailed > 0) {
    defects += testsFailed;
    errors.push(`${testsFailed}/${testsTotal} hidden tests failed`);
  }

  const correct = buildPassed && testsFailed === 0 && testsTotal > 0;
  return { result, correct, defects, errors, diff, testOutput };
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── A5 scoring ─────────────────────────────────────────────────

export function evaluatePilotScalability(
  responseText: string,
  gt: PilotGroundTruth,
): ReturnType<typeof evaluateResponse> {
  const parsed = evaluateResponse(responseText, {});
  if (parsed.errors.length > 0) return parsed;

  const result = parsed.result;
  const errors: string[] = [];
  let defects = 0;

  // "3 of 5" threshold: at least 3 of the top 5 must match ground truth
  // by filename substring (files) or name match (functions)

  const gtFiles = new Set(
    gt.a5_largest_files.map((f) => path.basename(f.file)),
  );
  const reportedFiles = (result.largest_files as any[]) || [];
  const matchedFiles = reportedFiles.filter((f: any) =>
    gtFiles.has(path.basename(String(f.file || ""))),
  );
  if (matchedFiles.length < 3) {
    defects++;
    errors.push(
      `largest_files: only ${matchedFiles.length}/5 matched ground truth`,
    );
  }

  const gtComplex = new Set(gt.a5_most_complex.map((f) => f.name));
  const reportedComplex = (result.most_complex as any[]) || [];
  const matchedComplex = reportedComplex.filter((f: any) =>
    gtComplex.has(String(f.name || "")),
  );
  if (matchedComplex.length < 3) {
    defects++;
    errors.push(
      `most_complex: only ${matchedComplex.length}/5 matched ground truth`,
    );
  }

  const gtCoupling = new Set(gt.a5_tightest_coupling.map((f) => f.name));
  const reportedCoupling = (result.tightest_coupling as any[]) || [];
  const matchedCoupling = reportedCoupling.filter((f: any) =>
    gtCoupling.has(String(f.name || "")),
  );
  if (matchedCoupling.length < 3) {
    defects++;
    errors.push(
      `tightest_coupling: only ${matchedCoupling.length}/5 matched ground truth`,
    );
  }

  const gtGod = new Set(gt.a5_god_objects.map((f) => path.basename(f.file)));
  const reportedGod = (result.god_objects as any[]) || [];
  const matchedGod = reportedGod.filter((f: any) =>
    gtGod.has(path.basename(String(f.file || ""))),
  );
  if (matchedGod.length < 3) {
    defects++;
    errors.push(
      `god_objects: only ${matchedGod.length}/5 matched ground truth`,
    );
  }

  const correct = defects === 0;
  return {
    result: {
      ...result,
      _ground_truth_matches: {
        largest_files: matchedFiles.length,
        most_complex: matchedComplex.length,
        tightest_coupling: matchedCoupling.length,
        god_objects: matchedGod.length,
      },
    },
    correct,
    defects,
    errors: [...parsed.errors, ...errors],
  };
}
