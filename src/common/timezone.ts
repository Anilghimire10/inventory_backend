/**
 * Day boundaries in a business's own time zone.
 *
 * Every timestamp in the database is UTC, and until now every report cut its
 * days on UTC midnight too. For a shop in Kathmandu that is 05:45 local, so
 * anything rung up between midnight and quarter to six was filed under the
 * previous day -- and the "sales by hour of day" chart, which exists to decide
 * staffing, was displaced by most of a trading day.
 *
 * `Business.timezone` is the fix. These helpers are the JS half of it; the SQL
 * half is `AT TIME ZONE` (see `localDate` / `localHour`). Everything here goes
 * through `Intl`, which carries the IANA database including historical and
 * DST rules, so no dependency and no hand-rolled offset table.
 *
 * The two representations in play:
 *   - an *instant*, a `Date` -- an absolute point in time, what the DB stores;
 *   - a *day key*, `YYYY-MM-DD` -- a calendar date as the shop would read it.
 * A day key is not a `Date` and deliberately has no time attached: converting
 * one back to an instant is only meaningful together with a time zone.
 */

/** Nepal. Where the shops are; the default for every business. */
export const DEFAULT_TIMEZONE = 'Asia/Kathmandu';

/** `YYYY-MM-DD` as the given time zone reads it. Not a `Date`. */
export type DayKey = string;

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(tz, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** What the clock on the wall in `tz` reads at the instant `at`. */
function wallClock(tz: string, at: Date): WallClock {
  const parts = formatterFor(tz).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour12: false` still renders midnight as "24" in some ICU versions.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The instant at which the wall clock in `tz` reads the given local time.
 *
 * Resolved by fixed point rather than by an offset table: guess that the local
 * time is UTC, measure how far off that guess reads in `tz`, correct, then
 * measure once more. The second pass is what makes DST transitions land --
 * the offset at the guessed instant can differ from the offset at the real
 * one, and one correction is enough because offsets change by at most an hour
 * or two. Nepal has no DST, so for the default this settles on the first pass.
 *
 * Local times that a DST spring-forward skips have no instant; the fixed point
 * lands on the moment the clock jumps, which is the only sensible answer.
 */
function instantOf(tz: string, wall: WallClock): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  let ts = asIfUtc;
  for (let pass = 0; pass < 2; pass++) {
    const read = wallClock(tz, new Date(ts));
    const readAsUtc = Date.UTC(
      read.year,
      read.month - 1,
      read.day,
      read.hour,
      read.minute,
      read.second,
    );
    ts = asIfUtc - (readAsUtc - ts);
  }
  return new Date(ts);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar date `at` falls on in `tz`, as `YYYY-MM-DD`. */
export function dayKey(tz: string, at: Date): DayKey {
  const w = wallClock(tz, at);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The hour of the day (0-23) `at` falls in, in `tz`. */
export function hourOfDay(tz: string, at: Date): number {
  return wallClock(tz, at).hour;
}

/**
 * Whether `at` falls in the first `slotMinutes` of `hour` on the wall clock in
 * `tz` -- "is it 8am there yet, and is this the run that should act on it?".
 *
 * For jobs that run every `slotMinutes` and must fire once per business at a
 * local hour. The slot has to be a quarter hour, not a whole one: Nepal is
 * UTC+5:45, so an hourly job at :00 UTC only ever sees 8:45 in Kathmandu.
 * Every real offset is a multiple of 15 minutes, so a 15-minute schedule
 * lands exactly on the hour everywhere, and exactly one run matches per day.
 * An unknown zone falls back to Nepal, like the reports do.
 */
export function isLocalSlot(tz: string, at: Date, hour: number, slotMinutes = 15): boolean {
  let w: WallClock;
  try {
    w = wallClock(tz, at);
  } catch {
    w = wallClock(DEFAULT_TIMEZONE, at);
  }
  return w.hour === hour && w.minute < slotMinutes;
}

/** The instant local midnight began for the day `at` falls on in `tz`. */
export function startOfDay(tz: string, at: Date = new Date()): Date {
  const w = wallClock(tz, at);
  return instantOf(tz, { ...w, hour: 0, minute: 0, second: 0 });
}

/** The instant local midnight begins on the day `key` names in `tz`. */
export function startOfDayKey(tz: string, key: DayKey): Date {
  const [year, month, day] = key.split('-').map(Number);
  return instantOf(tz, { year, month, day, hour: 0, minute: 0, second: 0 });
}

/**
 * `n` days on (or back) from a day key, on the calendar.
 *
 * Calendar arithmetic, not `+ 86_400_000` on an instant: across a DST
 * transition a local day is 23 or 25 hours long, so adding a fixed day to an
 * instant can repeat or skip a date. `Date.UTC` normalises month and year
 * rollover for us, and using UTC here is safe precisely because no time zone
 * is involved -- these are calendar fields, not a moment.
 */
export function addDays(key: DayKey, n: number): DayKey {
  const [year, month, day] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Every day key from `from` to `to` inclusive, for zero-filling a series. */
export function dayKeysBetween(from: DayKey, to: DayKey): DayKey[] {
  const keys: DayKey[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) {
    keys.push(k);
    if (keys.length > 3660) break; // ~10 years; a runaway range shouldn't OOM
  }
  return keys;
}

/**
 * Whether the runtime's IANA database knows this zone.
 *
 * Used to validate what a business sets. A bad zone name would otherwise sit
 * in the column and throw from inside a report weeks later.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
