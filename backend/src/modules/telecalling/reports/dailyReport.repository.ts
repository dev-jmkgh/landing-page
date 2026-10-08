import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
} from '../../../db/pool';
import {
  CLOSED_LEAD_STATUSES,
  companyLineSql,
  resolvePage,
  UNANSWERED_SQL_LIST,
  type Paginated,
  type Pagination,
} from '../shared.schema';
import {
  REPORT_AUDIENCES,
  REPORT_FAILURE_REASONS,
  type ReportAudience,
  type ReportFailureReason,
  type ReportRunRecord,
  type ReportRunStatus,
  type ReportTrigger,
} from './dailyReport.schema';

/**
 * SQL for the daily report: the day's figures, the live backlog, and the `report_runs`
 * claim protocol.
 *
 * Every day figure takes a half-open instant window (`>= start AND < end`), bound as JS
 * Dates — the pool writes them as UTC, which compares correctly with the UTC DATETIME
 * columns and, because the session zone is pinned to UTC too, with the TIMESTAMP ones.
 *
 * Every call figure is restricted to the company line (`companyLineSql`): an unverified
 * incoming call may be a personal call on a second SIM, and it must not reach a report
 * the owner reads as the business's day.
 */

/** One IST day as instants: `>= start AND < end`. */
export type ReportWindow = { start: Date; end: Date };

/**
 * `SUM(condition)` is NULL over no rows and may arrive as a DECIMAL string. Either would
 * reach the email as "null" or "0.0000".
 */
function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A DATETIME read back as a Date. The pool returns Dates already (UTC, `timezone: 'Z'`);
 * a string here would be a driver configured differently, and `new Date('2026-01-14
 * 08:00:00')` parses as LOCAL time, so it is read explicitly as UTC instead.
 */
function utcDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Now, by the database's clock.
 *
 * Two API servers with skewed clocks still agree on which day is due and whether a lease
 * has expired, because both ask the one database.
 */
export async function databaseNow(): Promise<Date> {
  const row = await queryOne<RowDataPacket & { now: unknown }>('SELECT UTC_TIMESTAMP() AS now');
  return row ? utcDate(row.now) : new Date();
}

/* -------------------------------------------------------------------------- */
/* Day figures                                                                 */
/* -------------------------------------------------------------------------- */

export type DayCallTotals = {
  total: number;
  answered: number;
  notAnswered: number;
  outgoing: number;
  incoming: number;
  incomingMissed: number;
  talkTimeSeconds: number;
  leadsContacted: number;
  leadsAttempted: number;
};

/**
 * The day's calls in one scan of `idx_calls_started_cover`.
 *
 * The definitions are the dashboard's: "not answered" is the closed unanswered set, a
 * missed incoming call is any incoming call not answered, talk time counts answered calls
 * only, and a lead is "reached" by an answered call — distinct leads, so ringing one
 * customer six times reached one lead. Calls to numbers that are not leads have no
 * `lead_id` and so never count as a lead attempted.
 */
