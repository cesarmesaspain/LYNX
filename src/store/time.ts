/**
 * time.ts — Time helpers for values persisted by SQLite.
 *
 * SQLite datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" without an
 * explicit timezone. JavaScript otherwise interprets that shape as local time,
 * producing timezone-dependent freshness and age calculations.
 */

const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function parseStoredTimestamp(value: string): Date {
  const normalized = SQLITE_UTC_TIMESTAMP.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  return new Date(normalized);
}

export function storedTimestampMs(value: string): number {
  return parseStoredTimestamp(value).getTime();
}

/** "2026-07-12" in UTC, used as a partition key so every day is a fresh row. */
export function utcTodayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** "2026-07-12T00:00:00.000Z" — start of today in UTC (ISO 8601). */
export function utcStartOfTodayIso(now: Date = new Date()): string {
  return `${utcTodayDateString(now)}T00:00:00.000Z`;
}
