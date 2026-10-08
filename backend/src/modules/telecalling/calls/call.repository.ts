import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import type { OwnershipScope } from '../actor';
import { companyRangeConditions } from '../companyTime';
import type { LeadNoteRecord } from '../leads/lead.repository';
import {
  companyLineSql,
  likeTerm,
  resolvePage,
  UNANSWERED_SQL_LIST,
  type CallChannel,
  type CallDirection,
  type CallLine,
  type CallOutcome,
  type CallSource,
  type LeadStatus,
  type Paginated,
  type SimMatch,
} from '../shared.schema';
import {
  encodeCallCursor,
  MY_CALLS_MAX_PAGE,
  type CallListQuery,
  type MyCallListQuery,
} from './call.schema';

/** Data access for `calls` and `call_recordings`. */

export interface CallRow extends RowDataPacket {
  id: number;
  lead_id: number | null;
  lead_reference: string | null;
  lead_name: string | null;
  user_id: number;
  user_name: string | null;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  duration_seconds: number;
  started_at: Date;
  ended_at: Date | null;
  followed_up: number;
  recorded_at: Date | null;
  lead_status: LeadStatus | null;
  received_on_phone: string | null;
  sim_match: SimMatch | null;
  recording_id: number | null;
  recording_duration: number | null;
  created_at: Date;
}

export type CallRecord = {
  id: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  /**
   * The lead's current status, carried on the call so a list of calls can show it without
   * a second request per row. Null when the call belongs to no lead.
   */
  leadStatus: LeadStatus | null;
  userId: number;
  userName: string | null;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  durationSeconds: number;
  startedAt: string;
  endedAt: string | null;
  followedUp: boolean;
  /**
   * When a telecaller wrote this call up, or null if nobody has.
   *
   * Not the same question as `followedUp`. An incoming call can be dealt with — called
   * back, marked done — without anybody recording what was said, and a call can be
   * written up in full and still need a callback. The Incoming list needs both.
   */
  recordedAt: string | null;
  /**
   * The company number an incoming call arrived on, as it stood on the employee's profile
   * when the call was verified. Stamped by the server from `telecaller_users.company_phone`
   * — never taken from the handset — so it stays right after the SIM is handed to someone
   * else. Null for outgoing calls and for incoming calls nobody could verify.
   */
  receivedOnPhone: string | null;
  /** How the receiving line was verified. Null exactly when `receivedOnPhone` is. */
  simMatch: SimMatch | null;
  /** Whether a recording exists. The storage key is never exposed to a client. */
  hasRecording: boolean;
  recordingId: number | null;
  recordingDuration: number | null;
  createdAt: string;
};

export function toCallRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    leadStatus: row.lead_status,
    userId: row.user_id,
    userName: row.user_name,
    phone: row.phone,
    direction: row.direction,
    outcome: row.outcome,
    channel: row.channel,
    source: row.source,
    durationSeconds: Number(row.duration_seconds),
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    followedUp: row.followed_up === 1,
    recordedAt: row.recorded_at ? row.recorded_at.toISOString() : null,
    receivedOnPhone: row.received_on_phone,
    simMatch: row.sim_match,
    hasRecording: row.recording_id !== null,
    recordingId: row.recording_id,
    recordingDuration: row.recording_duration === null ? null : Number(row.recording_duration),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/*
 * The columns and joins every call read shares, kept apart so a read that needs one more
 * column (the client id, for the employee's own list) adds it without a second copy of
 * the joins to drift from this one. All three joins are one-to-one — a call has at most
 * one lead, one employee and one recording (UNIQUE on call_recordings.call_id) — so they
 * never multiply rows, and a COUNT over them counts calls.
 */
const CALL_COLUMNS = `
  c.id, c.lead_id, l.reference AS lead_reference, l.customer_name AS lead_name,
  c.user_id, u.name AS user_name, c.phone, c.direction, c.outcome, c.channel,
  c.source, c.duration_seconds, c.started_at, c.ended_at, c.followed_up,
  c.recorded_at, l.status AS lead_status, c.received_on_phone, c.sim_match,
  r.id AS recording_id, r.duration_seconds AS recording_duration, c.created_at`;

const CALL_FROM = `
    FROM calls c
    LEFT JOIN leads l ON l.id = c.lead_id
    LEFT JOIN telecaller_users u ON u.id = c.user_id
    LEFT JOIN call_recordings r ON r.call_id = c.id`;

const CALL_SELECT = `SELECT ${CALL_COLUMNS} ${CALL_FROM}`;

/**
 * A request value that ends up interpolated into LIMIT or OFFSET, clamped to a range.
 *
 * Every caller passes a value Zod has already bounded; this is the second line, so a
 * caller that forgets — or a NaN from a bad conversion — produces a bounded query rather
 * than a malformed one.
 */
