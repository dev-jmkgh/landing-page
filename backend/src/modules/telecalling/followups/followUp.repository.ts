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
import {
  companyDate,
  companyDayEnd,
  companyDayStart,
  companyRangeConditions,
  companyTodayCondition,
} from '../companyTime';
import {
  likeTerm,
  resolvePage,
  type FollowUpScope,
  type FollowUpState,
  type LeadStatus,
  type Paginated,
} from '../shared.schema';
import type { FollowUpListQuery } from './followUp.schema';

/** Data access for `follow_ups`. */

export interface FollowUpRow extends RowDataPacket {
  id: number;
  lead_id: number;
  call_id: number | null;
  lead_reference: string;
  lead_name: string;
  lead_phone: string;
  lead_status: LeadStatus;
  lead_assigned_to: number | null;
  lead_assigned_to_name: string | null;
  assigned_to: number | null;
  assigned_to_name: string | null;
  created_by: number | null;
  due_at: Date;
  note: string | null;
  state: FollowUpState;
  completed_at: Date | null;
  completed_by_name: string | null;
  outcome_note: string | null;
  rescheduled_from: Date | null;
  reschedule_count: number;
  created_at: Date;
  updated_at: Date;
}

export type FollowUpRecord = {
  id: number;
  leadId: number;
  /** The call this follow-up was booked from, or null when it was booked directly. */
  callId: number | null;
  leadReference: string;
  leadName: string;
  leadPhone: string;
  leadStatus: LeadStatus;
  /**
   * The lead's OWNER, which is not necessarily who owes this call.
   *
   * A follow-up can be held by someone else — covered for a colleague on leave, or moved
   * without moving the lead. Carried here so a screen can warn about that, and so the
   * mobile app can tell when the lead behind a follow-up is one the employee cannot open.
   */
  leadAssignedTo: number | null;
  leadAssignedToName: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
  dueAt: string;
  note: string | null;
  state: FollowUpState;
  /**
   * Derived here rather than stored. A pending follow-up whose time has passed is
   * overdue, and computing it means it cannot be wrong — there is no flag to go stale
   * because a scheduled job did not run.
   */
  isOverdue: boolean;
  completedAt: string | null;
  completedByName: string | null;
  outcomeNote: string | null;
  rescheduledFrom: string | null;
  rescheduleCount: number;
  createdAt: string;
};

