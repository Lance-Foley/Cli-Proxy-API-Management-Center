/**
 * Quota dates use America/Chicago.
 *
 * The proxy runs in Central time. The zone name covers both offsets:
 * Central Daylight Time before the first Sunday in November, and Central
 * Standard Time after it. A fixed UTC offset would be wrong for half the year.
 */

export const QUOTA_TIME_ZONE = 'America/Chicago';

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface CentralParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching the timeline column order. */
  weekday: number;
}

const partFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: QUOTA_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function centralParts(ms: number): CentralParts {
  const bag: Record<string, string> = {};
  for (const part of partFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  // A few engines report midnight as 24.
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: WEEKDAY_INDEX[bag.weekday] ?? 0,
  };
}

/**
 * UTC instant for a Central wall-clock time.
 *
 * Asks for midnight and for the 6-hour session marks. Those hours are not
 * inside the 1:00–2:00 fallback, so the clock change does not make them ambiguous.
 */
export function centralWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wallAsUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const seen = centralParts(utc);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second
    );
    const next = wallAsUtc - (seenAsUtc - utc);
    if (next === utc) return utc;
    utc = next;
  }
  return utc;
}

/** Midnight at the start of the Central day that contains `ms`. */
export function startOfCentralDay(ms: number): number {
  const parts = centralParts(ms);
  return centralWallTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0);
}

/** Same Central clock time, `days` calendar days later. */
export function addCentralDays(ms: number, days: number): number {
  const parts = centralParts(ms);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return centralWallTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    parts.hour,
    parts.minute,
    parts.second
  );
}

/** Midnight on the Sunday that opens the Central week containing `ms`. */
export function startOfCentralWeek(ms: number): number {
  const midnight = startOfCentralDay(ms);
  return addCentralDays(midnight, -centralParts(midnight).weekday);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `MM/DD` in Central time. */
export function formatCentralDay(ms: number): string {
  const parts = centralParts(ms);
  return `${pad(parts.month)}/${pad(parts.day)}`;
}

/** `HH:mm` in Central time, 24-hour. */
export function formatCentralTime(ms: number): string {
  const parts = centralParts(ms);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}
