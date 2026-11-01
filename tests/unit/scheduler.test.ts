import { describe, expect, it } from 'vitest';
import { nextRunAt, validateSchedule, describeSchedule, isValidTimezone, zonedTimeToUtc } from '../../src/core/scheduler.js';
import { UdmtError } from '../../src/core/errors.js';

const interval = (minutes: number) => ({
  schedule_type: 'interval' as const,
  schedule_config: { every_minutes: minutes },
  timezone: 'UTC',
});

describe('scheduler', () => {
  it('computes interval runs from the given instant', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(nextRunAt(interval(60), from)?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('moves a passed daily time to the next day', () => {
    const next = nextRunAt(
      { schedule_type: 'daily', schedule_config: { hour: 2, minute: 0 }, timezone: 'UTC' },
      new Date('2026-01-01T03:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-02T02:00:00.000Z');
  });

  it('respects a non-UTC timezone', () => {
    // 08:00 in Asia/Ho_Chi_Minh (UTC+7) = 01:00Z
    const next = nextRunAt(
      { schedule_type: 'daily', schedule_config: { hour: 8, minute: 0 }, timezone: 'Asia/Ho_Chi_Minh' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('computes weekly schedules on the requested weekday', () => {
    // 2026-01-01 is a Thursday; next Monday with hour 9.
    const next = nextRunAt(
      { schedule_type: 'weekly', schedule_config: { days: [1], hour: 9, minute: 0 }, timezone: 'UTC' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-05T09:00:00.000Z');
  });

  it('clamps monthly day 31 to the last day of short months', () => {
    const next = nextRunAt(
      { schedule_type: 'monthly', schedule_config: { day: 31, hour: 2, minute: 0 }, timezone: 'UTC' },
      new Date('2026-02-01T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-02-28T02:00:00.000Z');
  });

  it('returns null for a one-time schedule in the past', () => {
    const next = nextRunAt(
      { schedule_type: 'once', schedule_config: { at: '2020-01-01T00:00:00.000Z' }, timezone: 'UTC' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(next).toBeNull();
  });

  it('handles the DST spring-forward offset', () => {
    // Europe/Berlin jumps from +01:00 to +02:00 on 2026-03-29.
    const next = nextRunAt(
      { schedule_type: 'daily', schedule_config: { hour: 9, minute: 0 }, timezone: 'Europe/Berlin' },
      new Date('2026-03-28T20:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('converts wall clock to UTC', () => {
    expect(zonedTimeToUtc(2026, 6, 1, 12, 0, 'Asia/Ho_Chi_Minh').toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('validates input and timezones', () => {
    expect(isValidTimezone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(() => validateSchedule({ ...interval(0) })).toThrow(UdmtError);
    expect(() =>
      validateSchedule({ schedule_type: 'weekly', schedule_config: { hour: 1, minute: 0, days: [] }, timezone: 'UTC' }),
    ).toThrow(UdmtError);
    expect(() =>
      validateSchedule({ schedule_type: 'interval', schedule_config: { every_minutes: 5 }, timezone: 'Mars/Base' }),
    ).toThrow(UdmtError);
  });

  it('describes schedules for the UI', () => {
    expect(describeSchedule(interval(90))).toContain('every 90 minutes');
  });
});
