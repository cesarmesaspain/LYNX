import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  rebuildDailySnapshots: vi.fn(() => ({ projects_rebuilt: 0, rows_before: 0, rows_after: 0 })),
  summarizeHistory: vi.fn(),
  readArchivedEvents: vi.fn(),
}));

vi.mock("../../../src/store/metrics-db.js", () => ({
  rebuildDailySnapshots: handlers.rebuildDailySnapshots,
  summarizeHistory: handlers.summarizeHistory,
  readArchivedEvents: handlers.readArchivedEvents,
}));

import { cmdMetrics } from "../../../src/cli/commands/metrics-cmd.js";

beforeEach(() => vi.clearAllMocks());

describe("metrics CLI command", () => {
  it("shows usage without subcommand", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cmdMetrics([]);
    expect(log).toHaveBeenCalledWith("Usage: lynx metrics <rebuild|verify>");
    log.mockRestore();
  });

  it("delegates rebuild dry run", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cmdMetrics(["rebuild", "--dry-run"]);
    expect(handlers.rebuildDailySnapshots).toHaveBeenCalledWith(true);
    log.mockRestore();
  });
});
