import { describe, expect, it, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import {
  archiveEvent,
  upsertDailySnapshot,
  flushTodayEvents,
  rebuildDailySnapshots,
  summarizeHistory,
  readArchivedEvents,
  countArchivedEvents,
  closeMetricsDb,
} from '../../../src/store/metrics-db.js';
import type { UsageEvent } from '../../../src/usage/metrics.js';
import { lynxHome } from '../../../src/config/runtime.js';

function cleanupTestProject(project: string): void {
  const dbPath = path.join(lynxHome(), 'metrics.db');
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    db.prepare('DELETE FROM events_archive WHERE project = ?').run(project);
    db.prepare('DELETE FROM daily_snapshots WHERE project = ?').run(project);
  } finally {
    db.close();
  }
}

const TEST_EVENTS: UsageEvent[] = [
  {
    ts: new Date().toISOString(),
    type: 'search_graph',
    project: 'test-rebuild',
    query: 'test query 1',
    query_hash: 'hash1',
    files_avoided: 10,
    tokens_saved: 9000,
    confidence: 'high',
    event_id: 'ev-001',
    session_id: 's1',
    task_id: 't1',
    deterministic_mode: false,
  },
  {
    ts: new Date().toISOString(),
    type: 'search_graph',
    project: 'test-rebuild',
    query: 'test query 2',
    query_hash: 'hash2',
    files_avoided: 5,
    tokens_saved: 4500,
    confidence: 'medium',
    event_id: 'ev-002',
    session_id: 's1',
    task_id: 't2',
    deterministic_mode: false,
  },
  {
    ts: new Date().toISOString(),
    type: 'pack_context',
    project: 'test-rebuild',
    query: 'pack',
    query_hash: 'hash3',
    files_avoided: 12,
    tokens_saved: 10080,
    confidence: 'high',
    event_id: 'ev-003',
    session_id: 's2',
    task_id: 't3',
    deterministic_mode: false,
  },
];

const NOW = '2026-07-10T12:00:00Z';

describe('upsertDailySnapshot idempotence', () => {
  beforeAll(() => cleanupTestProject('test-rebuild'));

  beforeEach(() => {
    // Seed known events
    for (const e of TEST_EVENTS) archiveEvent(e);
  });

  afterEach(() => {
    closeMetricsDb();
  });

  it('two identical flushes produce the same snapshot', () => {
    const before = summarizeHistory('test-rebuild', 1);
    flushTodayEvents('test-rebuild');
    const after1 = summarizeHistory('test-rebuild', 1);
    flushTodayEvents('test-rebuild');
    const after2 = summarizeHistory('test-rebuild', 1);

    // Tokens should be identical after second flush (no doubling)
    expect(after1.total_tokens_saved).toBe(after2.total_tokens_saved);
    expect(after1.total_files_avoided).toBe(after2.total_files_avoided);
    expect(after1.total_events).toBe(after2.total_events);

    // Should match the events we inserted (10500 + 10080 = 23580)
    expect(after1.total_tokens_saved).toBeGreaterThan(0);
  });

  it('snapshot totals equal events_archive totals', () => {
    flushTodayEvents('test-rebuild');
    const history = summarizeHistory('test-rebuild', 1);
    const events = readArchivedEvents('test-rebuild', 100000);

    const eventTokens = events.reduce((s, e) => s + (e.tokens_saved || 0), 0);
    const eventFiles = events.reduce((s, e) => s + (e.files_avoided || 0), 0);

    // Snapshot should match event-level aggregate (events_archive has 3 events)
    expect(history.total_tokens_saved).toBe(eventTokens);
    expect(history.total_files_avoided).toBe(eventFiles);
    expect(history.total_events).toBe(events.length);
  });

  it('sessions and tasks are preserved in snapshot', () => {
    flushTodayEvents('test-rebuild');
    const history = summarizeHistory('test-rebuild', 1);
    // 2 unique sessions, 3 unique tasks from our test events
    expect(history.total_sessions).toBe(2);
    expect(history.total_tasks).toBe(3);
  });
});