function bounded(value: number, min: number, max: number, fallback: number): number {
  const whole = Math.trunc(Number(value));
  return Number.isFinite(whole) ? Math.min(Math.max(whole, min), max) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function findCall(id: number, scope: OwnershipScope): Promise<CallRecord | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE c.id = ?';

  if (scope !== null) {
    where += ' AND c.user_id = ?';
    params.push(scope);
  }

  const row = await queryOne<CallRow>(`${CALL_SELECT} ${where} LIMIT 1`, params);
  return row ? toCallRecord(row) : null;
}

export async function findCallByClientUuid(clientUuid: string): Promise<CallRecord | null> {
  const row = await queryOne<CallRow>(`${CALL_SELECT} WHERE c.client_uuid = ? LIMIT 1`, [
    clientUuid,
  ]);
  return row ? toCallRecord(row) : null;
}

export async function findCallByProviderSid(sid: string): Promise<CallRecord | null> {
  const row = await queryOne<CallRow>(`${CALL_SELECT} WHERE c.provider_call_sid = ? LIMIT 1`, [
    sid,
  ]);
  return row ? toCallRecord(row) : null;
}

/**
 * The `q` search every call list shares: the lead's name and reference, the employee's
 * name and — once four digits have been typed — the number with its separators removed.
 * Fewer digits than that would match half the table on any reasonable data set.
 *
 * Pushes its values onto `params` and returns the condition, so a caller collecting
 * conditions and parameters side by side stays aligned.
 */
function callSearchClause(q: string, params: SqlParam[]): string {
  const term = likeTerm(q);
  const digits = q.replace(/\D/g, '');

  if (digits.length >= 4) {
    params.push(term, term, term, `%${digits}%`);
    return `(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?)`;
  }

  params.push(term, term, term);
  return '(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?)';
}

/**
 * The `line` filter as SQL. `company` is `companyLineSql` itself — the single definition
 * of a company-line call — so a list and the dashboard card that opened it cannot count
 * different rows.
 */
function lineCondition(line: CallLine): string | null {
  switch (line) {
    case 'company':
      return companyLineSql('c');
    case 'unverified':
      return "(c.direction = 'incoming' AND c.sim_match IS NULL)";
    case 'all':
      return null;
  }
}

/**
 * An outcome filter as SQL, pushing its value when it has one.
 *
 * The `unanswered` group must never reach the `= ?` branch: bound as a value it matches
 * no row, and the list would say "no calls" instead of failing.
 */
function outcomeCondition(outcome: CallListQuery['outcome'], params: SqlParam[]): string | null {
  if (outcome === undefined) return null;
  if (outcome === 'unanswered') return `c.outcome IN (${UNANSWERED_SQL_LIST})`;
  params.push(outcome);
  return 'c.outcome = ?';
}

