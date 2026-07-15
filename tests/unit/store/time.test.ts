import { describe, expect, it } from 'vitest';
import {
  parseStoredTimestamp,
  storedTimestampMs,
  utcTodayDateString,
  utcStartOfTodayIso,
} from '../../../src/store/time.js';

describe('SQLite timestamp parsing', () => {
  it('interprets timezone-less SQLite datetime values as UTC', () => {
    expect(parseStoredTimestamp('2026-07-12 13:10:48').toISOString()).toBe(
      '2026-07-12T13:10:48.000Z',
    );
    expect(storedTimestampMs('2026-01-12 13:10:48')).toBe(
      Date.parse('2026-01-12T13:10:48.000Z'),
    );
  });

  it('preserves timestamps that already declare their timezone', () => {
    expect(
      parseStoredTimestamp('2026-07-12T15:10:48+02:00').toISOString(),
    ).toBe('2026-07-12T13:10:48.000Z');
  });
});

describe('utcTodayDateString', () => {
  it('returns YYYY-MM-DD in UTC for a known instant', () => {
    // 2026-07-12 13:10:48 UTC
    const ref = new Date('2026-07-12T13:10:48.000Z');
    expect(utcTodayDateString(ref)).toBe('2026-07-12');
  });

  it('returns the same date before and after midnight UTC', () => {
    const justBefore = new Date('2026-07-12T23:59:59.999Z');
    const justAfter = new Date('2026-07-13T00:00:00.000Z');
    expect(utcTodayDateString(justBefore)).toBe('2026-07-12');
    expect(utcTodayDateString(justAfter)).toBe('2026-07-13');
  });
});

describe('utcStartOfTodayIso', () => {
  it('returns midnight ISO string in UTC', () => {
    const ref = new Date('2026-07-12T13:10:48.000Z');
    expect(utcStartOfTodayIso(ref)).toBe('2026-07-12T00:00:00.000Z');
  });
});