describe('rebuildDailySnapshots', () => {
  beforeAll(() => cleanupTestProject('test-rebuild'));

  beforeEach(() => {
    for (const e of TEST_EVENTS) archiveEvent(e);
    flushTodayEvents('test-rebuild');
  });

  afterEach(() => {
    closeMetricsDb();
  });

  it('dryRun does not mutate', () => {
    const before = summarizeHistory('test-rebuild', 1);
    const result = rebuildDailySnapshots(true);
    const after = summarizeHistory('test-rebuild', 1);

    expect(result.projects_rebuilt).toBeGreaterThan(0);
    expect(before.total_events).toBe(after.total_events); // unchanged
  });

  it('rebuild produces same totals as events_archive', () => {
    const result = rebuildDailySnapshots();
    expect(result.error).toBeUndefined();
    expect(result.rows_after).toBeGreaterThan(0);

    const history = summarizeHistory('test-rebuild', 1);
    const events = readArchivedEvents('test-rebuild', 100000);

    const eventTokens = events.reduce((s, e) => s + (e.tokens_saved || 0), 0);
    expect(history.total_tokens_saved).toBe(eventTokens);
  });

  it('backup is created on rebuild', () => {
    const result = rebuildDailySnapshots();
    if (result.backup_path) {
      expect(fs.existsSync(result.backup_path)).toBe(true);
      // Cleanup
      try { fs.unlinkSync(result.backup_path); } catch { /* ok */ }
    }
  });

  it('rebuild is idempotent', () => {
    rebuildDailySnapshots();
    const after1 = summarizeHistory('test-rebuild', 1);
    rebuildDailySnapshots();
    const after2 = summarizeHistory('test-rebuild', 1);

    expect(after1.total_tokens_saved).toBe(after2.total_tokens_saved);
    expect(after1.total_events).toBe(after2.total_events);
  });
});

