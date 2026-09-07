import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import type { OwnershipScope } from '../actor';
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
  lead_reference: string;
  lead_name: string;
  lead_phone: string;
  lead_status: LeadStatus;
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
  leadReference: string;
  leadName: string;
  leadPhone: string;
  leadStatus: LeadStatus;
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
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    leadPhone: row.lead_phone,
    leadStatus: row.lead_status,
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
 */
const FOLLOW_UP_SELECT = `
  SELECT f.id, f.lead_id, l.reference AS lead_reference, l.customer_name AS lead_name,
         l.phone AS lead_phone, l.status AS lead_status,
         f.assigned_to, u.name AS assigned_to_name, f.created_by,
         f.due_at, f.note, f.state, f.completed_at, cu.name AS completed_by_name,
         f.outcome_note, f.rescheduled_from, f.reschedule_count, f.created_at, f.updated_at
    FROM follow_ups f
    JOIN leads l ON l.id = f.lead_id
    LEFT JOIN telecaller_users u ON u.id = f.assigned_to
    LEFT JOIN telecaller_users cu ON cu.id = f.completed_by
`;

/**
 * Turns a scope into a SQL predicate.
 *
 * All of these are windows over `state`, computed against the database clock rather
 * than the application's. That matters when the API and MySQL disagree about the time:
 * a follow-up must be overdue according to one clock, not two.
 */
function scopeCondition(scope: FollowUpScope): string | null {
  switch (scope) {
    case 'today':
      return "f.state = 'pending' AND DATE(f.due_at) = CURDATE()";
    case 'upcoming':
      return "f.state = 'pending' AND f.due_at > NOW()";
    case 'overdue':
      return "f.state = 'pending' AND f.due_at < NOW()";
    case 'pending':
      return "f.state = 'pending'";
    case 'completed':
      return "f.state = 'completed'";
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

  const scoped = scopeCondition(filters.scope);
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

  if (filters.from) {
    conditions.push('f.due_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('f.due_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }

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
    filters.scope === 'completed'
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

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type InsertFollowUpData = {
  leadId: number;
  assignedTo: number | null;
  createdBy: number;
  dueAt: Date;
  note: string | null;
  clientUuid: string | null;
};

export async function insertFollowUpTx(
  connection: PoolConnection,
  data: InsertFollowUpData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, note, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.leadId, data.assignedTo, data.createdBy, data.dueAt, data.note, data.clientUuid],
  );
  return (result as { insertId: number }).insertId;
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

export async function updateFollowUpFields(
  id: number,
  fields: { note?: string | null; assignedTo?: number },
): Promise<boolean> {
  const assignments: string[] = [];
  const params: SqlParam[] = [];

  if (fields.note !== undefined) {
    assignments.push('note = ?');
    params.push(fields.note);
  }
  if (fields.assignedTo !== undefined) {
    assignments.push('assigned_to = ?');
    params.push(fields.assignedTo);
  }

  if (assignments.length === 0) return false;

  params.push(id);
  const result = await execute(
    `UPDATE follow_ups SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  );
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

/**
 * Reassigns every pending follow-up from one employee to another.
 *
 * Used when someone leaves or goes on leave. Kept as one statement rather than a loop
 * because it is a bulk administrative action where per-row activity would produce
 * hundreds of near-identical timeline entries.
 */
export async function reassignPendingFollowUps(
  fromUserId: number,
  toUserId: number,
): Promise<number> {
  const result = await execute(
    `UPDATE follow_ups SET assigned_to = ? WHERE assigned_to = ? AND state = 'pending'`,
    [toUserId, fromUserId],
  );
  return result.affectedRows;
}
