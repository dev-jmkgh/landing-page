import { logger } from '../../../utils/logger';
import {
  addDays,
  bucketFrames,
  COMPANY_OFFSET_MINUTES,
  COMPANY_UTC_OFFSET,
  companyDate,
  companyDayEnd,
  companyDayStart,
  daysInclusive,
  MAX_CHART_FRAMES,
  resolveGranularity,
  type BucketFrame,
  type Granularity,
} from '../companyTime';
import { LEAD_STATUSES, type LeadStatus } from '../shared.schema';
import {
  callBuckets,
  firstActivity,
  followUpDueSummary,
  leadConvertedBuckets,
  leadCreatedBuckets,
  leadStatusCounts,
  type CallBucketRow,
  type FollowUpDueSummary,
} from './dashboard.repository';
import type { AnalyticsQuery } from './dashboard.schema';

/**
 * The dashboard's trend charts (spec: Admin Module 2).
 *
 * Served by its own endpoint rather than folded into GET /dashboard, on purpose: changing
 * the chart granularity refetches only this, a chart failure cannot blank the tiles, and
 * the tile payload stays the shape its readers already know. The screen sends both
 * requests at once, so it is still one round trip per screen.
 *
 * Every figure agrees with a tile when both are asked about the same range: the queries
 * share the tiles' definitions (company line, five unanswered outcomes, non-archived
 * leads created in the range) and the same IST day bounds. That is also what lets a click
 * on a bar open a list holding exactly the rows it counted.
 */

/** One chart frame's calls. `from`/`to` are the frame's IST dates, clamped to the range. */
export type CallBucket = BucketFrame & {
  total: number;
  answered: number;
  notAnswered: number;
  outgoing: number;
  incoming: number;
  incomingNotAnswered: number;
  /** Answered calls only — a ring is not talk time. */
  talkTimeSeconds: number;
  averageDurationSeconds: number;
};

/** One chart frame's leads: created in it, and marked converted in it. */
export type LeadBucket = BucketFrame & { created: number; converted: number };

export type DashboardAnalytics = {
  /** The offset every bucket is computed in. */
  timezone: string;
  /** The range actually charted, after a missing end was filled in. */
  range: { from: string; to: string };
  /** The granularity actually used, which `auto` resolves to. */
  granularity: Granularity;
  /** One zero-filled entry per frame, oldest first. */
  calls: CallBucket[];
  leads: LeadBucket[];
  /** Every lead status, in LEAD_STATUSES order, zeros included. */
  leadsByStatus: { status: LeadStatus; count: number }[];
  followUps: FollowUpDueSummary;
};

/**
 * How far back a DERIVED start may reach: the longest span that still fits in
 * MAX_CHART_FRAMES monthly frames (every month has at least 28 days), less a frame of
 * margin — a little over thirty years.
 *
 * Only for a start the server chose. "All time" begins at the earliest call, and a
 * handset whose clock had reset can stamp a call in 1970; without this cap that one row
 * would turn the All preset into a permanent "period too long" error. An explicit `from`
 * is never moved — a range the user asked for is charted or refused as asked.
 */
const LONGEST_DERIVED_SPAN_DAYS = (MAX_CHART_FRAMES - 2) * 28;

export async function dashboardAnalytics(
  query: AnalyticsQuery,
  now: Date = new Date(),
): Promise<DashboardAnalytics> {
  const today = companyDate(now);
  const range = await effectiveRange(query, today);
  const granularity = resolveGranularity(query.granularity, daysInclusive(range.from, range.to));
  const frames = bucketFrames(range.from, range.to, granularity);
  const window = { start: companyDayStart(range.from), end: companyDayEnd(range.to) };

  /*
   * The status breakdown and the follow-up summary take the range exactly as requested,
   * open ends and all. The status counts then equal the "Total leads" tile, which is
   * bounded the same way; and with no `to`, follow-ups due in the future count as
   * upcoming instead of being cut off at today.
   */
  const requested = { from: query.from, to: query.to };

  const [callRows, createdRows, convertedRows, statusRows, followUps] = await Promise.all([
    callBuckets(window, granularity, query.userId),
    leadCreatedBuckets(window, granularity, query.userId),
    leadConvertedBuckets(window, granularity, query.userId),
    leadStatusCounts(requested, query.userId),
    followUpDueSummary(requested, query.userId),
  ]);

  const callsByBucket = indexByBucket(callRows, frames, 'calls');
  const createdByBucket = indexByBucket(createdRows, frames, 'leads created');
  const convertedByBucket = indexByBucket(convertedRows, frames, 'conversions');

  let calls = frames.map((frame) => toCallBucket(frame, callsByBucket.get(frame.bucket)));
  let leads: LeadBucket[] = frames.map((frame) => ({
    ...frame,
    created: createdByBucket.get(frame.bucket)?.count ?? 0,
    converted: convertedByBucket.get(frame.bucket)?.count ?? 0,
  }));

  /*
   * Only while the range holds today. A past day has nothing after the current hour to
   * drop, and a range wholly in the future keeps every frame, zero-filled like any other
   * range — trimming there would leave no frames at all, which a client cannot tell from
   * a broken response.
   */
  if (granularity === 'hour' && range.from <= today && today <= range.to) {
    const keep = framesUpToNow(calls, leads, now);
    calls = calls.slice(0, keep);
    leads = leads.slice(0, keep);
  }

  const counts = new Map(statusRows.map((row) => [row.status, row.count]));

  return {
    timezone: COMPANY_UTC_OFFSET,
    range,
    granularity,
    calls,
    leads,
    leadsByStatus: LEAD_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 })),
    followUps,
  };
}

