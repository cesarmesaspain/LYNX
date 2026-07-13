import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  readArchivedEvents: vi.fn(() => []),
  closeMetricsDb: vi.fn(),
}));

vi.mock("../../../src/install/doctor.js", () => ({
  runDoctor: handlers.runDoctor,
}));

vi.mock("../../../src/store/metrics-db.js", () => ({
  readArchivedEvents: handlers.readArchivedEvents,
  closeMetricsDb: handlers.closeMetricsDb,
  rebuildDailySnapshots: vi.fn(),
}));

import { cmdUpgrade } from "../../../src/cli/commands/upgrade-cmd.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upgrade CLI command", () => {
  it("skips doctor in dry-run mode", async () => {
    await cmdUpgrade(["--dry-run"]);
    expect(handlers.runDoctor).not.toHaveBeenCalled();
    expect(handlers.readArchivedEvents).toHaveBeenCalled();
    expect(handlers.closeMetricsDb).toHaveBeenCalled();
  });
});
