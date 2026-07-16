import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  runPipeline: vi.fn(async () => ({ status: { totalNodes: 1, totalEdges: 1 }, architecture: { hotspots: [], clusters: [] } })),
  openProject: vi.fn(() => ({ close: vi.fn(), setProjectStatus: vi.fn() })),
  cleanupNativeExtractor: vi.fn(),
  resolveProjectPath: vi.fn(() => ({ rootPath: process.cwd(), name: "LYNX" })),
}));

vi.mock("../../../src/pipeline/orchestrator.js", () => ({ runPipeline: handlers.runPipeline }));
vi.mock("../../../src/store/database.js", () => ({ LynxDatabase: { openProject: handlers.openProject } }));
vi.mock("../../../src/discovery/project-scanner.js", () => ({ resolveProjectPath: handlers.resolveProjectPath }));
vi.mock("../../../src/paths.js", () => ({ cleanupNativeExtractor: handlers.cleanupNativeExtractor }));

import { cmdIndex } from "../../../src/cli/commands/index-cmd.js";

beforeEach(() => vi.clearAllMocks());

describe("index CLI command", () => {
  it("passes parsed options to pipeline", async () => {
    await cmdIndex([".", "--mode", "fast", "--llm", "--name", "TEST"]);
    expect(handlers.runPipeline).toHaveBeenCalled();
    expect(handlers.cleanupNativeExtractor).toHaveBeenCalled();
  });
});