export async function dailyCallTotals(window: ReportWindow): Promise<DayCallTotals> {
  const row = await queryOne<
    RowDataPacket & {
      total: unknown;
      answered: unknown;
      not_answered: unknown;
      outgoing: unknown;
      incoming: unknown;
      incoming_missed: unknown;
      talk_time: unknown;
      leads_contacted: unknown;
      leads_attempted: unknown;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome IN (${UNANSWERED_SQL_LIST})) AS not_answered,
            SUM(c.direction = 'outgoing') AS outgoing,
            SUM(c.direction = 'incoming') AS incoming,
            SUM(c.direction = 'incoming' AND c.outcome <> 'answered') AS incoming_missed,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time,
            COUNT(DISTINCT CASE WHEN c.outcome = 'answered' THEN c.lead_id END) AS leads_contacted,
            COUNT(DISTINCT c.lead_id) AS leads_attempted
       FROM calls c
      WHERE c.started_at >= ? AND c.started_at < ?
        AND ${companyLineSql('c')}`,
    [window.start, window.end],
  );

  return {
    total: num(row?.total),
    answered: num(row?.answered),
    notAnswered: num(row?.not_answered),
    outgoing: num(row?.outgoing),
    incoming: num(row?.incoming),
    incomingMissed: num(row?.incoming_missed),
    talkTimeSeconds: num(row?.talk_time),
    leadsContacted: num(row?.leads_contacted),
    leadsAttempted: num(row?.leads_attempted),
  };
}

/**
 * Leads created that day (archived ones excluded, as on the dashboard) and leads
 * converted that day — by `converted_at`, the same definition as the per-employee
 * "converted" column, so the total and the team table agree.
 */
export async function dailyLeadTotals(
  window: ReportWindow,
): Promise<{ created: number; converted: number }> {
  const row = await queryOne<RowDataPacket & { created: unknown; converted: unknown }>(
    `SELECT
       (SELECT COUNT(*) FROM leads
         WHERE is_archived = 0 AND created_at >= ? AND created_at < ?) AS created,
       (SELECT COUNT(*) FROM leads
         WHERE status = 'converted' AND converted_at >= ? AND converted_at < ?) AS converted`,
    [window.start, window.end, window.start, window.end],
  );

  return { created: num(row?.created), converted: num(row?.converted) };
}

export type DayFollowUpTotals = {
  scheduled: number;
  due: number;
  completed: number;
  completedOnTime: number;
  completedLate: number;
  pending: number;
  overdue: number;
};

/**
 * The day's follow-up figures, each its own index range scan (migration 024 indexed
 * `created_at`, `(due_at, state, completed_at)` and `(state, completed_at)` for exactly
 * these).
 *
 * `scheduled` counts bookings made that day whatever became of them. `due` leaves out
 * cancelled ones — a cancelled commitment was not owed. `pending` and `overdue` are live,
 * as at `asOf`: what is still owed does not depend on which day the report is about.
 */
export async function dailyFollowUpTotals(
  window: ReportWindow,
  asOf: Date,
): Promise<DayFollowUpTotals> {
  const row = await queryOne<
    RowDataPacket & {
      scheduled: unknown;
      due: unknown;
      completed: unknown;
      completed_on_time: unknown;
      pending: unknown;
      overdue: unknown;
    }
  >(
    `SELECT
       (SELECT COUNT(*) FROM follow_ups
         WHERE created_at >= ? AND created_at < ?) AS scheduled,
       (SELECT COUNT(*) FROM follow_ups
         WHERE due_at >= ? AND due_at < ? AND state <> 'cancelled') AS due,
       (SELECT COUNT(*) FROM follow_ups
         WHERE state = 'completed' AND completed_at >= ? AND completed_at < ?) AS completed,
       (SELECT COUNT(*) FROM follow_ups
         WHERE state = 'completed' AND completed_at >= ? AND completed_at < ?
           AND completed_at <= due_at) AS completed_on_time,
       (SELECT COUNT(*) FROM follow_ups WHERE state = 'pending') AS pending,
       (SELECT COUNT(*) FROM follow_ups WHERE state = 'pending' AND due_at < ?) AS overdue`,
    [
      window.start,
      window.end,
      window.start,
      window.end,
      window.start,
      window.end,
      window.start,
      window.end,
      asOf,
    ],
  );

  const completed = num(row?.completed);
  const completedOnTime = num(row?.completed_on_time);

  return {
    scheduled: num(row?.scheduled),
    due: num(row?.due),
    completed,
    completedOnTime,
    completedLate: Math.max(completed - completedOnTime, 0),
    pending: num(row?.pending),
    overdue: num(row?.overdue),
  };
}

/** `'converted','lost',...` for `status NOT IN (...)`. Built from the closed tuple, never input. */
const CLOSED_STATUS_SQL_LIST = CLOSED_LEAD_STATUSES.map((status) => `'${status}'`).join(',');

export type LiveBacklog = {
  unassignedLeads: number;
  openLeads: number;
  pendingCallbacks: number;
  activeEmployees: number;
};

/**
 * Work waiting right now, whatever day the report covers.
 *
 * `pendingCallbacks` is the callback queue's own predicate — an unanswered call nobody has
 * come back to — on the company line, the same rows the callback list shows.
 */
export async function liveBacklog(): Promise<LiveBacklog> {
  const row = await queryOne<
    RowDataPacket & {
      unassigned_leads: unknown;
      open_leads: unknown;
      pending_callbacks: unknown;
      active_employees: unknown;
    }
  >(
    `SELECT
       (SELECT COUNT(*) FROM leads
         WHERE is_archived = 0 AND assigned_to IS NULL) AS unassigned_leads,
       (SELECT COUNT(*) FROM leads
         WHERE is_archived = 0 AND status NOT IN (${CLOSED_STATUS_SQL_LIST})) AS open_leads,
       (SELECT COUNT(*) FROM calls c
         WHERE c.followed_up = 0
           AND c.outcome IN (${UNANSWERED_SQL_LIST})
           AND ${companyLineSql('c')}) AS pending_callbacks,
       (SELECT COUNT(*) FROM telecaller_users
         WHERE approval_status = 'approved' AND is_active = 1) AS active_employees`,
  );

  return {
    unassignedLeads: num(row?.unassigned_leads),
    openLeads: num(row?.open_leads),
    pendingCallbacks: num(row?.pending_callbacks),
    activeEmployees: num(row?.active_employees),
  };
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

interface ReportRunRow extends RowDataPacket {
  id: number;
  report_date: string;
  trigger_kind: ReportTrigger;
  status: ReportRunStatus;
  failure_reason: string | null;
  error: string | null;
  attempts: number;
  claim_token: string;
  claimed_at: Date;
  lease_expires_at: Date;
  finished_at: Date | null;
  recipient_count: number;
  delivered_count: number;
  requested_by: number | null;
  requested_by_label: string | null;
  audience: string | null;
}

/**
 * A run as this module reasons about it, including the claim token and lease that decide
 * who may act on it. Never sent to a client — `toReportRunRecord` is the public shape.
 */
export type StoredReportRun = {
  id: number;
  reportDate: string;
  trigger: ReportTrigger;
  status: ReportRunStatus;
  attempts: number;
  recipientCount: number;
  deliveredCount: number;
  failureReason: ReportFailureReason | null;
  error: string | null;
  requestedBy: number | null;
  requestedByLabel: string | null;
  audience: ReportAudience;
  claimToken: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
  finishedAt: Date | null;
};

/*
 * `report_date` through DATE_FORMAT: a bare DATE becomes a Date at midnight UTC and then
 * prints as the previous day anywhere east of Greenwich. The audience comes out of the
 * `summary` JSON — MySQL stores JSON natively and MariaDB as text, and JSON_EXTRACT reads
 * both.
 */
const RUN_COLUMNS = `id, DATE_FORMAT(report_date, '%Y-%m-%d') AS report_date, trigger_kind, status,
       failure_reason, error, attempts, claim_token, claimed_at, lease_expires_at, finished_at,
       recipient_count, delivered_count, requested_by, requested_by_label,
       JSON_UNQUOTE(JSON_EXTRACT(summary, '$.audience')) AS audience`;

function toStoredRun(row: ReportRunRow): StoredReportRun {
  const failureReason = (REPORT_FAILURE_REASONS as readonly string[]).includes(row.failure_reason ?? '')
    ? (row.failure_reason as ReportFailureReason)
    : null;
  const audience = (REPORT_AUDIENCES as readonly string[]).includes(row.audience ?? '')
    ? (row.audience as ReportAudience)
    : 'recipients';

  return {
    id: row.id,
    reportDate: row.report_date,
    trigger: row.trigger_kind,
    status: row.status,
    attempts: num(row.attempts),
    recipientCount: num(row.recipient_count),
    deliveredCount: num(row.delivered_count),
    failureReason,
    error: row.error,
    requestedBy: row.requested_by,
    requestedByLabel: row.requested_by_label,
    audience,
    claimToken: row.claim_token,
    claimedAt: utcDate(row.claimed_at),
    leaseExpiresAt: utcDate(row.lease_expires_at),
    finishedAt: row.finished_at === null ? null : utcDate(row.finished_at),
  };
}

/** The public shape: no claim token, no lease, timestamps as ISO strings. */
export function toReportRunRecord(run: StoredReportRun): ReportRunRecord {
  return {
    id: run.id,
    reportDate: run.reportDate,
    trigger: run.trigger,
    status: run.status,
    attempts: run.attempts,
    recipientCount: run.recipientCount,
    deliveredCount: run.deliveredCount,
    failureReason: run.failureReason,
    error: run.error,
    requestedByLabel: run.requestedByLabel,
    toMe: run.audience === 'requester',
    claimedAt: run.claimedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/** The columns are SMALLINT UNSIGNED; a count is clamped rather than failing the write. */
function smallCount(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 65_535);
}

export async function findReportRun(id: number): Promise<StoredReportRun | null> {
  const row = await queryOne<ReportRunRow>(
    `SELECT ${RUN_COLUMNS} FROM report_runs WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toStoredRun(row) : null;
}

