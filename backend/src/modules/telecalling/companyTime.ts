import type { SqlParam } from '../../db/pool';
import { badRequest } from '../../utils/httpError';

/**
 * The company's day, for every telecalling date filter, "today" and chart bucket.
 *
 * One module so a dashboard card, the chart beside it and the list it opens all count
 * the same rows. Before this, each filter bound `'YYYY-MM-DD 00:00:00'` against UTC
 * columns, so "today" ended at 05:30 in the morning and a call made at 01:00 IST landed
 * on the previous day in one place and on the right day in another.
 *
 * Deliberately local to telecalling rather than imported from `modules/hr`: the two
 * products stay separate (migration 017), and a change to HR's clock must not quietly
 * move a telecalling report.
 *
 * Every `column` argument below is a literal written in code — `'c.started_at'`, never
 * request input. They are interpolated into SQL, which is only safe for that reason.
 */

/* -------------------------------------------------------------------------- */
/* The clock                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The company's clock, as a fixed UTC offset.
 *
 * THIS MATTERS MORE THAN IT LOOKS. `db/pool.ts` pins every connection's session time
 * zone to UTC, so inside MySQL `NOW()` and `CURDATE()` are UTC — which is correct for
 * storing instants and WRONG for a working day.
 *
 * India is UTC+5:30, so the UTC date rolls over at 05:30 local. Filtering "today" with
 * `CURDATE()`, or a `from`/`to` range with UTC midnights, files everything that happens
 * before half past five in the morning against the previous day: an early follow-up
 * shows as yesterday's, an early call is missing from today's tile, and a chart bucket
 * disagrees with the list it opens.
 *
 * A fixed offset rather than the zone name `Asia/Kolkata`, for two reasons: India has
 * never observed daylight saving, so there is nothing a named zone would capture that
 * this does not; and `CONVERT_TZ` with a NAMED zone silently returns NULL unless the
 * MySQL timezone tables have been loaded, which they are not on a default install. A
 * NULL bucket would group every row into one unlabelled bar — but only in production.
 */
export const COMPANY_UTC_OFFSET = '+05:30';
export const COMPANY_OFFSET_MINUTES = 330;

/**
 * The same clock by name, for `Intl` only. ICU carries its own zone data, so the
 * NULL trap above does not apply to formatting text in Node.
 */
export const COMPANY_TIME_ZONE = 'Asia/Kolkata';

const OFFSET_MS = COMPANY_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** Inclusive IST calendar dates, `YYYY-MM-DD`, either end optional. */
export type CompanyDateRange = { from?: string; to?: string };

/* -------------------------------------------------------------------------- */
/* Calendar dates                                                              */
/* -------------------------------------------------------------------------- */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Midnight UTC of a `YYYY-MM-DD` date, as epoch milliseconds — the representation all
 * the calendar arithmetic below works in. Date-only arithmetic in UTC cannot be bent by
 * the server's own zone, which is the trap a `new Date(y, m, d)` would walk into.
 *
 * Throws on a malformed or impossible date (`2026-02-30`). Callers receive dates that
 * Zod has already checked, so reaching the throw is a programming error, not bad input.
 */