export function toFollowUpRecord(row: FollowUpRow): FollowUpRecord {
  const dueAt = new Date(row.due_at);

  return {
    id: row.id,
    leadId: row.lead_id,
    callId: row.call_id,
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    leadPhone: row.lead_phone,
    leadStatus: row.lead_status,
    leadAssignedTo: row.lead_assigned_to,
    leadAssignedToName: row.lead_assigned_to_name,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    dueAt: dueAt.toISOString(),
    note: row.note,
    state: row.state,
    isOverdue: row.state === 'pending' && dueAt.getTime() < Date.now(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    completedByName: row.completed_by_name,
    outcomeNote: row.outcome_note,
    rescheduledFrom: row.rescheduled_from ? new Date(row.rescheduled_from).toISOString() : null,
    rescheduleCount: Number(row.reschedule_count),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Every follow-up is read with its lead joined.
 *
 * A follow-up on its own is unactionable — a telecaller looking at their day needs the
 * customer's name and number to make the call. Fetching the leads separately would mean
 * n+1 requests from a phone on a slow connection for the one screen that has to load
 * fast at the start of a shift.
 *
 * Exported with `toFollowUpRecord` so a module that reads follow-ups in its own shape —
 * the lead view's per-call history — selects exactly the columns the mapper expects.
 */
export const FOLLOW_UP_SELECT = `
  SELECT f.id, f.lead_id, f.call_id, l.reference AS lead_reference, l.customer_name AS lead_name,
         l.phone AS lead_phone, l.status AS lead_status,
         l.assigned_to AS lead_assigned_to, lo.name AS lead_assigned_to_name,
         f.assigned_to, u.name AS assigned_to_name, f.created_by,
         f.due_at, f.note, f.state, f.completed_at, cu.name AS completed_by_name,
         f.outcome_note, f.rescheduled_from, f.reschedule_count, f.created_at, f.updated_at
    FROM follow_ups f
    JOIN leads l ON l.id = f.lead_id
    LEFT JOIN telecaller_users lo ON lo.id = l.assigned_to
    LEFT JOIN telecaller_users u ON u.id = f.assigned_to
    LEFT JOIN telecaller_users cu ON cu.id = f.completed_by
`;

/**
 * Turns a scope into a SQL predicate, pushing any bound values onto `params`.
 *
 * All of these are windows over `state`. "Now" is the database clock rather than the
 * application's, so a follow-up is overdue according to one clock, not two.
 *
 * `today` and `completed_today` are the IST day, bound as instants from `companyTime`.
 * `today` used to be `DATE(f.due_at) = CURDATE()`, which inside the UTC-pinned pool is
 * the UTC date: a follow-up due at 09:00 IST tomorrow counted as "today" from 18:30 this
 * evening, and one due at 05:00 IST was yesterday's until half past five. They are now
 * the same windows the dashboard's "Due today" and "Completed today" cards count, so a
 * card and the list it opens hold the same rows.
 */
function scopeCondition(scope: FollowUpScope, params: SqlParam[]): string | null {
  switch (scope) {
    case 'today':
      return `f.state = 'pending' AND ${companyTodayCondition('f.due_at', params)}`;
    case 'upcoming':
      return "f.state = 'pending' AND f.due_at > NOW()";
    case 'overdue':
      return "f.state = 'pending' AND f.due_at < NOW()";
    case 'pending':
      return "f.state = 'pending'";
    case 'completed':
      return "f.state = 'completed'";
    case 'completed_today':
      return `f.state = 'completed' AND ${companyTodayCondition('f.completed_at', params)}`;
    case 'all':
      return null;
  }
}

function buildFilters(
  filters: FollowUpListQuery,
  scope: OwnershipScope,
): { where: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  // First, so the scope's own bound values precede every other filter's in `params`.
  const scoped = scopeCondition(filters.scope, params);
  if (scoped) conditions.push(scoped);

  if (scope !== null) {
    conditions.push('f.assigned_to = ?');
    params.push(scope);
  } else if (filters.assignedTo) {
    conditions.push('f.assigned_to = ?');
    params.push(filters.assignedTo);
  }

  if (filters.leadId) {
    conditions.push('f.lead_id = ?');
    params.push(filters.leadId);
  }

  // Inclusive IST days as half-open instant bounds. Binding 'YYYY-MM-DD 00:00:00' read
  // the range against the UTC column, five and a half hours early at both ends.
  conditions.push(...companyRangeConditions('f.due_at', { from: filters.from, to: filters.to }, params));

  if (filters.q) {
    const term = likeTerm(filters.q);
    conditions.push('(l.customer_name LIKE ? OR l.reference LIKE ? OR l.phone LIKE ? OR f.note LIKE ?)');
    params.push(term, term, term, term);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export async function listFollowUps(
  filters: FollowUpListQuery,
  scope: OwnershipScope,
): Promise<Paginated<FollowUpRecord>> {
  const { where, params } = buildFilters(filters, scope);

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  /**
   * Pending lists are ordered soonest-first (the work queue) and completed lists
   * newest-first (a history). One ordering for both would put a telecaller's most
   * distant future follow-up at the top of their completed list.
   */
  const order =
    filters.scope === 'completed' || filters.scope === 'completed_today'
      ? 'f.completed_at DESC, f.id DESC'
      : 'f.due_at ASC, f.id ASC';

  const rows = await query<FollowUpRow>(
    `${FOLLOW_UP_SELECT} ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toFollowUpRecord), page, pageSize, total, totalPages };
}

export async function findFollowUp(
  id: number,
  scope: OwnershipScope,
): Promise<FollowUpRecord | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE f.id = ?';

  if (scope !== null) {
    where += ' AND f.assigned_to = ?';
    params.push(scope);
  }

  const row = await queryOne<FollowUpRow>(`${FOLLOW_UP_SELECT} ${where} LIMIT 1`, params);
  return row ? toFollowUpRecord(row) : null;
}

export async function findFollowUpByClientUuid(
  clientUuid: string,
): Promise<FollowUpRecord | null> {
  const row = await queryOne<FollowUpRow>(
    `${FOLLOW_UP_SELECT} WHERE f.client_uuid = ? LIMIT 1`,
    [clientUuid],
  );
  return row ? toFollowUpRecord(row) : null;
}

/** One lead's follow-ups, for the detail screen. */
export async function listLeadFollowUps(leadId: number): Promise<FollowUpRecord[]> {
  const rows = await query<FollowUpRow>(
    `${FOLLOW_UP_SELECT} WHERE f.lead_id = ? ORDER BY f.due_at DESC LIMIT 100`,
    [leadId],
  );
  return rows.map(toFollowUpRecord);
}

/**
 * The follow-up booked on one call, for the call detail: the latest one, whatever its
 * state, so a call whose follow-up has since been done still shows what was agreed.
 *
 * Not ownership-scoped — the caller has already checked it may see the call, and a
 * follow-up booked on a call belongs to that call's story. Constrained to the call's own
 * lead, though: a follow-up a supervisor has since moved to ANOTHER lead keeps its
 * `call_id`, and is that other customer's now — not something to show (or reveal) here.
 */
export async function findFollowUpForCall(
  callId: number,
  leadId: number,
): Promise<FollowUpRecord | null> {
  const row = await queryOne<FollowUpRow>(
    `${FOLLOW_UP_SELECT}
      WHERE f.call_id = ? AND f.lead_id = ?
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 1`,
    [callId, leadId],
  );
  return row ? toFollowUpRecord(row) : null;
}

/**
 * The follow-ups booked on each of a page of one lead's calls, keyed by call id, newest
 * due first within a call.
 *
 * One query for the page rather than one per call. Constrained to the lead as well as
 * to the call ids, so a call id that somehow points elsewhere cannot pull another lead's
 * follow-up into this lead's history. An empty page costs no query.
 */
export async function listCallFollowUps(
  leadId: number,
  callIds: number[],
): Promise<Map<number, FollowUpRecord[]>> {
  const byCall = new Map<number, FollowUpRecord[]>();
  const unique = [...new Set(callIds)];
  if (unique.length === 0) return byCall;

  const rows = await query<FollowUpRow>(
    `${FOLLOW_UP_SELECT}
      WHERE f.lead_id = ? AND f.call_id IN (${unique.map(() => '?').join(', ')})
      ORDER BY f.call_id ASC, f.due_at DESC, f.id DESC`,
    [leadId, ...unique],
  );

  for (const row of rows) {
    const record = toFollowUpRecord(row);
    if (record.callId === null) continue;
    const list = byCall.get(record.callId);
    if (list) list.push(record);
    else byCall.set(record.callId, [record]);
  }

  return byCall;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type InsertFollowUpData = {
  leadId: number;
  /**
   * Null means the follow-up is stored unassigned — not lost. That is what an assigner
   * gets when nobody it could give the work to is still active; see
   * `resolveFollowUpAssigneeTx`.
   */
  assignedTo: number | null;
  createdBy: number;
  dueAt: Date;
  note: string | null;
  clientUuid: string | null;
  /** The call it was booked on, when it came from a call write-up. */
  callId?: number | null;
};

export async function insertFollowUpTx(
  connection: PoolConnection,
  data: InsertFollowUpData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO follow_ups (lead_id, call_id, assigned_to, created_by, due_at, note, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.leadId,
      data.callId ?? null,
      data.assignedTo,
      data.createdBy,
      data.dueAt,
      data.note,
      data.clientUuid,
    ],
  );
  return (result as { insertId: number }).insertId;
}

/** The pending follow-up booked on a call, as locked by `findPendingFollowUpForCallTx`. */
export type PendingCallFollowUp = {
  id: number;
  leadId: number;
  assignedTo: number | null;
  /** ISO. DATETIME holds whole seconds, so compare at second precision. */
  dueAt: string;
  note: string | null;
};

/**
 * The pending follow-up booked on a call, locked FOR UPDATE inside the caller's
 * transaction.
 *
 * What lets a call write-up be saved twice without booking two follow-ups: the second
 * save finds this row and moves it instead of inserting. The lock is what makes that
 * safe against two saves of the same write-up racing each other. Newest first, should
 * an older row from before the write-up was idempotent still be pending.
 *
 * Only a follow-up still on the call's lead counts. One a supervisor moved to another
 * lead keeps its `call_id`, but it is that customer's now: re-timing it from this call
 * would move someone else's work and leave this customer with no follow-up at all.
 */
export async function findPendingFollowUpForCallTx(
  connection: PoolConnection,
  callId: number,
  leadId: number,
): Promise<PendingCallFollowUp | null> {
  const [rows] = await connection.execute<
    (RowDataPacket & {
      id: number;
      lead_id: number;
      assigned_to: number | null;
      due_at: Date;
      note: string | null;
    })[]
  >(
    `SELECT id, lead_id, assigned_to, due_at, note
       FROM follow_ups
      WHERE call_id = ? AND lead_id = ? AND state = 'pending'
      ORDER BY id DESC
      LIMIT 1
        FOR UPDATE`,
    [callId, leadId],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        leadId: row.lead_id,
        assignedTo: row.assigned_to,
        dueAt: new Date(row.due_at).toISOString(),
        note: row.note,
      }
    : null;
}

/**
 * Completes a follow-up.
 *
 * The `state = 'pending'` guard makes this idempotent: a retry from the offline queue
 * affects no rows the second time and cannot overwrite the original completion time with
 * a later one — which would silently make an on-time follow-up look late.
 */
export async function completeFollowUpTx(
  connection: PoolConnection,
  id: number,
  completedBy: number,
  outcomeNote: string | null,
): Promise<boolean> {
  const [result] = await connection.execute(
    `UPDATE follow_ups
        SET state = 'completed', completed_at = NOW(), completed_by = ?, outcome_note = ?
      WHERE id = ? AND state = 'pending'`,
    [completedBy, outcomeNote, id],
  );
  return (result as { affectedRows: number }).affectedRows > 0;
}

export async function rescheduleFollowUpTx(
  connection: PoolConnection,
  id: number,
  dueAt: Date,
  note: string | null,
): Promise<boolean> {
  const [result] = await connection.execute(
    `UPDATE follow_ups
        SET rescheduled_from = due_at,
            due_at = ?,
            note = COALESCE(?, note),
            reschedule_count = reschedule_count + 1,
            reminder_sent_at = NULL
      WHERE id = ? AND state = 'pending'`,
    [dueAt, note, id],
  );
  return (result as { affectedRows: number }).affectedRows > 0;
}

export async function cancelFollowUpTx(
  connection: PoolConnection,
  id: number,
): Promise<boolean> {
  const [result] = await connection.execute(
    `UPDATE follow_ups SET state = 'cancelled' WHERE id = ? AND state = 'pending'`,
    [id],
  );
  return (result as { affectedRows: number }).affectedRows > 0;
}

/**
 * Hands every pending follow-up on a lead to the lead's new owner, inside the
 * reassignment's transaction. Returns how many moved.
 *
 * The caller must already hold the new owner's employee row (see the lock order in
 * `resolveFollowUpAssigneeTx`): this re-checks nothing, so it stays the last step of the
 * order — employee, lead, follow-ups.
 */
export async function reassignLeadPendingFollowUpsTx(
  connection: PoolConnection,
  leadId: number,
  toUserId: number,
): Promise<number> {
  const [result] = await connection.execute(
    `UPDATE follow_ups SET assigned_to = ? WHERE lead_id = ? AND state = 'pending'`,
    [toUserId, leadId],
  );
  return (result as { affectedRows: number }).affectedRows;
}

/**
 * Rewrites a follow-up's note, whatever its state — a completed follow-up's note can
 * still be corrected. Who holds a follow-up is changed only by a move, never here.
 */
export async function updateFollowUpNote(id: number, note: string | null): Promise<boolean> {
  const result = await execute('UPDATE follow_ups SET note = ? WHERE id = ?', [note, id]);
  return result.affectedRows > 0;
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export type DueReminder = {
  id: number;
  leadId: number;
  assignedTo: number;
  leadName: string;
  leadPhone: string;
  dueAt: string;
};

/**
 * Follow-ups coming due that have not been reminded about yet.
 *
 * `reminder_sent_at IS NULL` is what makes this safe to call repeatedly: a retry, or two
 * workers running at once, cannot notify the same employee twice about the same
 * follow-up. The window has a floor as well as a ceiling so a follow-up that has been
 * overdue for a week does not generate a "due soon" reminder every sweep.
 */
export async function dueReminders(withinMinutes: number, limit = 200): Promise<DueReminder[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const minutes = Math.min(Math.max(Math.trunc(withinMinutes), 1), 1440);

  const rows = await query<
    RowDataPacket & {
      id: number;
      lead_id: number;
      assigned_to: number;
      lead_name: string;
      lead_phone: string;
      due_at: Date;
    }
  >(
    `SELECT f.id, f.lead_id, f.assigned_to, l.customer_name AS lead_name,
            l.phone AS lead_phone, f.due_at
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
      WHERE f.state = 'pending'
        AND f.assigned_to IS NOT NULL
        AND f.reminder_sent_at IS NULL
        AND f.due_at <= (NOW() + INTERVAL ${minutes} MINUTE)
        AND f.due_at > (NOW() - INTERVAL 1 DAY)
      ORDER BY f.due_at ASC
      LIMIT ${bounded}`,
  );

  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    assignedTo: row.assigned_to,
    leadName: row.lead_name,
    leadPhone: row.lead_phone,
    dueAt: new Date(row.due_at).toISOString(),
  }));
}

export async function markRemindersSent(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await execute(
    `UPDATE follow_ups SET reminder_sent_at = NOW() WHERE id IN (${placeholders})`,
    ids,
  );
}

/* -------------------------------------------------------------------------- */
/* Moves and handovers                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Everything below runs inside the caller's transaction and is part of the lock protocol
 * described on `resolveFollowUpAssigneeTx`: employee rows first, then lead rows, then
 * follow-up rows, each in ascending id order. The repository takes the locks; keeping
 * them in that order is the service's job.
 *
 * `LOCK IN SHARE MODE`, never `FOR SHARE` — the supported MariaDB 10.6 has only the
 * former.
 */

/** A follow-up as read under a lock: what a move compares against and rewrites. */
export type LockedFollowUp = {
  id: number;
  leadId: number;
  assignedTo: number | null;
  dueAt: Date;
  state: FollowUpState;
};

type LockedFollowUpRow = RowDataPacket & {
  id: number;
  lead_id: number;
  assigned_to: number | null;
  due_at: Date;
  state: FollowUpState;
};

function toLockedFollowUp(row: LockedFollowUpRow): LockedFollowUp {
  return {
    id: row.id,
    leadId: row.lead_id,
    assignedTo: row.assigned_to,
    dueAt: new Date(row.due_at),
    state: row.state,
  };
}

/** Exclusive lock on one follow-up — the last step of the lock order. */
export async function lockFollowUpForUpdateTx(
  connection: PoolConnection,
  id: number,
): Promise<LockedFollowUp | null> {
  const [rows] = await connection.execute<LockedFollowUpRow[]>(
    'SELECT id, lead_id, assigned_to, due_at, state FROM follow_ups WHERE id = ? FOR UPDATE',
    [id],
  );
  const row = rows[0];
  return row ? toLockedFollowUp(row) : null;
}

/**
 * Exclusive locks on many follow-ups, in ascending id order whatever order the ids
 * arrive in. Returns the rows found; a missing id — deleted with its lead — is absent.
 */
export async function lockFollowUpsForUpdateTx(
  connection: PoolConnection,
  ids: number[],
): Promise<LockedFollowUp[]> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return [];

  const [rows] = await connection.execute<LockedFollowUpRow[]>(
    `SELECT id, lead_id, assigned_to, due_at, state
       FROM follow_ups
      WHERE id IN (${unique.map(() => '?').join(', ')})
      ORDER BY id
        FOR UPDATE`,
    unique,
  );
  return rows.map(toLockedFollowUp);
}

/**
 * One follow-up in the API's shape, read on the caller's transaction connection — for a
 * refusal that must show the follow-up as it is now, while this transaction still holds
 * its locks and before anything is rolled back.
 */
export async function findFollowUpTx(
  connection: PoolConnection,
  id: number,
): Promise<FollowUpRecord | null> {
  const [rows] = await connection.execute<FollowUpRow[]>(
    `${FOLLOW_UP_SELECT} WHERE f.id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row ? toFollowUpRecord(row) : null;
}

/**
 * How many pending follow-ups an employee holds, read under a share lock.
 *
 * The count deactivation decides on. The caller already holds the employee's row FOR
 * UPDATE, which is what keeps every protocol-following writer out; locking the index
 * range as well (`idx_follow_ups_assignee_state_due`) keeps out anything that would put
 * a pending row onto this employee without going through that row first.
 */
export async function countPendingFollowUpsLockedTx(
  connection: PoolConnection,
  userId: number,
): Promise<number> {
  const [rows] = await connection.execute<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total
       FROM follow_ups
      WHERE assigned_to = ? AND state = 'pending'
       LOCK IN SHARE MODE`,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** An employee's pending follow-ups, by when they fall due. */
export type PendingFollowUpBreakdown = {
  total: number;
  overdue: number;
  dueToday: number;
  upcoming: number;
  /** Held on archived leads — still pending, so they still block a deactivation. */
  onArchivedLeads: number;
  earliestDueAt: string | null;
};

/**
 * Counts an employee's pending follow-ups by when they fall due.
 *
 * `overdue`, `dueToday` (from now to the end of the IST day) and `upcoming` (after it)
 * do not overlap and add up to `total` — one "now", taken here and bound, rather than the
 * database's `NOW()` beside a day boundary computed in the application, which could
 * disagree for a moment at midnight and count a row twice.
 *
 * Pass the transaction's connection to count what that transaction would leave behind
 * (a refused deactivation reports its numbers this way); without one it reads the pool.
 */
export async function pendingFollowUpBreakdown(
  userId: number,
  connection?: PoolConnection,
): Promise<PendingFollowUpBreakdown> {
  const now = new Date();
  const dayEnd = companyDayEnd(companyDate(now));

  const sql = `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(f.due_at < ?), 0) AS overdue,
           COALESCE(SUM(f.due_at >= ? AND f.due_at < ?), 0) AS due_today,
           COALESCE(SUM(f.due_at >= ?), 0) AS upcoming,
           COALESCE(SUM(l.is_archived = 1), 0) AS on_archived,
           MIN(f.due_at) AS earliest
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id
     WHERE f.assigned_to = ? AND f.state = 'pending'`;
  const params: SqlParam[] = [now, now, dayEnd, dayEnd, userId];

  type BreakdownRow = RowDataPacket & {
    total: number;
    overdue: number | string;
    due_today: number | string;
    upcoming: number | string;
    on_archived: number | string;
    earliest: Date | null;
  };

  let row: BreakdownRow | undefined;
  if (connection) {
    const [rows] = await connection.execute<BreakdownRow[]>(sql, params);
    row = rows[0];
  } else {
    row = (await queryOne<BreakdownRow>(sql, params)) ?? undefined;
  }

  // SUM comes back as DECIMAL — a string from the driver — so every figure is coerced.
  return {
    total: Number(row?.total ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueToday: Number(row?.due_today ?? 0),
    upcoming: Number(row?.upcoming ?? 0),
    onArchivedLeads: Number(row?.on_archived ?? 0),
    earliestDueAt: row?.earliest ? new Date(row.earliest).toISOString() : null,
  };
}

/** Another pending follow-up the same employee holds with the same lead that IST day. */
export type SameDayFollowUp = {
  id: number;
  leadId: number;
  assignedTo: number;
  dueAt: string;
};

/**
 * The same-day duplicate rule: another PENDING follow-up for this lead and this employee
 * on the same IST calendar day as `dueAt`.
 *
 * One employee ringing one customer twice in a day because two follow-ups were moved
 * onto the same afternoon is the mistake this exists to stop. The day is the company's
 * day, not the server's: two calls at 01:00 and 23:00 IST are the same day to the
 * customer however UTC divides them.
 *
 * A locking read, so it sees the latest committed rows rather than this transaction's
 * snapshot, and so a row it finds cannot be moved away underneath the decision. Served by
 * `idx_follow_ups_lead (lead_id, due_at)`. Only the follow_ups table is read — joining the
 * employee here would lock their row exclusively too, against the share lock this
 * transaction already holds on it.
 */
export async function findSameDayDuplicateTx(
  connection: PoolConnection,
  target: { leadId: number; assignedTo: number; dueAt: Date; excludeId: number },
): Promise<SameDayFollowUp | null> {
  const day = companyDate(target.dueAt);

  const [rows] = await connection.execute<
    (RowDataPacket & { id: number; lead_id: number; assigned_to: number; due_at: Date })[]
  >(
    `SELECT id, lead_id, assigned_to, due_at
       FROM follow_ups
      WHERE lead_id = ?
        AND assigned_to = ?
        AND state = 'pending'
        AND id <> ?
        AND due_at >= ? AND due_at < ?
      ORDER BY due_at, id
      LIMIT 1
        FOR UPDATE`,
    [
      target.leadId,
      target.assignedTo,
      target.excludeId,
      companyDayStart(day),
      companyDayEnd(day),
    ],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        leadId: row.lead_id,
        assignedTo: row.assigned_to,
        dueAt: new Date(row.due_at).toISOString(),
      }
    : null;
}

/** What a move writes onto one follow-up row. */
export type FollowUpMoveWrite = {
  leadId: number;
  assignedTo: number | null;
  dueAt: Date;
  /** Whether the time changes: records where it came from and counts the reschedule. */
  dueChanged: boolean;
  /**
   * Clears the reminder stamp, so the new time — or the new holder — is reminded afresh
   * rather than inheriting "already reminded" from a reminder somebody else received.
   */
  resetReminder: boolean;
  /** Absent keeps the note. Present replaces it — `null` clears it. */
  note?: { value: string | null };
};

/**
 * Moves one pending follow-up: time, lead and holder in one statement.
 *
 * `rescheduled_from = due_at` MUST come before `due_at = ?`. MySQL applies a single-table
 * UPDATE's assignments left to right, each seeing the ones before it — the order
 * `rescheduleFollowUpTx` relies on too. Swapped, the "moved from" time would record the
 * new time.
 *
 * The `state = 'pending'` guard is the backstop for a row the caller already locked and
 * checked; false means nothing was written.
 */
export async function applyFollowUpMoveTx(
  connection: PoolConnection,
  id: number,
  move: FollowUpMoveWrite,
): Promise<boolean> {
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE follow_ups
        SET rescheduled_from = CASE WHEN ? = 1 THEN due_at ELSE rescheduled_from END,
            reschedule_count = reschedule_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
            due_at = ?,
            lead_id = ?,
            assigned_to = ?,
            note = CASE WHEN ? = 1 THEN ? ELSE note END,
            reminder_sent_at = CASE WHEN ? = 1 THEN NULL ELSE reminder_sent_at END
      WHERE id = ? AND state = 'pending'`,
    [
      move.dueChanged ? 1 : 0,
      move.dueChanged ? 1 : 0,
      move.dueAt,
      move.leadId,
      move.assignedTo,
      move.note ? 1 : 0,
      move.note ? move.note.value : null,
      move.resetReminder ? 1 : 0,
      id,
    ],
  );
  return result.affectedRows > 0;
}

/** A follow-up a handover was asked to move, as it stood when the handover read it. */
export type HandoverCandidate = {
  id: number;
  leadId: number;
  leadName: string;
  assignedTo: number | null;
  state: FollowUpState;
  dueAt: Date;
};

/**
 * The follow-ups a handover considers, soonest due first: the named ones whatever their
 * state or holder (the caller reports the ones it cannot move), or — with no names —
 * every pending follow-up the employee holds, at most `limit` of them.
 *
 * Read on the transaction's connection after the employees are locked; the rows are
 * locked and re-checked by the caller before anything is written.
 */
export async function listHandoverCandidatesTx(
  connection: PoolConnection,
  fromUserId: number,
  ids: number[] | null,
  limit: number,
): Promise<HandoverCandidate[]> {
  type CandidateRow = RowDataPacket & {
    id: number;
    lead_id: number;
    lead_name: string;
    assigned_to: number | null;
    state: FollowUpState;
    due_at: Date;
  };

  const select = `
    SELECT f.id, f.lead_id, l.customer_name AS lead_name, f.assigned_to, f.state, f.due_at
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id`;

  let rows: CandidateRow[];
  if (ids !== null) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    [rows] = await connection.execute<CandidateRow[]>(
      `${select}
        WHERE f.id IN (${unique.map(() => '?').join(', ')})
        ORDER BY f.due_at, f.id`,
      unique,
    );
  } else {
    // `limit` is a code constant, not input; interpolated because LIMIT takes no `?`.
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 5000);
    [rows] = await connection.execute<CandidateRow[]>(
      `${select}
        WHERE f.assigned_to = ? AND f.state = 'pending'
        ORDER BY f.due_at, f.id
        LIMIT ${bounded}`,
      [fromUserId],
    );
  }

  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    assignedTo: row.assigned_to,
    state: row.state,
    dueAt: new Date(row.due_at),
  }));
}