/**
 * The range the charts cover, as inclusive IST dates.
 *
 * A missing `to` is today — or the start itself, for a start in the future, so the range
 * is never reversed. A missing `from` is the day of the first company-line call or lead
 * (for `userId`, theirs), never later than `to` and never further back than the chart can
 * draw.
 */
async function effectiveRange(
  query: AnalyticsQuery,
  today: string,
): Promise<{ from: string; to: string }> {
  const to = query.to ?? (query.from !== undefined && query.from > today ? query.from : today);
  if (query.from !== undefined) return { from: query.from, to };

  const first = await firstActivity(query.userId);
  const earliest = addDays(to, -(LONGEST_DERIVED_SPAN_DAYS - 1));

  let from = first ? companyDate(first) : to;
  if (from > to) from = to;
  if (from < earliest) from = earliest;

  return { from, to };
}

function toCallBucket(frame: BucketFrame, row: CallBucketRow | undefined): CallBucket {
  const answered = row?.answered ?? 0;
  const talkTimeSeconds = row?.talkTimeSeconds ?? 0;

  return {
    ...frame,
    total: row?.total ?? 0,
    answered,
    notAnswered: row?.notAnswered ?? 0,
    outgoing: row?.outgoing ?? 0,
    incoming: row?.incoming ?? 0,
    incomingNotAnswered: row?.incomingNotAnswered ?? 0,
    talkTimeSeconds,
    // Over answered calls only, the definition the tiles and the activity summary use.
    averageDurationSeconds: answered > 0 ? Math.round(talkTimeSeconds / answered) : 0,
  };
}

/**
 * Query rows keyed by bucket, for zero-filling against the frames.
 *
 * `bucketSql` and `bucketFrames` are written to produce identical keys. A row whose key
 * matched no frame would silently vanish from the chart and the bars would stop adding up
 * to the tiles — so if the two ever drift apart, say so in the log.
 */
function indexByBucket<T extends { bucket: string }>(
  rows: T[],
  frames: BucketFrame[],
  series: string,
): Map<string, T> {
  const index = new Map(rows.map((row) => [row.bucket, row]));
  const keys = new Set(frames.map((frame) => frame.bucket));
  const strays = rows.filter((row) => !keys.has(row.bucket)).map((row) => row.bucket);

  if (strays.length > 0) {
    logger.warn('Dashboard chart rows matched no frame', { series, buckets: strays.slice(0, 5) });
  }
  return index;
}

/**
 * How many hourly frames to keep: today's chart stops at the current hour.
 *
 * Trailing frames later than the current IST hour are dropped while they are empty — a
 * run of empty future hours reads as a dead afternoon that has not happened yet. A frame
 * that holds anything is kept, so a call stamped ahead by a fast handset clock still shows
 * and the bars still add up to the tiles.
 */
function framesUpToNow(calls: CallBucket[], leads: LeadBucket[], now: Date): number {
  const currentHour = `${new Date(now.getTime() + COMPANY_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 13)}:00`;

  let keep = calls.length;
  while (keep > 0) {
    const call = calls[keep - 1];
    const lead = leads[keep - 1];
    if (!call || call.bucket <= currentHour) break;
    if (call.total > 0 || (lead !== undefined && (lead.created > 0 || lead.converted > 0))) break;
    keep -= 1;
  }
  return keep;
}