/** The one scheduled run for a day, through `uq_report_runs_one_scheduled`. */
export async function findScheduledRun(
  reportType: string,
  reportDate: string,
): Promise<StoredReportRun | null> {
  const row = await queryOne<ReportRunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM report_runs
      WHERE report_type = ? AND scheduled_date = ?
      LIMIT 1`,
    [reportType, reportDate],
  );
  return row ? toStoredRun(row) : null;
}

/** A fresh claim: a new token, who holds it (diagnostic only), and until when. */
export type RunClaim = {
  token: string;
  claimedBy: string;
  claimedAt: Date;
  leaseUntil: Date;
};

/**
 * Claims a day's scheduled run by inserting its row.
 *
 * Returns null when the row already exists: another process claimed the day first, and
 * the unique key — not timing, not a lock — is what decided it.
 */
export async function insertScheduledClaim(
  reportType: string,
  reportDate: string,
  claim: RunClaim,
): Promise<number | null> {
  try {
    const result = await execute(
      `INSERT INTO report_runs
         (report_type, report_date, trigger_kind, status, attempts,
          claim_token, claimed_by, claimed_at, lease_expires_at)
       VALUES (?, ?, 'scheduled', 'claimed', 1, ?, ?, ?, ?)`,
      [reportType, reportDate, claim.token, claim.claimedBy, claim.claimedAt, claim.leaseUntil],
    );
    return result.insertId;
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

/**
 * Takes over an existing scheduled run — one whose owner died before sending, or one that
 * failed in a way that is safe to repeat.
 *
 * A compare-and-swap on the status and token the caller read: every transition either
 * changes the status or issues a new token, so if anyone else acted on the row in the
 * meantime this matches nothing and the caller backs off.
 */
export async function reclaimRun(
  id: number,
  expected: { status: ReportRunStatus; token: string },
  claim: RunClaim,
): Promise<boolean> {
  const result = await execute(
    `UPDATE report_runs
        SET status = 'claimed', attempts = attempts + 1,
            claim_token = ?, claimed_by = ?, claimed_at = ?, lease_expires_at = ?,
            failure_reason = NULL, error = NULL, finished_at = NULL,
            recipient_count = 0, delivered_count = 0, summary = NULL
      WHERE id = ? AND status = ? AND claim_token = ?`,
    [
      claim.token,
      claim.claimedBy,
      claim.claimedAt,
      claim.leaseUntil,
      id,
      expected.status,
      expected.token,
    ],
  );
  return result.affectedRows === 1;
}

/**
 * The manual runs for a day since `since`, row-locked.
 *
 * `FOR UPDATE` over the `(report_type, report_date)` index range also locks the gap a
 * new row for that day would go into, so two sends racing for the same day cannot both
 * see none: the second waits for the first to commit and then sees its row, or — if both
 * saw an empty range — InnoDB refuses one of the inserts as a deadlock, which the error
 * handler answers with "please try again".
 */
export async function lockRecentManualRunsTx(
  connection: PoolConnection,
  reportType: string,
  reportDate: string,
  since: Date,
): Promise<{ id: number; requestedBy: number | null; audience: ReportAudience }[]> {
  const [rows] = await connection.execute<
    (RowDataPacket & { id: number; requested_by: number | null; audience: string | null })[]
  >(
    `SELECT id, requested_by, JSON_UNQUOTE(JSON_EXTRACT(summary, '$.audience')) AS audience
       FROM report_runs
      WHERE report_type = ? AND report_date = ?
        AND trigger_kind = 'manual' AND claimed_at >= ?
      FOR UPDATE`,
    [reportType, reportDate, since],
  );

  return rows.map((row) => ({
    id: row.id,
    requestedBy: row.requested_by,
    audience: row.audience === 'requester' ? 'requester' : 'recipients',
  }));
}

/**
 * Records a manual send as a run of its own.
 *
 * Manual rows have no `scheduled_date`, so they never take, block or duplicate the
 * scheduled run for the same day. The audience goes into `summary` now, before anything
 * is generated, so the resend guard can see it.
 */
export async function insertManualRunTx(
  connection: PoolConnection,
  input: {
    reportType: string;
    reportDate: string;
    audience: ReportAudience;
    claim: RunClaim;
    requestedBy: number;
    requestedByLabel: string;
  },
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO report_runs
       (report_type, report_date, trigger_kind, status, attempts,
        claim_token, claimed_by, claimed_at, lease_expires_at,
        requested_by, requested_by_label, summary)
     VALUES (?, ?, 'manual', 'claimed', 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.reportType,
      input.reportDate,
      input.claim.token,
      input.claim.claimedBy,
      input.claim.claimedAt,
      input.claim.leaseUntil,
      input.requestedBy,
      input.requestedByLabel.slice(0, 190),
      JSON.stringify({ audience: input.audience }),
    ],
  );
  return result.insertId;
}

/**
 * Claimed → sending, extending the lease and recording what is about to be sent.
 *
 * False means the claim was lost — another process took the run over while this one was
 * generating — and the caller must NOT talk to the mail server. Once a row is 'sending'
 * nobody can take it over: a dead sender is closed as interrupted, never resent.
 */
export async function markRunSending(
  id: number,
  token: string,
  leaseUntil: Date,
  recipientCount: number,
  summary: string,
): Promise<boolean> {
  const result = await execute(
    `UPDATE report_runs
        SET status = 'sending', lease_expires_at = ?, recipient_count = ?, summary = ?
      WHERE id = ? AND claim_token = ? AND status = 'claimed'`,
    [leaseUntil, smallCount(recipientCount), summary, id, token],
  );
  return result.affectedRows === 1;
}

export type RunFinish = {
  status: 'sent' | 'partial' | 'failed' | 'skipped';
  recipientCount: number;
  deliveredCount: number;
  failureReason: ReportFailureReason | null;
  error: string | null;
  finishedAt: Date;
};

/**
 * Records how a run ended. Matched on the token alone: only the run's owner holds it, so
 * an owner that finishes after being marked interrupted still writes the real outcome —
 * which is more accurate than the guess.
 */
export async function finishRun(id: number, token: string, finish: RunFinish): Promise<boolean> {
  const result = await execute(
    `UPDATE report_runs
        SET status = ?, recipient_count = ?, delivered_count = ?,
            failure_reason = ?, error = ?, finished_at = ?
      WHERE id = ? AND claim_token = ?`,
    [
      finish.status,
      smallCount(finish.recipientCount),
      smallCount(finish.deliveredCount),
      finish.failureReason,
      finish.error?.slice(0, 255) ?? null,
      finish.finishedAt,
      id,
      token,
    ],
  );
  return result.affectedRows === 1;
}

/** Closes a run whose sender died mid-send. It is never resent — see `markRunSending`. */
export async function markRunInterrupted(
  id: number,
  token: string,
  now: Date,
  error: string,
): Promise<boolean> {
  const result = await execute(
    `UPDATE report_runs
        SET status = 'failed', failure_reason = 'interrupted', error = ?, finished_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'sending' AND lease_expires_at < ?`,
    [error.slice(0, 255), now, id, token, now],
  );
  return result.affectedRows === 1;
}

/**
 * Closes MANUAL runs whose sender went away — a restart or crash during "Send now" — so
 * the history stops showing them as in progress for ever. A scheduled run is settled by
 * the scheduler's own reclaim/interrupt on its day; a manual run has no such next tick.
 *
 * Only runs whose lease has expired, so a send still in progress is never touched. One
 * that died while 'sending' may have been delivered and is closed as interrupted (never
 * resent, as everywhere else). One that died while 'claimed' never reached the mail
 * server, so it is closed as a failed generation.
 */
export async function closeAbandonedManualRuns(
  reportType: string,
  now: Date,
  errors: { interrupted: string; abandoned: string },
): Promise<number> {
  const sending = await execute(
    `UPDATE report_runs
        SET status = 'failed', failure_reason = 'interrupted', error = ?, finished_at = ?
      WHERE report_type = ? AND trigger_kind = 'manual' AND status = 'sending'
        AND lease_expires_at < ?`,
    [errors.interrupted.slice(0, 255), now, reportType, now],
  );
  const claimed = await execute(
    `UPDATE report_runs
        SET status = 'failed', failure_reason = 'generation_failed', error = ?, finished_at = ?
      WHERE report_type = ? AND trigger_kind = 'manual' AND status = 'claimed'
        AND lease_expires_at < ?`,
    [errors.abandoned.slice(0, 255), now, reportType, now],
  );
  return sending.affectedRows + claimed.affectedRows;
}

/**
 * The run history, newest report day first, one page at a time through
 * `idx_report_runs_history`. LIMIT and OFFSET are interpolated only after `resolvePage`
 * has bounded them.
 */
export async function listReportRuns(
  reportType: string,
  pagination: Pagination,
): Promise<Paginated<ReportRunRecord>> {
  const countRow = await queryOne<RowDataPacket & { total: unknown }>(
    'SELECT COUNT(*) AS total FROM report_runs WHERE report_type = ?',
    [reportType],
  );
  const total = num(countRow?.total);
  const { page, pageSize, offset, totalPages } = resolvePage(pagination, total);

  const rows = await query<ReportRunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM report_runs
      WHERE report_type = ?
      ORDER BY report_date DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    [reportType],
  );

  return {
    items: rows.map((row) => toReportRunRecord(toStoredRun(row))),
    page,
    pageSize,
    total,
    totalPages,
  };
}