/**
 * Pending follow-ups on one lead — as the given transaction sees them, uncommitted moves
 * included, or from the pool when there is none.
 */
export async function countPendingOnLead(
  leadId: number,
  connection?: PoolConnection,
): Promise<number> {
  const sql = "SELECT COUNT(*) AS total FROM follow_ups WHERE lead_id = ? AND state = 'pending'";

  if (connection) {
    const [rows] = await connection.execute<(RowDataPacket & { total: number })[]>(sql, [leadId]);
    return Number(rows[0]?.total ?? 0);
  }

  const row = await queryOne<RowDataPacket & { total: number }>(sql, [leadId]);
  return Number(row?.total ?? 0);
}

/** Who holds each of these follow-ups now, as this transaction sees them. */
export async function followUpHoldersTx(
  connection: PoolConnection,
  ids: number[],
): Promise<Map<number, number | null>> {
  const holders = new Map<number, number | null>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return holders;

  const [rows] = await connection.execute<
    (RowDataPacket & { id: number; assigned_to: number | null })[]
  >(
    `SELECT id, assigned_to FROM follow_ups WHERE id IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  for (const row of rows) holders.set(row.id, row.assigned_to);
  return holders;
}

/** One row of `follow_up_moves` (migration 022). */
export type FollowUpMoveHistory = {
  followUpId: number;
  /** Shared by every row of one handover or deactivation; null for a single move. */
  batchId: string | null;
  kind: 'move' | 'handover' | 'deactivation';
  fromLeadId: number;
  toLeadId: number;
  fromAssignedTo: number | null;
  toAssignedTo: number | null;
  fromDueAt: Date;
  toDueAt: Date;
  reason: string | null;
  movedBy: number | null;
  /** Denormalised, like the audit log, so the history outlives the account. */
  movedByLabel: string | null;
};

/**
 * Appends move history, inside the move's own transaction — the reason this table exists
 * beside the audit log, which is written after commit and best-effort. Many rows go in a
 * few multi-row INSERTs rather than one statement per row.
 */
export async function insertFollowUpMovesTx(
  connection: PoolConnection,
  rows: FollowUpMoveHistory[],
): Promise<void> {
  const CHUNK = 200;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const params: SqlParam[] = [];

    for (const row of chunk) {
      params.push(
        row.followUpId,
        row.batchId,
        row.kind,
        row.fromLeadId,
        row.toLeadId,
        row.fromAssignedTo,
        row.toAssignedTo,
        row.fromDueAt,
        row.toDueAt,
        row.reason ? row.reason.slice(0, 255) : null,
        row.movedBy,
        row.movedByLabel ? row.movedByLabel.slice(0, 190) : null,
      );
    }

    await connection.execute(
      `INSERT INTO follow_up_moves
         (follow_up_id, batch_id, kind, from_lead_id, to_lead_id, from_assigned_to,
          to_assigned_to, from_due_at, to_due_at, reason, moved_by, moved_by_label)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
}