function utcMidnight(date: string): number {
  const match = DATE_PATTERN.exec(date);
  const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;

  if (Number.isNaN(ms) || isoDate(ms) !== date) {
    throw new Error(`Not a calendar date: ${JSON.stringify(date)}`);
  }
  return ms;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The IST calendar date of an instant, `YYYY-MM-DD`. Defaults to now. */
export function companyDate(at: Date = new Date()): string {
  return isoDate(at.getTime() + OFFSET_MS);
}

/** Calendar arithmetic on a `YYYY-MM-DD` date. Negative `days` go backwards. */
export function addDays(date: string, days: number): string {
  return isoDate(utcMidnight(date) + Math.trunc(days) * DAY_MS);
}

/** How many calendar days `from` to `to` covers, counting both ends. `from === to` is 1. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS) + 1;
}

/** The Monday on or before `date` — the ISO week start, matching MySQL `WEEKDAY()`. */
export function mondayOf(date: string): string {
  const ms = utcMidnight(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDate(ms - weekday * DAY_MS);
}

/** The first day of `date`'s month. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The last day of `date`'s month. */
export function monthEnd(date: string): string {
  const ms = utcMidnight(monthStart(date));
  const first = new Date(ms);
  return isoDate(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1) - DAY_MS);
}

/* -------------------------------------------------------------------------- */
/* Instants                                                                    */
/* -------------------------------------------------------------------------- */

/** 00:00 IST on `date`, as an instant. */
export function companyDayStart(date: string): Date {
  utcMidnight(date);
  return new Date(`${date}T00:00:00${COMPANY_UTC_OFFSET}`);
}

/**
 * The start of the NEXT IST day — an EXCLUSIVE upper bound.
 *
 * Half-open (`>= start AND < end`) rather than `<= 23:59:59`. The closed form drops
 * anything stamped in the last second's fraction, and it is the form every bug in this
 * area has been written in.
 */
export function companyDayEnd(date: string): Date {
  return companyDayStart(addDays(date, 1));
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A wall-clock time on an IST date, e.g. the daily email's `('2026-10-06', '08:00')`. */
export function companyInstant(date: string, hhmm: string): Date {
  utcMidnight(date);
  if (!TIME_PATTERN.test(hhmm)) throw new Error(`Not a 24-hour HH:MM time: ${JSON.stringify(hhmm)}`);
  return new Date(`${date}T${hhmm}:00${COMPANY_UTC_OFFSET}`);
}

/* -------------------------------------------------------------------------- */
/* SQL predicates                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The half-open instant range an inclusive IST date range means.
 *
 * `end` is the start of the day AFTER `to`. Either side is null when that end of the
 * range is open.
 */
export function companyRangeBounds(range: CompanyDateRange): {
  start: Date | null;
  end: Date | null;
} {
  return {
    start: range.from ? companyDayStart(range.from) : null,
    end: range.to ? companyDayEnd(range.to) : null,
  };
}

/**
 * `['col >= ?', 'col < ?']` for an IST date range, pushing the bounds onto `params`.
 *
 * The bounds are bound as Date objects. The pool's driver option (`timezone: 'Z'`)
 * sends them as UTC wall clock, which compares correctly with the UTC DATETIME columns,
 * and — because the session zone is pinned to +00:00 as well — with the TIMESTAMP
 * columns too (`created_at` on leads, notes and the audit log).
 *
 * Pushes in the order the conditions are returned, so callers that collect conditions
 * and parameters side by side stay aligned.
 */
export function companyRangeConditions(
  column: string,
  range: CompanyDateRange,
  params: SqlParam[],
): string[] {
  const { start, end } = companyRangeBounds(range);
  const conditions: string[] = [];

  if (start) {
    conditions.push(`${column} >= ?`);
    params.push(start);
  }
  if (end) {
    conditions.push(`${column} < ?`);
    params.push(end);
  }

  return conditions;
}

/** The same, as `' AND col >= ? AND col < ?'` — or `''` for an open range. */
export function companyRangeClause(
  column: string,
  range: CompanyDateRange,
  params: SqlParam[],
): string {
  const conditions = companyRangeConditions(column, range, params);
  return conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
}

/**
 * `'(col >= ? AND col < ?)'` for the current IST day, pushing both bounds.
 *
 * Replaces `DATE(col) = CURDATE()`, which is the UTC date inside the pinned pool and
 * also defeats every index on `col`. `now` is injectable so a boundary can be tested.
 */
export function companyTodayCondition(
  column: string,
  params: SqlParam[],
  now: Date = new Date(),
): string {
  const today = companyDate(now);
  params.push(companyDayStart(today), companyDayEnd(today));
  return `(${column} >= ? AND ${column} < ?)`;
}

/**
 * A column's value on the IST wall clock: `CONVERT_TZ(col, '+00:00', '+05:30')`.
 *
 * Numeric offsets need no timezone tables (see the offset note above). The column is a
 * code constant.
 */
export function localSql(column: string): string {
  return `CONVERT_TZ(${column}, '+00:00', '${COMPANY_UTC_OFFSET}')`;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * An instant as IST text for activity lines and notifications: `'08 Oct, 02:30 pm'`.
 *
 * Moved here from the follow-up service with its output unchanged, because timeline
 * summaries are stored as text — a timeline should say what it said when it happened,
 * so the format must not drift between old and new rows. The summary is read by people
 * in one office, and a UTC time in it would be precise and useless.
 */
export function formatCompanyDateTime(value: Date | string): string {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: COMPANY_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* -------------------------------------------------------------------------- */
/* Chart buckets                                                               */
/* -------------------------------------------------------------------------- */

export const GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * The most frames one chart may have.
 *
 * Above this a bar is narrower than a pixel at desktop width, and the zero-filled series
 * is pure payload. Also bounds the work a single request can ask for.
 */
export const MAX_CHART_FRAMES = 400;

const TOO_LONG = 'That period is too long to chart. Choose a shorter range.';

/**
 * The SQL expression that names a row's IST bucket. A closed set, because it is
 * interpolated into SELECT and GROUP BY.
 *
 * The keys match `bucketFrames` exactly, so query rows can be zero-filled by key:
 *
 *   hour   'YYYY-MM-DDTHH:00'
 *   day    'YYYY-MM-DD'
 *   week   the Monday, 'YYYY-MM-DD' — ISO weeks, the same convention as the Reports
 *          screen's '%x-W%v'
 *   month  'YYYY-MM-01'
 */
export function bucketSql(column: string, g: Granularity): string {
  const local = localSql(column);

  switch (g) {
    case 'hour':
      return `DATE_FORMAT(${local}, '%Y-%m-%dT%H:00')`;
    case 'day':
      return `DATE_FORMAT(${local}, '%Y-%m-%d')`;
    case 'week':
      return `DATE_FORMAT(DATE_SUB(DATE(${local}), INTERVAL WEEKDAY(${local}) DAY), '%Y-%m-%d')`;
    case 'month':
      return `DATE_FORMAT(${local}, '%Y-%m-01')`;
  }
}

/**
 * One chart frame: its bucket key, and the inclusive IST dates it covers.
 *
 * `bucket` is the UNCLAMPED key, so it matches what `bucketSql` produces for any row in
 * the frame. `from`/`to` are clamped to the requested range — a week that starts before
 * the range covers only the part inside it — and are what a click on the bar filters
 * the list by, so the list shows exactly the rows the bar counted.
 */
export type BucketFrame = { bucket: string; from: string; to: string };

/**
 * Every frame from `from` to `to`, in ascending order, including the empty ones.
 *
 * A chart must show a quiet day as a zero, not skip it — a series with gaps reads as a
 * steady line over a day nobody worked. Returns `[]` for a reversed range.
 */
export function bucketFrames(from: string, to: string, g: Granularity): BucketFrame[] {
  if (utcMidnight(from) > utcMidnight(to)) return [];

  if (estimatedFrames(g, daysInclusive(from, to)) > MAX_CHART_FRAMES) {
    throw badRequest(TOO_LONG);
  }

  const frames: BucketFrame[] = [];
  const clampFrom = (date: string) => (date < from ? from : date);
  const clampTo = (date: string) => (date > to ? to : date);

  switch (g) {
    case 'hour':
      for (let day = from; day <= to; day = addDays(day, 1)) {
        for (let hour = 0; hour < 24; hour += 1) {
          frames.push({ bucket: `${day}T${String(hour).padStart(2, '0')}:00`, from: day, to: day });
        }
      }
      break;

    case 'day':
      for (let day = from; day <= to; day = addDays(day, 1)) {
        frames.push({ bucket: day, from: day, to: day });
      }
      break;

    case 'week':
      for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) {
        frames.push({ bucket: monday, from: clampFrom(monday), to: clampTo(addDays(monday, 6)) });
      }
      break;

    case 'month':
      for (let first = monthStart(from); first <= to; first = addDays(monthEnd(first), 1)) {
        frames.push({ bucket: first, from: clampFrom(first), to: clampTo(monthEnd(first)) });
      }
      break;
  }

  return frames;
}

/**
 * The most frames a span of `spanDays` consecutive days can produce at `g`.
 *
 * An upper bound rather than an exact count, so it needs only the span: a span touches
 * at most `ceil((n + 6) / 7)` ISO weeks, and — every month having at least 28 days — at
 * most `ceil((n - 1) / 28) + 1` months.
 */
function estimatedFrames(g: Granularity, spanDays: number): number {
  switch (g) {
    case 'hour':
      return spanDays * 24;
    case 'day':
      return spanDays;
    case 'week':
      return Math.ceil((spanDays + 6) / 7);
    case 'month':
      return Math.ceil((spanDays - 1) / 28) + 1;
  }
}

/**
 * The granularity a chart actually uses.
 *
 * `auto`: one day is hourly, up to 45 days daily, up to 270 days weekly, beyond that
 * monthly — the point at which each step would otherwise crowd the axis.
 *
 * An explicit `hour` is honoured only for a span of up to two days (48 bars); a longer
 * one falls back to `day` rather than refusing, because the granularity control is a
 * preference and the range picker is the user's real intent.
 *
 * Whatever was asked for is then made coarser while it would exceed MAX_CHART_FRAMES,
 * and only a range too long even for monthly frames — over thirty years — is refused.
 */
export function resolveGranularity(
  requested: 'auto' | Granularity,
  spanDays: number,
): Granularity {
  const span = Number.isFinite(spanDays) ? Math.max(1, Math.trunc(spanDays)) : 1;

  let resolved: Granularity =
    requested !== 'auto'
      ? requested
      : span === 1
        ? 'hour'
        : span <= 45
          ? 'day'
          : span <= 270
            ? 'week'
            : 'month';

  if (resolved === 'hour' && span > 2) resolved = 'day';

  for (const candidate of GRANULARITIES.slice(GRANULARITIES.indexOf(resolved))) {
    if (estimatedFrames(candidate, span) <= MAX_CHART_FRAMES) return candidate;
  }

  throw badRequest(TOO_LONG);
}
