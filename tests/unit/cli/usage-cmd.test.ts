import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  clearUsageEvents: vi.fn(() => 2),
  exportUsageEvents: vi.fn(() => 3),
  summarizeUsage: vi.fn(() => ({ total: 5 })),
  usageLogPath: vi.fn(() => "/tmp/usage.log"),
}));

vi.mock("../../../src/usage/metrics.js", () => ({
  clearUsageEvents: handlers.clearUsageEvents,
  exportUsageEvents: handlers.exportUsageEvents,
  summarizeUsage: handlers.summarizeUsage,
  usageLogPath: handlers.usageLogPath,
}));

import { cmdUsage } from "../../../src/cli/commands/usage-cmd.js";

beforeEach(() => vi.clearAllMocks());

describe("usage CLI command", () => {
  it("clears events", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cmdUsage(["clear", "TEST"]);
    expect(handlers.clearUsageEvents).toHaveBeenCalledWith("TEST");
    log.mockRestore();
  });

  it("exports events", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cmdUsage(["export", "--out", "out.json"]);
    expect(handlers.exportUsageEvents).toHaveBeenCalledWith("out.json", undefined);
    log.mockRestore();
  });

  it("shows summary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cmdUsage([]);
    expect(handlers.summarizeUsage).toHaveBeenCalled();
    log.mockRestore();
  });
});
