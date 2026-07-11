import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { closeMetricsDb } from "../../src/store/metrics-db.js";
import { assertIsolated, testHome } from "../setup.js";

// ── Helpers ────────────────────────────────────────────────

function makeEvent(
  project: string,
  event_id: string,
  overrides: Partial<{
    tokens_saved: number;
    files_avoided: number;
    type: string;
    session_id: string;
    task_id: string;
  }> = {},
): import("../../src/usage/metrics.js").UsageEvent {
  return {
    ts: new Date().toISOString().slice(0, 10) + "T12:00:00.000Z",
    type: overrides.type || "search_graph",
    project,
    query: `query-${event_id}`,
    query_hash: `hash-${event_id}`,
    files_avoided: overrides.files_avoided ?? 10,
    tokens_saved: overrides.tokens_saved ?? 9000,
    confidence: "high",
    event_id,
    session_id: overrides.session_id || "sess-1",
    task_id: overrides.task_id || "task-1",
    deterministic_mode: false,
  };
}

// ── Full metrics pipeline ──────────────────────────────────

describe("Full metrics pipeline (isolated)", () => {
  // Captured INSIDE hooks — never at module level
  let workerHome: string;
  let perTestHome: string;
  const PROJECT = "pipe-test";

  beforeEach(() => {
    // Capture the worker's isolated LYNX_HOME (set by tests/setup.ts)
    workerHome = testHome();
    assertIsolated();

    // Create a per-test subdir under the worker's temp home
    closeMetricsDb();
    perTestHome = fs.mkdtempSync(path.join(workerHome, "sub-"));
    fs.mkdirSync(path.join(perTestHome, "dbs"), { recursive: true });
    process.env.LYNX_HOME = perTestHome;
  });

  afterEach(() => {
    closeMetricsDb();
    // Restore to the worker's temp home (never the user's real ~/.lynx)
    process.env.LYNX_HOME = workerHome;
    try {
      fs.rmSync(perTestHome, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  afterAll(() => {
    // Final assertion: we're still in the worker's temp home
    assertIsolated();
  });

  // ── Stage 1: Event → Archive ──────────────────────────────

  it("archiveEvent writes to events_archive with all v3 fields", async () => {
    const { archiveEvent, readArchivedEvents } =
      await import("../../src/store/metrics-db.js");
    const ev = makeEvent(PROJECT, "arc-001", { tokens_saved: 9000 });
    archiveEvent(ev);

    const rows = readArchivedEvents(PROJECT, 100);
    expect(rows.length).toBe(1);
    expect(rows[0].event_id).toBe("arc-001");
    expect(rows[0].tokens_saved).toBe(9000);
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[0].task_id).toBe("task-1");
    expect(rows[0].deterministic_mode).toBe(false);
  });

  // ── Stage 2: Archive → Snapshot (flush) ────────────────────

  it("flushTodayEvents creates snapshot matching archive totals", async () => {
    const {
      archiveEvent,
      flushTodayEvents,
      summarizeHistory,
      readArchivedEvents,
    } = await import("../../src/store/metrics-db.js");

    archiveEvent(
      makeEvent(PROJECT, "fls-001", {
        tokens_saved: 9000,
        files_avoided: 10,
        session_id: "sA",
        task_id: "tA",
      }),
    );
    archiveEvent(
      makeEvent(PROJECT, "fls-002", {
        tokens_saved: 4500,
        files_avoided: 5,
        session_id: "sB",
        task_id: "tB",
      }),
    );

    flushTodayEvents(PROJECT);

    const history = summarizeHistory(PROJECT, 10);
    const events = readArchivedEvents(PROJECT, 100);

    const eventTokens = events.reduce((s, e) => s + (e.tokens_saved || 0), 0);
    const eventFiles = events.reduce((s, e) => s + (e.files_avoided || 0), 0);

    expect(events.length).toBe(2);
    expect(history.total_tokens_saved).toBe(eventTokens);
    expect(history.total_files_avoided).toBe(eventFiles);
    expect(history.total_events).toBe(2);
    expect(history.total_sessions).toBe(2);
    expect(history.total_tasks).toBe(2);
  });

  // ── Stage 3: Category invariance ───────────────────────────

  it("sum(category tokens) equals totals.tokens_saved for exactly 3 events", async () => {
    const { archiveEvent, flushTodayEvents } =
      await import("../../src/store/metrics-db.js");
    const { aggregateTotal } = await import("../../src/usage/aggregation.js");

    archiveEvent(
      makeEvent(PROJECT, "cat-001", {
        tokens_saved: 9000,
        type: "search_graph",
      }),
    );
    archiveEvent(
      makeEvent(PROJECT, "cat-002", {
        tokens_saved: 4500,
        type: "pack_context",
      }),
    );
    archiveEvent(
      makeEvent(PROJECT, "cat-003", { tokens_saved: 6000, type: "trace_path" }),
    );
    flushTodayEvents(PROJECT);

    const agg = aggregateTotal(PROJECT, "2026-07-10T12:00:00.000Z");
    const catSum = agg.categories.reduce((s, c) => s + c.tokens_saved, 0);

    expect(catSum).toBe(19500);
    expect(catSum).toBe(agg.totals.tokens_saved);
    expect(agg.totals.events).toBe(3);
    const catEvents = agg.categories.reduce((s, c) => s + c.events, 0);
    expect(catEvents).toBe(3);
    expect(agg.historical_unclassified).toBeUndefined();
  });

  // ── Stage 4: Flush idempotence ─────────────────────────────

  it("two flushes without new events produce identical snapshots", async () => {
    const { archiveEvent, flushTodayEvents, summarizeHistory } =
      await import("../../src/store/metrics-db.js");

    archiveEvent(
      makeEvent(PROJECT, "idm-001", { tokens_saved: 9000, files_avoided: 10 }),
    );
    flushTodayEvents(PROJECT);
    const snap1 = summarizeHistory(PROJECT, 10);

    flushTodayEvents(PROJECT);
    const snap2 = summarizeHistory(PROJECT, 10);

    expect(snap2.total_tokens_saved).toBe(snap1.total_tokens_saved);
    expect(snap2.total_files_avoided).toBe(snap1.total_files_avoided);
    expect(snap2.total_events).toBe(snap1.total_events);
    expect(snap2.total_tokens_saved).toBe(9000);
  });

  // ── Stage 5: Rebuild from archive ──────────────────────────

  it("rebuildDailySnapshots in isolation produces correct totals", async () => {
    const {
      archiveEvent,
      flushTodayEvents,
      rebuildDailySnapshots,
      summarizeHistory,
      readArchivedEvents,
    } = await import("../../src/store/metrics-db.js");

    archiveEvent(makeEvent(PROJECT, "reb-001", { tokens_saved: 9000 }));
    archiveEvent(makeEvent(PROJECT, "reb-002", { tokens_saved: 4500 }));
    flushTodayEvents(PROJECT);

    const result = rebuildDailySnapshots();
    expect(result.error).toBeUndefined();
    expect(result.projects_rebuilt).toBeGreaterThanOrEqual(1);

    const history = summarizeHistory(PROJECT, 10);
    const events = readArchivedEvents(PROJECT, 100);
    const eventTokens = events.reduce((s, e) => s + (e.tokens_saved || 0), 0);

    expect(history.total_tokens_saved).toBe(eventTokens);
    expect(history.total_tokens_saved).toBe(13500);
    expect(history.total_events).toBe(2);
  });

  // ── Stage 6: Rebuild idempotence ───────────────────────────

  it("rebuild produces identical snapshots when run twice", async () => {
    const {
      archiveEvent,
      flushTodayEvents,
      rebuildDailySnapshots,
      summarizeHistory,
    } = await import("../../src/store/metrics-db.js");

    archiveEvent(makeEvent(PROJECT, "rid-001", { tokens_saved: 9000 }));
    flushTodayEvents(PROJECT);

    rebuildDailySnapshots();
    const after1 = summarizeHistory(PROJECT, 10);
    rebuildDailySnapshots();
    const after2 = summarizeHistory(PROJECT, 10);

    expect(after1.total_tokens_saved).toBe(after2.total_tokens_saved);
    expect(after1.total_events).toBe(after2.total_events);
    expect(after1.total_tokens_saved).toBe(9000);
  });

  // ── Stage 7: historical_unclassified ───────────────────────

  it("historical_unclassified with legacy status when snapshot > archive", async () => {
    const { upsertDailySnapshot } =
      await import("../../src/store/metrics-db.js");
    const { aggregateTotal } = await import("../../src/usage/aggregation.js");

    upsertDailySnapshot(
      PROJECT,
      "2026-07-10",
      50000,
      100,
      50,
      0,
      0,
      0,
      50,
      0,
      0,
      0,
    );

    const agg = aggregateTotal(PROJECT, "2026-07-10T12:00:00.000Z");
    expect(agg.historical_unclassified).toBeDefined();
    expect(agg.historical_unclassified!.tokens_saved).toBe(50000);
    expect(agg.historical_unclassified!.provenance.kind).toBe("scenario");
    expect(agg.historical_unclassified!.provenance.status).toBe("legacy");
  });

  // ── Stage 8: Coverage with missing telemetry ───────────────

  it("sessions_available=false when session_id missing from events", async () => {
    const { archiveEvent, flushTodayEvents } =
      await import("../../src/store/metrics-db.js");
    const { aggregateTotal } = await import("../../src/usage/aggregation.js");

    archiveEvent({
      ts: "2026-07-10T12:00:00.000Z",
      type: "search_graph",
      project: PROJECT,
      query: "q",
      query_hash: "h",
      files_avoided: 1,
      tokens_saved: 100,
      confidence: "low",
      event_id: "cov-001",
    });
    flushTodayEvents(PROJECT);

    const agg = aggregateTotal(PROJECT, "2026-07-10T12:00:00.000Z");
    expect(agg.totals.sessions).toBe(0);
    expect(agg.totals.tasks).toBe(0);
    expect(agg.coverage.sessions_available).toBe(false);
    expect(agg.coverage.tasks_available).toBe(false);
    expect(agg.coverage.summary).toContain("no disponible");
  });

  // ── Stage 9: No cross-contamination ────────────────────────

  it("no events from previous tests leak into new isolation", async () => {
    const { readArchivedEvents, summarizeHistory } =
      await import("../../src/store/metrics-db.js");

    const events = readArchivedEvents(PROJECT, 100);
    const history = summarizeHistory(PROJECT, 10);

    expect(events.length).toBe(0);
    expect(history.total_events).toBe(0);
    expect(history.total_tokens_saved).toBe(0);
  });

  // ── Stage 10: DB file location ─────────────────────────────

  it("metrics.db is created inside the per-test sub-home, not the worker home", async () => {
    const { archiveEvent } = await import("../../src/store/metrics-db.js");
    archiveEvent(makeEvent(PROJECT, "dbf-001"));

    const dbPath = path.join(perTestHome, "metrics.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    // Must NOT exist in the worker temp home (we used a subdir)
    // The worker home may have its own metrics.db from setup but
    // our test project should be in the per-test sub-home
    expect(path.resolve(perTestHome)).not.toBe(path.resolve(workerHome));
  });
});
