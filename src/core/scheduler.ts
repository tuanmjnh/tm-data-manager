import { UdmtError } from './errors.js';
import type { ScheduleRecord } from './types.js';

export interface ScheduleInput {
  schedule_type: ScheduleRecord['schedule_type'];
  schedule_config: Record<string, unknown>;
  timezone: string;
  enabled?: boolean;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  const hour = Number(pick('hour')) % 24;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour,
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
  };
}

/** Converts a wall-clock time in `timezone` to the matching UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = guess;
  for (let i = 0; i < 2; i += 1) {
    const parts = zonedParts(new Date(candidate), timezone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate = guess - (asUtc - candidate);
  }
  return new Date(candidate);
}

export function validateSchedule(input: ScheduleInput): void {
  if (!isValidTimezone(input.timezone)) {
    throw new UdmtError('INVALID_INPUT', `Unknown IANA timezone: ${input.timezone}`);
  }
  const config = input.schedule_config;
  switch (input.schedule_type) {
    case 'once': {
      const at = String(config.at ?? '');
      if (Number.isNaN(new Date(at).getTime())) {
        throw new UdmtError('INVALID_INPUT', 'once schedule requires an ISO timestamp in schedule_config.at');
      }
      return;
    }
    case 'interval': {
      const minutes = Number(config.every_minutes);
      if (!Number.isFinite(minutes) || minutes < 1) {
        throw new UdmtError('INVALID_INPUT', 'interval schedule requires every_minutes >= 1');
      }
      return;
    }
    case 'daily': {
      assertClock(config);
      return;
    }
    case 'weekly': {
      assertClock(config);
      const days = config.days;
      if (!Array.isArray(days) || days.length === 0 || days.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
        throw new UdmtError('INVALID_INPUT', 'weekly schedule requires days: [0..6] (0 = Sunday)');
      }
      return;
    }
    case 'monthly': {
      assertClock(config);
      const day = Number(config.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new UdmtError('INVALID_INPUT', 'monthly schedule requires day between 1 and 31');
      }
      return;
    }
    default:
      throw new UdmtError('CAPABILITY_UNSUPPORTED', `Unsupported schedule type: ${String(input.schedule_type)}`);
  }
}

function assertClock(config: Record<string, unknown>): void {
  const hour = Number(config.hour ?? 0);
  const minute = Number(config.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new UdmtError('INVALID_INPUT', 'schedule hour must be 0..23');
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new UdmtError('INVALID_INPUT', 'schedule minute must be 0..59');
  }
}

/**
 * Computes the next run strictly after `from` (roadmap 10.2/10.3).
 * Iterates calendar days in the target timezone so DST transitions are
 * resolved by the offset of the actual candidate day, not of `from`.
 */
export function nextRunAt(input: ScheduleInput, from: Date = new Date()): Date | null {
  validateSchedule(input);
  const config = input.schedule_config;
  const tz = input.timezone;

  if (input.schedule_type === 'once') {
    const at = new Date(String(config.at));
    return at.getTime() > from.getTime() ? at : null;
  }

  if (input.schedule_type === 'interval') {
    const minutes = Number(config.every_minutes);
    return new Date(from.getTime() + minutes * 60_000);
  }

  const hour = Number(config.hour ?? 0);
  const minute = Number(config.minute ?? 0);
  const start = zonedParts(from, tz);

  // Walk calendar days in the target zone (not UTC) so DST shifts and extreme
  // offsets do not skip or duplicate a day.
  const baseDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= 800; offset += 1) {
    const dayCursor = new Date(baseDay + offset * 86_400_000);
    const year = dayCursor.getUTCFullYear();
    const month = dayCursor.getUTCMonth() + 1;
    const day = dayCursor.getUTCDate();
    const weekday = dayCursor.getUTCDay();

    if (input.schedule_type === 'weekly') {
      const days = (config.days as number[]).map(Number);
      if (!days.includes(weekday)) continue;
    }
    if (input.schedule_type === 'monthly') {
      const wanted = Number(config.day);
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day !== Math.min(wanted, lastDay)) continue;
    }

    const candidate = zonedTimeToUtc(year, month, day, hour, minute, tz);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

export function describeSchedule(input: ScheduleInput): string {
  const config = input.schedule_config;
  switch (input.schedule_type) {
    case 'once':
      return `once at ${String(config.at)}`;
    case 'interval':
      return `every ${Number(config.every_minutes)} minutes`;
    case 'daily':
      return `daily at ${pad(config.hour)}:${pad(config.minute)} (${input.timezone})`;
    case 'weekly': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = (config.days as number[]).map((day) => names[day] ?? String(day)).join(', ');
      return `weekly on ${days} at ${pad(config.hour)}:${pad(config.minute)} (${input.timezone})`;
    }
    case 'monthly':
      return `monthly on day ${Number(config.day)} at ${pad(config.hour)}:${pad(config.minute)} (${input.timezone})`;
    default:
      return String(input.schedule_type);
  }
}

function pad(value: unknown): string {
  return String(Number(value ?? 0)).padStart(2, '0');
}