function buildCallFilters(
  filters: CallListQuery,
  scope: OwnershipScope,
): { where: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (scope !== null) {
    // A telecaller sees only their own calls. Applied first so no client filter widens it.
    conditions.push('c.user_id = ?');
    params.push(scope);
  } else if (filters.userId) {
    conditions.push('c.user_id = ?');
    params.push(filters.userId);
  }

  const line = lineCondition(filters.line);
  if (line) conditions.push(line);

  if (filters.leadId) {
    conditions.push('c.lead_id = ?');
    params.push(filters.leadId);
  }
  if (filters.direction) {
    conditions.push('c.direction = ?');
    params.push(filters.direction);
  }

  const outcome = outcomeCondition(filters.outcome, params);
  if (outcome) conditions.push(outcome);

  if (filters.channel) {
    conditions.push('c.channel = ?');
    params.push(filters.channel);
  }
  if (filters.withRecording === true) conditions.push('r.id IS NOT NULL');
  if (filters.withRecording === false) conditions.push('r.id IS NULL');

  if (filters.pendingCallback === true) {
    // The callback queue: an unanswered call nobody has come back to yet.
    conditions.push(`c.outcome IN (${UNANSWERED_SQL_LIST})`);
    conditions.push('c.followed_up = 0');
  }

  // IST calendar days, as half-open instant bounds — the same day the dashboard counts.
  conditions.push(...companyRangeConditions('c.started_at', filters, params));

  if (filters.q) conditions.push(callSearchClause(filters.q, params));

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Figures for the WHOLE filtered list, not the page on screen: what lets the Calls
 * screen show the dashboard's talk time and answer rate for the same filters.
 */
export type CallListSummary = {
  answered: number;
  /** Every other outcome. `answered + unanswered === total`. */
  unanswered: number;
  /** Duration of the answered calls only — a ring is not talk time. */
  talkTimeSeconds: number;
};

export type CallListResult = Paginated<CallRecord> & { summary: CallListSummary };

export async function listCalls(
  filters: CallListQuery,
  scope: OwnershipScope,
): Promise<CallListResult> {
  const { where, params } = buildCallFilters(filters, scope);

  /**
   * The count query repeats the joins.
   *
   * They are not decoration: `q` searches the lead name and the employee name, and
   * `withRecording` filters on the recordings join. Counting without them would return
   * a total that disagrees with the page — which shows up as a pager offering a page
   * that turns out to be empty.
   *
   * The summary rides on the same query for the same reason: computed under exactly the
   * WHERE the total is, it cannot describe a different set of calls from the one listed.
   * SUM over no rows is NULL, hence the COALESCE.
   */
  const countRow = await queryOne<
    RowDataPacket & { total: number; answered: number | string; talk_time: number | string }
  >(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(c.outcome = 'answered'), 0) AS answered,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time
       ${CALL_FROM}
       ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const answered = Number(countRow?.answered ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<CallRow>(
    `${CALL_SELECT} ${where} ORDER BY c.started_at DESC, c.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return {
    items: rows.map(toCallRecord),
    page,
    pageSize,
    total,
    totalPages,
    summary: {
      answered,
      unanswered: total - answered,
      talkTimeSeconds: Number(countRow?.talk_time ?? 0),
    },
  };
}

/** One lead's call history, for the detail screen and the timeline. */
export async function listLeadCalls(leadId: number, limit = 100): Promise<CallRecord[]> {
  const rows = await query<CallRow>(
    `${CALL_SELECT} WHERE c.lead_id = ? ORDER BY c.started_at DESC, c.id DESC LIMIT ${bounded(limit, 1, 500, 100)}`,
    [leadId],
  );
  return rows.map(toCallRecord);
}

/**
 * One page of a lead's call history, newest first — the Lead View's calls card.
 *
 * Every call on the lead, legacy unverified incoming ones included. The company-line rule
 * decides what is COUNTED and what the incoming lists show; a lead's history is the record
 * of what happened with that customer, and its timeline already refers to those calls, so
 * hiding them here would make the two contradict each other.
 *
 * Offset-paged with the count on the same predicate (`idx_calls_lead` serves both). An
 * over-large page is clamped to the last one, so a client paging "older calls" stops at
 * `totalPages` and de-duplicates by id when calls arrive meanwhile.
 */
export async function listLeadCallsPage(
  leadId: number,
  page: number,
  pageSize: number,
): Promise<Paginated<CallRecord>> {
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM calls WHERE lead_id = ?',
    [leadId],
  );
  const total = Number(countRow?.total ?? 0);
  const resolved = resolvePage(
    { page: bounded(page, 1, 10_000, 1), pageSize: bounded(pageSize, 1, 100, 20) },
    total,
  );

  const rows = await query<CallRow>(
    `${CALL_SELECT} WHERE c.lead_id = ?
      ORDER BY c.started_at DESC, c.id DESC
      LIMIT ${resolved.pageSize} OFFSET ${resolved.offset}`,
    [leadId],
  );

  return {
    items: rows.map(toCallRecord),
    page: resolved.page,
    pageSize: resolved.pageSize,
    total,
    totalPages: resolved.totalPages,
  };
}

/** Figures over every call on one lead, not just the page of history loaded. */
export type LeadCallSummary = {
  total: number;
  answered: number;
  unanswered: number;
  incoming: number;
  outgoing: number;
  /** Duration of the answered calls only. */
  talkTimeSeconds: number;
  /**
   * Unanswered calls on this lead still waiting in somebody's callback queue — counted
   * with the queue's own rule, company line included, so a lead never claims a callback
   * that no queue shows.
   */
  pendingCallbacks: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
};

/**
 * The Lead View's call figures, in one aggregate over `idx_calls_lead`.
 *
 * `total` and the outcome/direction split cover the same calls `listLeadCallsPage` lists,
 * so "showing N of M" and the summary beside it agree. Computed at query time, like every
 * derived figure here — nothing is stored to go stale.
 */
export async function leadCallSummary(leadId: number): Promise<LeadCallSummary> {
  const row = await queryOne<
    RowDataPacket & {
      total: number;
      answered: number | string;
      incoming: number | string;
      talk_time: number | string;
      pending_callbacks: number | string;
      first_call_at: Date | null;
      last_call_at: Date | null;
    }
  >(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(outcome = 'answered'), 0) AS answered,
            COALESCE(SUM(direction = 'incoming'), 0) AS incoming,
            COALESCE(SUM(CASE WHEN outcome = 'answered' THEN duration_seconds ELSE 0 END), 0) AS talk_time,
            COALESCE(SUM(outcome IN (${UNANSWERED_SQL_LIST}) AND followed_up = 0 AND ${companyLineSql('')}), 0) AS pending_callbacks,
            MIN(started_at) AS first_call_at,
            MAX(started_at) AS last_call_at
       FROM calls
      WHERE lead_id = ?`,
    [leadId],
  );

  const total = Number(row?.total ?? 0);
  const answered = Number(row?.answered ?? 0);
  const incoming = Number(row?.incoming ?? 0);

  return {
    total,
    answered,
    unanswered: total - answered,
    incoming,
    outgoing: total - incoming,
    talkTimeSeconds: Number(row?.talk_time ?? 0),
    pendingCallbacks: Number(row?.pending_callbacks ?? 0),
    firstCallAt: row?.first_call_at ? new Date(row.first_call_at).toISOString() : null,
    lastCallAt: row?.last_call_at ? new Date(row.last_call_at).toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Notes written on a call                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which `lead_notes` rows count as written on call `c`, for alias `n`.
 *
 * One definition shared by the list's latest note and count and the call detail's notes,
 * so the "2 notes" a row shows is the number of notes its detail lists. Two guards:
 *
 *   - the note's lead must be the call's lead. `addLeadNote` once accepted any call id,
 *     so a note can point at another lead's call; it is never shown against that call.
 *     A call with no lead has no notes (they live on leads).
 *   - system notes (the offline-queue anchor written when a lead is created) are
 *     bookkeeping, never something a person wrote about a call.
 */
function callNoteCondition(n: string): string {
  return `${n}.call_id = c.id AND ${n}.lead_id = c.lead_id AND ${n}.kind <> 'system'`;
}

/** The newest note written on a call, cut down to what a list row shows. */
export type CallNoteSummary = {
  id: number;
  kind: 'call_note' | 'note' | 'requirement';
  body: string;
  authorName: string | null;
  createdAt: string;
};

/**
 * The newest note and the note count of each call on one page, keyed by call id.
 *
 * One query for the page, never one per row, and never a join in the list query itself —
 * which is shared with the mobile app and must stay note-free there. Each call is two
 * index probes on `idx_lead_notes_call` (the newest id, and the count), and only the
 * newest body is read: a call written up ten times sends one note, not ten.
 *
 * A call with no notes is simply absent from the map. An empty page costs no query.
 */
export async function listCallNoteSummaries(
  callIds: number[],
): Promise<Map<number, { latest: CallNoteSummary; count: number }>> {
  const summaries = new Map<number, { latest: CallNoteSummary; count: number }>();
  const unique = [...new Set(callIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (unique.length === 0) return summaries;

  const rows = await query<
    RowDataPacket & {
      call_id: number;
      note_count: number | string;
      id: number;
      kind: CallNoteSummary['kind'];
      body: string;
      created_at: Date;
      user_name: string | null;
    }
  >(
    `SELECT latest.call_id, latest.note_count,
            n.id, n.kind, n.body, n.created_at, u.name AS user_name
       FROM (SELECT c.id AS call_id,
                    (SELECT n2.id
                       FROM lead_notes n2
                      WHERE ${callNoteCondition('n2')}
                      ORDER BY n2.created_at DESC, n2.id DESC
                      LIMIT 1) AS note_id,
                    (SELECT COUNT(*)
                       FROM lead_notes n3
                      WHERE ${callNoteCondition('n3')}) AS note_count
               FROM calls c
              WHERE c.id IN (${unique.map(() => '?').join(', ')})) latest
       JOIN lead_notes n ON n.id = latest.note_id
       LEFT JOIN telecaller_users u ON u.id = n.user_id`,
    unique,
  );

  for (const row of rows) {
    summaries.set(row.call_id, {
      latest: {
        id: row.id,
        kind: row.kind,
        body: row.body,
        authorName: row.user_name,
        createdAt: new Date(row.created_at).toISOString(),
      },
      count: Number(row.note_count),
    });
  }

  return summaries;
}

/**
 * The notes written on one call, newest first, at most `limit` of them — the call detail.
 *
 * Bounded so one request can never be unbounded; the caller reports the call's total
 * (the same count `listCallNoteSummaries` gives) beside it, so the cap is never silent.
 */
export async function listCallNotes(callId: number, limit = 50): Promise<LeadNoteRecord[]> {
  const rows = await query<
    RowDataPacket & {
      id: number;
      lead_id: number;
      user_id: number | null;
      user_name: string | null;
      kind: string;
      body: string;
      call_id: number | null;
      created_at: Date;
    }
  >(
    `SELECT n.id, n.lead_id, n.user_id, u.name AS user_name, n.kind, n.body, n.call_id, n.created_at
       FROM calls c
       JOIN lead_notes n ON ${callNoteCondition('n')}
       LEFT JOIN telecaller_users u ON u.id = n.user_id
      WHERE c.id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${bounded(limit, 1, 100, 50)}`,
    [callId],
  );

  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    userId: row.user_id,
    userName: row.user_name,
    kind: row.kind,
    body: row.body,
    callId: row.call_id,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/* My activity: one employee's own calls                                       */
/* -------------------------------------------------------------------------- */

interface OwnCallRow extends CallRow {
  client_uuid: string | null;
}

/** A call as its own employee sees it in My activity: the record plus its client id. */
export type OwnCallRecord = CallRecord & {
  /**
   * The call's own idempotency key — random at dial time for a call made from the app,
   * derived from the call-log row for an imported one. Returned on the employee's OWN
   * calls only, so the handset can recognise a call still waiting in its offline queue
   * once the server has it, and never list it twice.
   */
  clientUuid: string | null;
};

function toOwnCallRecord(row: OwnCallRow): OwnCallRecord {
  return { ...toCallRecord(row), clientUuid: row.client_uuid };
}

/**
 * The filters of My activity, for one employee, as conditions and parameters.
 *
 * Always the employee's own calls, whatever their role: this is "my activity", and a
 * supervisor's list of the whole floor is a different screen. Always the company line,
 * because a personal call has no business in a work history. `withChips` leaves out the
 * two filters the chips choose between (direction, and linked or not), which is what the
 * per-chip counts need: each chip's figure under every OTHER filter.
 */
function buildMyCallFilters(
  userId: number,
  filters: MyCallListQuery,
  withChips: boolean,
): { conditions: string[]; params: SqlParam[] } {
  const conditions: string[] = ['c.user_id = ?', companyLineSql('c')];
  const params: SqlParam[] = [userId];

  if (withChips && filters.direction) {
    conditions.push('c.direction = ?');
    params.push(filters.direction);
  }
  if (withChips && filters.linked !== undefined) {
    conditions.push(filters.linked ? 'c.lead_id IS NOT NULL' : 'c.lead_id IS NULL');
  }

  const outcome = outcomeCondition(filters.outcome, params);
  if (outcome) conditions.push(outcome);

  conditions.push(...companyRangeConditions('c.started_at', filters, params));

  if (filters.q) conditions.push(callSearchClause(filters.q, params));

  return { conditions, params };
}

/**
 * One page of an employee's own calls, newest first, after `filters.cursor`.
 *
 * Keyset paging on (`started_at`, `id`) — the order the list is shown in, with the id
 * breaking ties between calls stamped in the same second. Fetches one row more than the
 * page to learn whether there is a next page, so no COUNT runs per page. The position is
 * written as `started_at <= s AND (started_at < s OR id < i)`: equivalent to "after (s,
 * i)", but with a plain range on `started_at` the indexes on (user_id[, direction],
 * started_at) can serve.
 */
export async function listMyCalls(
  userId: number,
  filters: MyCallListQuery,
): Promise<{ items: OwnCallRecord[]; nextCursor: string | null }> {
  const { conditions, params } = buildMyCallFilters(userId, filters, true);

  if (filters.cursor) {
    conditions.push('c.started_at <= ? AND (c.started_at < ? OR c.id < ?)');
    params.push(filters.cursor.startedAt, filters.cursor.startedAt, filters.cursor.id);
  }

  const limit = bounded(filters.limit, 1, MY_CALLS_MAX_PAGE, 25);

  const rows = await query<OwnCallRow>(
    `SELECT ${CALL_COLUMNS}, c.client_uuid ${CALL_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.started_at DESC, c.id DESC
      LIMIT ${limit + 1}`,
    params,
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: page.map(toOwnCallRecord),
    nextCursor:
      rows.length > limit && last
        ? encodeCallCursor({ startedAt: new Date(last.started_at).toISOString(), id: last.id })
        : null,
  };
}

/** How many of an employee's calls fall under each My activity filter chip. */
export type MyCallCounts = {
  all: number;
  outgoing: number;
  incoming: number;
  /** Filed against a lead. */
  linked: number;
  /** Filed against no lead yet. */
  unlinked: number;
};

/**
 * The chip figures for My activity: every filter except the chips' own, so each figure
 * is what choosing that chip would list. `all === outgoing + incoming === linked +
 * unlinked` by construction.
 */
export async function countMyCalls(userId: number, filters: MyCallListQuery): Promise<MyCallCounts> {
  const { conditions, params } = buildMyCallFilters(userId, filters, false);

  const row = await queryOne<
    RowDataPacket & { all_calls: number; outgoing: number | string; linked: number | string }
  >(
    `SELECT COUNT(*) AS all_calls,
            COALESCE(SUM(c.direction = 'outgoing'), 0) AS outgoing,
            COALESCE(SUM(c.lead_id IS NOT NULL), 0) AS linked
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN telecaller_users u ON u.id = c.user_id
      WHERE ${conditions.join(' AND ')}`,
    params,
  );

  const all = Number(row?.all_calls ?? 0);
  const outgoing = Number(row?.outgoing ?? 0);
  const linked = Number(row?.linked ?? 0);

  return { all, outgoing, incoming: all - outgoing, linked, unlinked: all - linked };
}

/**
 * One call with its client id, under the caller's ownership scope — the call detail.
 *
 * Not filtered to the company line: the detail is reached from a lead's history too,
 * which keeps every call, and a link there must not lead to a "not found".
 */
export async function findOwnCall(id: number, scope: OwnershipScope): Promise<OwnCallRecord | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE c.id = ?';

  if (scope !== null) {
    where += ' AND c.user_id = ?';
    params.push(scope);
  }

  const row = await queryOne<OwnCallRow>(
    `SELECT ${CALL_COLUMNS}, c.client_uuid ${CALL_FROM} ${where} LIMIT 1`,
    params,
  );
  return row ? toOwnCallRecord(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type InsertCallData = {
  clientUuid: string | null;
  leadId: number | null;
  userId: number;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  durationSeconds: number;
  startedAt: Date;
  endedAt: Date | null;
  providerCallSid: string | null;
  /** The company number that took a verified incoming call, from the employee row. */
  receivedOnPhone: string | null;
  /** How that was verified; null for outgoing calls. */
  simMatch: SimMatch | null;
};

export async function insertCallTx(
  connection: PoolConnection,
  data: InsertCallData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO calls
       (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
        duration_seconds, started_at, ended_at, provider_call_sid, received_on_phone, sim_match)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.clientUuid,
      data.leadId,
      data.userId,
      data.phone,
      data.direction,
      data.outcome,
      data.channel,
      data.source,
      data.durationSeconds,
      data.startedAt,
      data.endedAt,
      data.providerCallSid,
      data.receivedOnPhone,
      data.simMatch,
    ],
  );
  return (result as { insertId: number }).insertId;
}

/**
 * Stamps an incoming call that was saved unverified as received on the company line.
 *
 * How the rows uploaded before the check existed are recovered: a current build re-reads
 * the last few days of the call log, re-sends each company-SIM call with the same derived
 * client id, and the replay lands here instead of being stored twice. Every condition is
 * in the WHERE, so this can only ever touch the employee's own unverified incoming row —
 * it cannot re-attribute someone else's call, and it cannot overwrite a verification.
 */
export async function markIncomingLineVerified(
  callId: number,
  userId: number,
  line: { receivedOnPhone: string; simMatch: SimMatch },
): Promise<boolean> {
  const result = await execute(
    `UPDATE calls
        SET received_on_phone = ?, sim_match = ?
      WHERE id = ? AND user_id = ? AND direction = 'incoming' AND sim_match IS NULL`,
    [line.receivedOnPhone, line.simMatch, callId, userId],
  );
  return result.affectedRows > 0;
}

/**
 * Marks a missed call resolved.
 *
 * Scoped to the caller unless they are a supervisor, so a telecaller cannot clear
 * someone else's callback queue.
 */
export async function setCallFollowedUp(
  id: number,
  followedUp: boolean,
  scope: OwnershipScope,
): Promise<boolean> {
  const params: SqlParam[] = [followedUp ? 1 : 0, id];
  let where = 'WHERE id = ?';

  if (scope !== null) {
    where += ' AND user_id = ?';
    params.push(scope);
  }

  const result = await execute(`UPDATE calls SET followed_up = ? ${where}`, params);
  return result.affectedRows > 0;
}

/**
 * Marks every earlier unanswered call to the same number as followed up.
 *
 * Called when a connected call is logged. Without it a telecaller who tried four times
 * before getting through would keep four items in their callback queue for a
 * conversation that has already happened — and would learn to ignore the queue.
 */
export async function resolveEarlierMissedCallsTx(
  connection: PoolConnection,
  userId: number,
  leadId: number | null,
  phone: string,
  before: Date,
): Promise<void> {
  const digits = phone.replace(/\D/g, '');
  const key = digits.length > 9 ? digits.slice(-9) : digits;
  if (key.length < 6) return;

  await connection.execute(
    `UPDATE calls
        SET followed_up = 1
      WHERE user_id = ?
        AND followed_up = 0
        AND outcome IN (${UNANSWERED_SQL_LIST})
        AND started_at < ?
        AND (
             (? IS NOT NULL AND lead_id = ?)
          OR REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
        )`,
    [userId, before, leadId, leadId, `%${key}`],
  );
}

/* -------------------------------------------------------------------------- */
/* Recordings                                                                  */
/* -------------------------------------------------------------------------- */

export type InsertRecordingData = {
  callId: number;
  leadId: number | null;
  userId: number | null;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  provider: string | null;
};

export async function insertRecording(data: InsertRecordingData): Promise<number> {
  const result = await execute(
    `INSERT INTO call_recordings
       (call_id, lead_id, user_id, storage_key, mime_type, size_bytes, duration_seconds,
        origin, provider, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'cloud', ?, NOW())`,
    [
      data.callId,
      data.leadId,
      data.userId,
      data.storageKey,
      data.mimeType,
      data.sizeBytes,
      data.durationSeconds,
      data.provider,
    ],
  );
  return result.insertId;
}

export interface RecordingRow extends RowDataPacket {
  id: number;
  call_id: number;
  lead_id: number | null;
  lead_reference: string | null;
  lead_name: string | null;
  user_id: number | null;
  user_name: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number;
  provider: string | null;
  started_at: Date | null;
  created_at: Date;
}

export type RecordingRecord = {
  id: number;
  callId: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  userId: number | null;
  userName: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  provider: string | null;
  callStartedAt: string | null;
  createdAt: string;
};

/** `storage_key` is read internally and never mapped into the record. */
function toRecordingRecord(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    callId: row.call_id,
    leadId: row.lead_id,
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    userId: row.user_id,
    userName: row.user_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    durationSeconds: Number(row.duration_seconds),
    provider: row.provider,
    callStartedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const RECORDING_SELECT = `
  SELECT r.id, r.call_id, r.lead_id, l.reference AS lead_reference,
         l.customer_name AS lead_name, r.user_id, u.name AS user_name,
         r.storage_key, r.mime_type, r.size_bytes, r.duration_seconds, r.provider,
         c.started_at, r.created_at
    FROM call_recordings r
    LEFT JOIN calls c ON c.id = r.call_id
    LEFT JOIN leads l ON l.id = r.lead_id
    LEFT JOIN telecaller_users u ON u.id = r.user_id
`;

export type RecordingFilters = {
  page: number;
  pageSize: number;
  userId?: number;
  leadId?: number;
  q?: string;
  /** Inclusive IST calendar days on when the recording arrived. */
  from?: string;
  to?: string;
};

export async function listRecordings(
  filters: RecordingFilters,
): Promise<Paginated<RecordingRecord>> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.userId) {
    conditions.push('r.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.leadId) {
    conditions.push('r.lead_id = ?');
    params.push(filters.leadId);
  }
  // The IST day, like every other telecalling date filter (see companyTime.ts).
  conditions.push(...companyRangeConditions('r.created_at', filters, params));
  if (filters.q) {
    const term = likeTerm(filters.q);
    conditions.push('(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?)');
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM call_recordings r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN telecaller_users u ON u.id = r.user_id
       ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<RecordingRow>(
    `${RECORDING_SELECT} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toRecordingRecord), page, pageSize, total, totalPages };
}

/** The storage key, for the authenticated playback route only. */
export async function findRecordingKey(
  id: number,
): Promise<{ key: string; mime: string; leadId: number | null; userId: number | null } | null> {
  const row = await queryOne<
    RowDataPacket & {
      storage_key: string;
      mime_type: string;
      lead_id: number | null;
      user_id: number | null;
    }
  >(
    'SELECT storage_key, mime_type, lead_id, user_id FROM call_recordings WHERE id = ? LIMIT 1',
    [id],
  );

  return row
    ? { key: row.storage_key, mime: row.mime_type, leadId: row.lead_id, userId: row.user_id }
    : null;
}

/* -------------------------------------------------------------------------- */
/* Writing up a call                                                           */
/* -------------------------------------------------------------------------- */

/** A call row as read under the write-up's lock — what the decisions in `recordCall` need. */
export type LockedCall = {
  id: number;
  userId: number;
  leadId: number | null;
  direction: CallDirection;
  /** The key of the last write-up applied to this call, if it carried one. */
  recordClientUuid: string | null;
};

/**
 * Locks one call row FOR UPDATE inside the write-up's transaction and re-reads it.
 *
 * What makes a write-up idempotent under concurrency, not just on a slow retry. Two
 * deliveries of the same write-up — the queue retrying while the first is still in flight
 * — both pass any check made before their transactions; the lock queues the second behind
 * the first, and the second then sees the first's key and applies nothing. It also makes
 * "is this the call's first lead?" a question about the committed row, so two write-ups
 * linking the same call cannot both write the "call logged" line.
 */
export async function lockCallForWriteUpTx(
  connection: PoolConnection,
  callId: number,
): Promise<LockedCall | null> {
  const [rows] = await connection.execute<
    (RowDataPacket & {
      id: number;
      user_id: number;
      lead_id: number | null;
      direction: CallDirection;
      record_client_uuid: string | null;
    })[]
  >(
    'SELECT id, user_id, lead_id, direction, record_client_uuid FROM calls WHERE id = ? FOR UPDATE',
    [callId],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        leadId: row.lead_id,
        direction: row.direction,
        recordClientUuid: row.record_client_uuid,
      }
    : null;
}

/** The call a write-up key was applied to, if it has been. */
export async function findCallIdByRecordClientUuid(clientUuid: string): Promise<number | null> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM calls WHERE record_client_uuid = ? LIMIT 1',
    [clientUuid],
  );
  return row ? row.id : null;
}

/**
 * Writes up an existing call: links it to a lead, corrects what the log got wrong, and
 * stamps it as recorded.
 *
 * Only ever touches columns the telecaller is entitled to change. `lead_id` moves only
 * from NULL — a call already filed against a customer is never re-pointed by this — and
 * the row is matched on its owner (`ownerId`, the call's `user_id`) as well as its id.
 * The caller has already checked the actor may write this call up — their own, or anyone's
 * for a supervisor — and passes the OWNER, not the actor: matching on the actor silently
 * updated nothing when a supervisor wrote up a telecaller's call, while the notes and
 * timeline lines written beside it still landed.
 */
export async function recordCallTx(
  connection: PoolConnection,
  callId: number,
  ownerId: number,
  changes: {
    leadId?: number | null;
    outcome?: CallOutcome;
    durationSeconds?: number;
    /** This write-up booked (or moved) a follow-up on the call — see `followed_up` below. */
    followUpBooked: boolean;
    /** The write-up's idempotency key, remembered on the call; null when it had none. */
    recordClientUuid: string | null;
  },
): Promise<void> {
  const sets: string[] = [
    'recorded_at = CURRENT_TIMESTAMP',
    /*
     * Whether the call still needs someone to come back to it.
     *
     * A written-up INCOMING call has been dealt with. An OUTGOING one has not, merely by
     * being written up — "no answer, try again tomorrow" is still a callback owed —
     * unless the write-up booked a follow-up, which is that callback, scheduled. Before
     * this every write-up set the flag, and an unanswered outgoing call dropped out of
     * the callback queue the moment anyone typed a note about it.
     */
    "followed_up = CASE WHEN direction = 'incoming' OR ? THEN 1 ELSE followed_up END",
  ];
  const params: SqlParam[] = [changes.followUpBooked ? 1 : 0];

  if (changes.recordClientUuid) {
    sets.push('record_client_uuid = ?');
    params.push(changes.recordClientUuid);
  }

  if (changes.leadId !== undefined && changes.leadId !== null) {
    /*
     * The guard is on the column, not in the WHERE clause.
     *
     * `AND lead_id IS NULL` there would drop the whole update — outcome, duration and
     * the recorded stamp with it — whenever the call already had a lead. `IFNULL` keeps
     * the rest of the write and makes re-attaching a no-op instead of a refusal.
     */
    sets.push('lead_id = IFNULL(lead_id, ?)');
    params.push(changes.leadId);
  }

  if (changes.outcome !== undefined) {
    sets.push('outcome = ?');
    params.push(changes.outcome);
  }

  if (changes.durationSeconds !== undefined) {
    sets.push('duration_seconds = ?');
    params.push(changes.durationSeconds);
  }

  params.push(callId, ownerId);

  await connection.execute(
    `UPDATE calls SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    params,
  );
}

/**
 * Attaches the actor's unattached calls from this number to a lead that has just been created.
 *
 * WHY THIS EXISTS
 * ---------------
 * `logCall` already matches an incoming call to a lead by phone number, so a call that
 * arrives AFTER the lead exists attaches itself. The reverse order has no such path: a
 * customer rings a number nobody has a lead for, the call is stored with `lead_id NULL`,
 * and the employee then taps "Create lead" on it. Without this the new lead would open
 * with an empty history despite having been created from a conversation.
 *
 * WHY IT CANNOT STEAL A CALL
 * --------------------------
 * `lead_id IS NULL` means only calls that belong to no lead are eligible — a call already
 * filed against a customer is never re-pointed, so creating a lead can never move history
 * out of another lead's record. `user_id = ?` restricts it to the actor's own calls, so a
 * new lead cannot absorb a colleague's conversations. Both conditions are in the WHERE
 * clause rather than checked in application code, because this runs inside the lead's
 * creation transaction and a missed check there would be a silent data leak.
 *
 * Only calls on the company line are adopted (`companyLineSql`). An incoming row saved
 * before the company-SIM check existed cannot be told apart from a personal call, and is
 * hidden everywhere by default; pulling it into a brand-new lead would put it back on a
 * customer's record and into every count that lead takes part in.
 *
 * Matching is the trailing nine digits, the same key `resolveEarlierMissedCallsTx` and the
 * server's `phoneMatchKey` use: the call log writes `+919876543210` where the lead form
 * was given `9876543210`, and an exact comparison would find nothing in the common case.
 *
 * Adopted calls are marked followed up, but deliberately NOT marked recorded.
 *
 * Those are different claims and an earlier version made both. Creating the lead deals
 * with the call — the telecaller has acted, so the row should stop demanding attention —
 * but it says nothing about what was discussed. Stamping `recorded_at` here asserted that
 * somebody had written the call up when nobody had, and it did it in bulk: create one
 * lead and every historical call from that number silently became "record added" with no
 * note behind it, so the Incoming list stopped asking for the very thing the business
 * wants collected.
 *
 * A detected call is evidence that a conversation happened. Only a person can say what
 * was said, and until one has, these stay unrecorded.
 *
 * Returns how many calls were adopted, so the caller can decide whether the lead's
 * timeline deserves a line about it.
 */
export async function adoptOrphanCallsTx(
  connection: PoolConnection,
  userId: number,
  leadId: number,
  phones: (string | null | undefined)[],
): Promise<number> {
  const keys = phones
    .map((phone) => {
      const digits = (phone ?? '').replace(/\D/g, '');
      return digits.length > 9 ? digits.slice(-9) : digits;
    })
    // Six digits is the shortest thing worth matching on. Below that a LIKE '%...' would
    // sweep up unrelated numbers, and adopting the wrong call is worse than adopting none.
    .filter((key) => key.length >= 6);

  if (keys.length === 0) return 0;

  const clause = keys
    .map(
      () =>
        `REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?`,
    )
    .join(' OR ');

  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE calls
        SET lead_id = ?,
            followed_up = 1
      WHERE user_id = ?
        AND lead_id IS NULL
        AND ${companyLineSql('')}
        AND (${clause})`,
    [leadId, userId, ...keys.map((key) => `%${key}`)],
  );

  return result.affectedRows;
}