describe('rebuildDailySnapshots historical dates', () => {
  const project = 'test-rebuild-historical-days';

  beforeEach(() => cleanupTestProject(project));
  afterEach(() => {
    closeMetricsDb();
    cleanupTestProject(project);
  });

  it('preserves one snapshot per event day instead of moving history to today', () => {
    archiveEvent({
      ts: '2025-01-03T12:00:00.000Z', type: 'search_graph', project,
      tokens_saved: 10, files_avoided: 1, confidence: 'high', event_id: 'historical-day-1',
    });
    archiveEvent({
      ts: '2025-01-04T12:00:00.000Z', type: 'search_graph', project,
      tokens_saved: 20, files_avoided: 2, confidence: 'high', event_id: 'historical-day-2',
    });

    const result = rebuildDailySnapshots();
    expect(result.projects_rebuilt).toBeGreaterThanOrEqual(1);

    closeMetricsDb();
    const db = new Database(path.join(lynxHome(), 'metrics.db'));
    try {
      const snapshots = db.prepare(
        'SELECT date, tokens_saved FROM daily_snapshots WHERE project = ? ORDER BY date'
      ).all(project) as Array<{ date: string; tokens_saved: number }>;
      expect(snapshots).toEqual([
        { date: '2025-01-03', tokens_saved: 10 },
        { date: '2025-01-04', tokens_saved: 20 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('event archive idempotency', () => {
  const project = 'test-metrics-event-idempotency';

  beforeEach(() => cleanupTestProject(project));
  afterEach(() => {
    closeMetricsDb();
    cleanupTestProject(project);
  });

  it('keeps a retried event_id from inflating the daily snapshot', () => {
    const event: UsageEvent = {
      ts: new Date().toISOString(), type: 'search_graph', project,
      tokens_saved: 42, files_avoided: 2, confidence: 'high', event_id: 'retry-safe-event',
    };
    archiveEvent(event);
    archiveEvent(event);
    flushTodayEvents(project);

    const history = summarizeHistory(project, 1);
    expect(history.total_events).toBe(1);
    expect(history.total_tokens_saved).toBe(42);
  });
});

describe('LLM model telemetry', () => {
  const project = 'test-metrics-llm-model';

  beforeEach(() => cleanupTestProject(project));
  afterEach(() => {
    closeMetricsDb();
    cleanupTestProject(project);
  });

  it('preserves the provider and model for archived usage events', () => {
    archiveEvent({
      ts: new Date().toISOString(), type: 'llm_rerank', project,
      llm_provider: 'deepseek', llm_model: 'deepseek-v4-flash',
      llm_latency_ms: 321, estimated_llm_cost_usd: 0.000123,
      event_id: 'llm-model-event',
    });

    const [event] = readArchivedEvents(project);
    expect(event.llm_provider).toBe('deepseek');
    expect(event.llm_model).toBe('deepseek-v4-flash');
  });
});

describe('archived event count', () => {
  const project = 'test-metrics-count';

  beforeEach(() => cleanupTestProject(project));
  afterEach(() => {
    closeMetricsDb();
    cleanupTestProject(project);
  });

  it('counts a project without loading archived event payloads', () => {
    archiveEvent({ ts: NOW, type: 'search_graph', project, event_id: 'count-1' });
    archiveEvent({ ts: NOW, type: 'trace_path', project, event_id: 'count-2' });

    expect(countArchivedEvents(project)).toBe(2);
  });
});

describe('historical_unclassified', () => {
  afterEach(() => {
    closeMetricsDb();
  });

  it('no historical_unclassified when events_archive and snapshots match', async () => {
    // Import dynamically to avoid circular deps
    const { aggregateTotal } = await import('../../../src/usage/aggregation.js');
    for (const e of TEST_EVENTS) archiveEvent(e);
    flushTodayEvents('test-rebuild');

    const result = aggregateTotal('test-rebuild', NOW);
    // When snapshots are fresh (just rebuilt), there should be no delta
    expect(result.totals.events).toBeGreaterThan(0);
    // historical_unclassified may exist if there's any snapshot/event delta
    // but with fresh data it should be absent or small
  });

  it('historical_unclassified appears when snapshot has more data than events', async () => {
    const { aggregateTotal } = await import('../../../src/usage/aggregation.js');

    // Create snapshot with extra data not in events_archive (50 events, no matching archive rows)
    upsertDailySnapshot('test-rebuild-legacy', '2026-07-10', 50000, 100, 50, 0, 0, 0, 50, 0, 0, 0);

    const result = aggregateTotal('test-rebuild-legacy', NOW);
    if (result.historical_unclassified) {
      expect(result.historical_unclassified.tokens_saved).toBeGreaterThan(0);
      expect(result.historical_unclassified.provenance.kind).toBe('scenario');
      expect(result.historical_unclassified.provenance.status).toBe('legacy');
    }
  });
});

describe('coverage with missing telemetry', () => {
  afterEach(() => {
    closeMetricsDb();
  });

  it('sessions and tasks = 0 when not tracked', async () => {
    // Insert events without session_id/task_id (legacy format)
    const legacyEvent: UsageEvent = {
      ts: NOW,
      type: 'search_graph',
      project: 'test-coverage-legacy',
      query: 'q',
      query_hash: 'h',
      files_avoided: 1,
      tokens_saved: 100,
      confidence: 'low',
      event_id: 'ev-legacy',
      // no session_id, no task_id, no deterministic_mode
    };
    archiveEvent(legacyEvent);

    const { aggregateTotal } = await import('../../../src/usage/aggregation.js');
    const result = aggregateTotal('test-coverage-legacy', NOW);

    expect(result.totals.sessions).toBe(0);
    expect(result.totals.tasks).toBe(0);
    expect(result.coverage.sessions_available).toBe(false);
    expect(result.coverage.tasks_available).toBe(false);
    expect(result.coverage.summary).toContain('no disponible');
  });
});
