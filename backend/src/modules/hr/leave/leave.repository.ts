import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import type { PoolConnection } from 'mysql2/promise';
import { LOCAL_TODAY } from '../attendance/attendance.schema';
import type { HalfDay, LeaveKind } from '../calendar/calendar.service';
import type { Page } from '../hr.schema';
import { teamCondition, type TeamScope } from '../team/teamScope';
import type { Reviewer } from '../attendance/regularisation.service';
import type { LeaveRequest, LeaveStatus, LeaveType } from './leave.schema';

/**
 * Reads and writes for leave types, allocations and requests.
 *
 * Every function that takes a `db` argument runs on that connection when one is given —
 * the transaction that holds the employee's row lock — and on the pool otherwise. The
 * balance check and the insert it guards must see the same data under the same lock, so
 * they cannot be allowed to wander off to a different pooled connection.
 *
 * Calendar dates are formatted in SQL (`DATE_FORMAT`) for the reason given in
 * attendance.service: a bare DATE through the UTC-pinned driver becomes midnight UTC and
 * renders as the previous day anywhere west of it.
 *
 * DECIMAL columns arrive from the driver as strings, deliberately; they are converted
 * with `Number` at the edge of this file so no caller ever adds "2.0" to "1.5".
 */

export type Db = PoolConnection | null | undefined;

async function select<T extends RowDataPacket>(db: Db, sql: string, params: SqlParam[] = []): Promise<T[]> {
  if (db) {
    const [rows] = await db.execute<T[]>(sql, params);
    return rows;
  }
  return query<T>(sql, params);
}

async function selectOne<T extends RowDataPacket>(db: Db, sql: string, params: SqlParam[] = []): Promise<T | null> {
  const rows = await select<T>(db, sql, params);
  return rows[0] ?? null;
}

async function run(db: Db, sql: string, params: SqlParam[] = []): Promise<ResultSetHeader> {
  if (db) {
    const [result] = await db.execute<ResultSetHeader>(sql, params);
    return result;
  }
  return execute(sql, params);
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/** Days are whole or half; rounding to one place removes float dust from SUM(). */
export const roundDays = (value: number) => Math.round(value * 10) / 10;

/** Escapes LIKE wildcards in a search term, the same way `listHrUsers` does. */
const likeTerm = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/* -------------------------------------------------------------------------- */
/* The row lock                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Locks the employee's hr_users row for the rest of the transaction.
 *
 * THIS IS WHAT MAKES THE BALANCE CHECK TRUE. Two applications sent at once — two
 * phones, or a double tap that beat the client key — would each read "2 days left",
 * each pass, and together spend four. Every application and every approval for one
 * employee takes this lock first, so they run one after the other and the second sees
 * what the first wrote.
 *
 * It must be the transaction's FIRST statement. InnoDB fixes a transaction's read
 * snapshot at its first plain SELECT; a locking read does not fix it. Locking first
 * therefore guarantees the reads that follow are taken after the competing transaction
 * committed, not from a snapshot older than the lock.
 */
export async function lockEmployee(db: PoolConnection, userId: number): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM hr_users WHERE id = ? FOR UPDATE', [userId]);
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Leave types                                                                 */
/* -------------------------------------------------------------------------- */

interface LeaveTypeRow extends RowDataPacket {
  id: number;
  name: string;
  code: string;
  kind: LeaveKind;
  is_comp_off: number;
  is_paid: number;
  annual_quota: string | number | null;
  allow_half_day: number;
  is_active: number;
  sort_order: number;
}

const TYPE_COLUMNS = 'id, name, code, kind, is_comp_off, is_paid, annual_quota, allow_half_day, is_active, sort_order';

export function toLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    kind: row.kind,
    isCompOff: Number(row.is_comp_off) === 1,
    isPaid: Number(row.is_paid) === 1,
    annualQuota: row.annual_quota === null ? null : Number(row.annual_quota),
    allowHalfDay: Number(row.allow_half_day) === 1,
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order),
  };
}

export async function listLeaveTypes(
  filters: { activeOnly?: boolean; kind?: LeaveKind } = {},
  db?: Db,
): Promise<LeaveType[]> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  if (filters.activeOnly) conditions.push('is_active = 1');
  if (filters.kind) {
    conditions.push('kind = ?');
    params.push(filters.kind);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Bounded: a company has a handful of leave types, and the table has no other writer.
  const rows = await select<LeaveTypeRow>(
    db,
    `SELECT ${TYPE_COLUMNS} FROM hr_leave_types ${where} ORDER BY sort_order ASC, name ASC, id ASC`,
    params,
  );
  return rows.map(toLeaveType);
}

export async function findLeaveType(id: number, db?: Db): Promise<LeaveType | null> {
  const row = await selectOne<LeaveTypeRow>(db, `SELECT ${TYPE_COLUMNS} FROM hr_leave_types WHERE id = ?`, [id]);
  return row ? toLeaveType(row) : null;
}

/** Which of name / code is already taken by another type. */
export async function leaveTypeClashes(
  name: string | undefined,
  code: string | undefined,
  excludeId: number | null,
): Promise<{ name: boolean; code: boolean }> {
  const rows = await query<RowDataPacket & { name: string; code: string }>(
    `SELECT name, code FROM hr_leave_types
      WHERE (name = ? OR code = ?) AND id <> ?`,
    [name ?? '', code ?? '', excludeId ?? 0],
  );
  return {
    // The column collation is case-insensitive, so the comparison here is too.
    name: name !== undefined && rows.some((row) => row.name.toLowerCase() === name.toLowerCase()),
    code: code !== undefined && rows.some((row) => row.code.toLowerCase() === code.toLowerCase()),
  };
}

export async function insertLeaveType(input: {
  name: string;
  code: string;
  kind: LeaveKind;
  isPaid: boolean;
  annualQuota: number | null;
  allowHalfDay: boolean;
  sortOrder: number;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO hr_leave_types (name, code, kind, is_paid, annual_quota, allow_half_day, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      input.name,
      input.code,
      input.kind,
      input.isPaid ? 1 : 0,
      input.annualQuota,
      input.allowHalfDay ? 1 : 0,
      input.sortOrder,
    ],
  );
  return result.insertId;
}

/**
 * Writes the fields present in `patch`.
 *
 * Built from a FIXED column map rather than COALESCE, because `annualQuota: null` is a
 * real instruction here — "make this type untracked" — and COALESCE cannot tell it from
 * "leave it alone". The keys come from this map, never from the request, so no column
 * name reaches the SQL from outside. `isCompOff` is not in it: the migration sets it.
 */
export async function updateLeaveType(
  id: number,
  patch: Partial<Omit<LeaveType, 'id' | 'isCompOff'>>,
): Promise<void> {
  const columns: Record<keyof Omit<LeaveType, 'id' | 'isCompOff'>, string> = {
    name: 'name',
    code: 'code',
    kind: 'kind',
    isPaid: 'is_paid',
    annualQuota: 'annual_quota',
    allowHalfDay: 'allow_half_day',
    isActive: 'is_active',
    sortOrder: 'sort_order',
  };
  const sets: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (sets.length === 0) return;
  await execute(`UPDATE hr_leave_types SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export async function countRequestsForType(id: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_leave_requests WHERE leave_type_id = ?',
    [id],
  );
  return Number(row?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Allocations and usage                                                       */
/* -------------------------------------------------------------------------- */

export type Allocation = { days: number; note: string | null; updatedAt: string | null };

export async function allocationsFor(userId: number, year: number, db?: Db): Promise<Map<number, Allocation>> {
  const rows = await select<
    RowDataPacket & { leave_type_id: number; days: string | number; note: string | null; updated_at: Date | string | null }
  >(
    db,
    `SELECT leave_type_id, days, note, updated_at
       FROM hr_leave_allocations WHERE user_id = ? AND year = ?`,
    [userId, year],
  );
  return new Map(
    rows.map((row) => [
      row.leave_type_id,
      { days: Number(row.days), note: row.note, updatedAt: iso(row.updated_at) },
    ]),
  );
}

export async function upsertAllocation(input: {
  userId: number;
  leaveTypeId: number;
  year: number;
  days: number;
  note: string | null;
  updatedBy: number | null;
}): Promise<void> {
  await execute(
    `INSERT INTO hr_leave_allocations (user_id, leave_type_id, year, days, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE days = VALUES(days), note = VALUES(note), updated_by = VALUES(updated_by)`,
    [input.userId, input.leaveTypeId, input.year, input.days, input.note, input.updatedBy],
  );
}

export async function deleteAllocation(userId: number, leaveTypeId: number, year: number): Promise<number> {
  const result = await execute(
    'DELETE FROM hr_leave_allocations WHERE user_id = ? AND leave_type_id = ? AND year = ?',
    [userId, leaveTypeId, year],
  );
  return result.affectedRows;
}

export type Usage = { used: number; pending: number };

/**
 * Approved and pending days per type, for requests STARTING in `year`.
 *
 * A request belongs to the year it starts in — and an application may not cross a year
 * boundary (see the service), so "starts in" and "lies in" are the same thing for every
 * request this module accepts.
 */
export async function usageFor(userId: number, year: number, db?: Db): Promise<Map<number, Usage>> {
  const rows = await select<RowDataPacket & { leave_type_id: number; used: string | number; pending: string | number }>(
    db,
    `SELECT leave_type_id,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN days ELSE 0 END), 0) AS used,
            COALESCE(SUM(CASE WHEN status = 'pending'  THEN days ELSE 0 END), 0) AS pending
       FROM hr_leave_requests
      WHERE user_id = ? AND status IN ('approved','pending')
        AND start_date BETWEEN ? AND ?
      GROUP BY leave_type_id`,
    [userId, `${year}-01-01`, `${year}-12-31`],
  );
  return new Map(
    rows.map((row) => [row.leave_type_id, { used: roundDays(Number(row.used)), pending: roundDays(Number(row.pending)) }]),
  );
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export interface LeaveRequestRow extends RowDataPacket {
  id: number;
  user_id: number;
  manager_id: number | null;
  employee_name: string;
  employee_code: string;
  leave_type_id: number;
  type_name: string;
  type_code: string;
  type_kind: LeaveKind;
  type_is_paid: number;
  type_is_comp_off: number;
  start_date: string;
  end_date: string;
  half_day: HalfDay;
  comp_off_earned_on: string | null;
  days: string | number;
  reason: string;
  status: LeaveStatus;
  reviewer_type: 'admin' | 'manager' | null;
  reviewer_name: string | null;
  reviewed_at: Date | string | null;
  review_note: string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  can_cancel: number;
}

/*
 * `can_cancel` is decided in SQL against the COMPANY's today, the same expression the
 * cancel UPDATE is guarded by — so the button the app shows and the refusal the server
 * gives can never disagree at 23:00 UTC.
 */
const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.manager_id,
         u.name AS employee_name, u.employee_code,
         r.leave_type_id, t.name AS type_name, t.code AS type_code,
         t.kind AS type_kind, t.is_paid AS type_is_paid, t.is_comp_off AS type_is_comp_off,
         DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
         DATE_FORMAT(r.end_date, '%Y-%m-%d')   AS end_date,
         DATE_FORMAT(r.comp_off_earned_on, '%Y-%m-%d') AS comp_off_earned_on,
         r.half_day, r.days, r.reason, r.status,
         r.reviewer_type, r.reviewer_name, r.reviewed_at, r.review_note,
         r.cancelled_at, r.created_at,
         (r.status = 'pending' OR (r.status = 'approved' AND r.start_date > ${LOCAL_TODAY})) AS can_cancel
    FROM hr_leave_requests r
    JOIN hr_users u       ON u.id = r.user_id
    JOIN hr_leave_types t ON t.id = r.leave_type_id
`;

export function toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    leaveType: {
      id: row.leave_type_id,
      name: row.type_name,
      code: row.type_code,
      kind: row.type_kind,
      isPaid: Number(row.type_is_paid) === 1,
      isCompOff: Number(row.type_is_comp_off) === 1,
    },
    startDate: row.start_date,
    endDate: row.end_date,
    halfDay: row.half_day,
    compOffEarnedOn: row.comp_off_earned_on,
    days: roundDays(Number(row.days)),
    reason: row.reason,
    status: row.status,
    reviewerType: row.reviewer_type,
    reviewerName: row.reviewer_name,
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note,
    cancelledAt: iso(row.cancelled_at),
    createdAt: new Date(row.created_at).toISOString(),
    canCancel: Number(row.can_cancel) === 1,
  };
}

export async function findRequestRow(id: number, db?: Db): Promise<LeaveRequestRow | null> {
  return selectOne<LeaveRequestRow>(db, `${REQUEST_SELECT} WHERE r.id = ?`, [id]);
}

export async function findRequestByClientKey(userId: number, clientKey: string, db?: Db): Promise<LeaveRequestRow | null> {
  return selectOne<LeaveRequestRow>(db, `${REQUEST_SELECT} WHERE r.user_id = ? AND r.client_key = ? LIMIT 1`, [
    userId,
    clientKey,
  ]);
}

/**
 * The employee's own pending or approved request that collides with [start, end].
 *
 * Every kind counts: a day cannot be both annual leave and work from home. The one
 * permitted collision is two HALF days on the same date with different halves — the
 * morning off sick and the afternoon on casual leave is a real day. (A half-day request
 * is always a single date, so "both are half days and they overlap" means "same date".)
 */
export async function findOverlap(
  db: Db,
  userId: number,
  start: string,
  end: string,
  halfDay: HalfDay,
): Promise<LeaveRequestRow | null> {
  return selectOne<LeaveRequestRow>(
    db,
    `${REQUEST_SELECT}
      WHERE r.user_id = ? AND r.status IN ('pending','approved')
        AND r.start_date <= ? AND r.end_date >= ?
        AND NOT (? <> 'none' AND r.half_day <> 'none' AND r.half_day <> ?)
      ORDER BY r.start_date ASC, r.id ASC
      LIMIT 1`,
    [userId, end, start, halfDay, halfDay],
  );
}

export async function insertRequest(
  db: Db,
  input: {
    userId: number;
    leaveTypeId: number;
    startDate: string;
    endDate: string;
    halfDay: HalfDay;
    days: number;
    reason: string;
    clientKey: string;
    compOffEarnedOn: string | null;
  },
): Promise<number> {
  const result = await run(
    db,
    `INSERT INTO hr_leave_requests
       (user_id, leave_type_id, start_date, end_date, half_day, comp_off_earned_on, days, reason, status, client_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      input.userId,
      input.leaveTypeId,
      input.startDate,
      input.endDate,
      input.halfDay,
      input.compOffEarnedOn,
      input.days,
      input.reason,
      input.clientKey,
    ],
  );
  return result.insertId;
}

/**
 * The worked days the employee has already named on a pending or approved compensatory
 * leave request — the days that are spent. `comp_off_claim` is the generated column the
 * unique key sits on, so this and the key agree on what "spent" means.
 */
export async function claimedCompOffDays(db: Db, userId: number, from: string, to: string): Promise<Set<string>> {
  const rows = await select<RowDataPacket & { day: string }>(
    db,
    `SELECT DATE_FORMAT(comp_off_claim, '%Y-%m-%d') AS day
       FROM hr_leave_requests
      WHERE user_id = ? AND comp_off_claim BETWEEN ? AND ?`,
    [userId, from, to],
  );
  return new Set(rows.map((row) => row.day));
}

/**
 * Moves a pending request to approved or rejected. Guarded on `status = 'pending'` in the
 * UPDATE itself, so of two deciders clicking together exactly one wins; the other
 * updates nothing and is told so.
 */
export async function markDecision(
  db: Db,
  id: number,
  status: 'approved' | 'rejected',
  reviewer: Reviewer,
  note: string | null,
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE hr_leave_requests
        SET status = ?, reviewed_by = ?, reviewer_type = ?, reviewer_name = ?,
            reviewed_at = NOW(), review_note = ?
      WHERE id = ? AND status = 'pending'`,
    [status, reviewer.id, reviewer.type, reviewer.name ? reviewer.name.slice(0, 120) : null, note, id],
  );
  return result.affectedRows > 0;
}

/**
 * Withdraws a request, if it is still the employee's to withdraw.
 *
 * Two guarded statements rather than one, so the caller learns WHICH case applied: an
 * approved leave being withdrawn is news for the manager who approved it, a pending one
 * simply leaves their queue. A single UPDATE could not say which row state it matched.
 */
export async function markCancelled(id: number, userId: number): Promise<'approved' | 'pending' | null> {
  const approved = await execute(
    `UPDATE hr_leave_requests SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = ? AND user_id = ? AND status = 'approved' AND start_date > ${LOCAL_TODAY}`,
    [id, userId],
  );
  if (approved.affectedRows > 0) return 'approved';

  const pending = await execute(
    `UPDATE hr_leave_requests SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [id, userId],
  );
  return pending.affectedRows > 0 ? 'pending' : null;
}

export type RequestFilters = {
  userId?: number;
  status?: LeaveStatus | 'all';
  leaveTypeId?: number;
  /** Requests overlapping [from, to]. */
  from?: string;
  to?: string;
  q?: string;
  /** Restricts to a team manager's team (never the manager). */
  team?: TeamScope;
  /**
   * newest — newest first (an employee's own history).
   * queue  — pending first and oldest first within them, so the request that has waited
   *          longest is at the top; decided ones after, newest first.
   */
  order: 'newest' | 'queue';
};

function requestConditions(filters: Omit<RequestFilters, 'order'>): { where: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.userId) {
    conditions.push('r.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.status && filters.status !== 'all') {
    conditions.push('r.status = ?');
    params.push(filters.status);
  }
  if (filters.leaveTypeId) {
    conditions.push('r.leave_type_id = ?');
    params.push(filters.leaveTypeId);
  }
  if (filters.from) {
    conditions.push('r.end_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('r.start_date <= ?');
    params.push(filters.to);
  }
  if (filters.q) {
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term, term);
  }
  if (filters.team) {
    const team = teamCondition(filters.team, 'u');
    conditions.push(team.sql);
    params.push(...team.params);
    // Compensatory leave is decided by HR administrators only, so it never sits in a
    // team manager's queue.
    if (!filters.team.everyone) conditions.push('t.is_comp_off = 0');
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function listRequests(
  filters: RequestFilters,
  paging: { page: number; pageSize: number },
): Promise<Page<LeaveRequest>> {
  const { where, params } = requestConditions(filters);

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM hr_leave_requests r
       JOIN hr_users u       ON u.id = r.user_id
       JOIN hr_leave_types t ON t.id = r.leave_type_id
       ${where}`,
    params,
  );

  const order =
    filters.order === 'queue'
      ? `(r.status = 'pending') DESC,
         CASE WHEN r.status = 'pending' THEN r.created_at END ASC,
         r.created_at DESC, r.id DESC`
      : 'r.created_at DESC, r.id DESC';

  // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
  const rows = await query<LeaveRequestRow>(
    `${REQUEST_SELECT}
      ${where}
      ORDER BY ${order}
      LIMIT ${Number(paging.pageSize)} OFFSET ${Number((paging.page - 1) * paging.pageSize)}`,
    params,
  );

  return {
    items: rows.map(toLeaveRequest),
    total: Number(count?.total ?? 0),
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export async function countPendingRequests(filters: { userId?: number; team?: TeamScope } = {}): Promise<number> {
  const { where, params } = requestConditions({ ...filters, status: 'pending' });
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM hr_leave_requests r
       JOIN hr_users u       ON u.id = r.user_id
       JOIN hr_leave_types t ON t.id = r.leave_type_id
       ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

/** The employee's next approved leave (or wfh / field day) that has not ended yet. */
export async function nextApprovedRow(userId: number): Promise<LeaveRequestRow | null> {
  return queryOne<LeaveRequestRow>(
    `${REQUEST_SELECT}
      WHERE r.user_id = ? AND r.status = 'approved' AND r.end_date >= ${LOCAL_TODAY}
      ORDER BY r.start_date ASC, r.id ASC
      LIMIT 1`,
    [userId],
  );
}

/* -------------------------------------------------------------------------- */
/* Holidays                                                                    */
/* -------------------------------------------------------------------------- */

interface HolidayRow extends RowDataPacket {
  id: number;
  holiday_date: string;
  name: string;
  is_optional: number;
}

const HOLIDAY_SELECT = `SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, is_optional FROM hr_holidays`;

function toHoliday(row: HolidayRow) {
  return { id: row.id, date: row.holiday_date, name: row.name, isOptional: Number(row.is_optional) === 1 };
}

export async function findHoliday(id: number) {
  const row = await queryOne<HolidayRow>(`${HOLIDAY_SELECT} WHERE id = ?`, [id]);
  return row ? toHoliday(row) : null;
}

export async function findHolidayOn(date: string, excludeId: number | null) {
  const row = await queryOne<HolidayRow>(`${HOLIDAY_SELECT} WHERE holiday_date = ? AND id <> ? LIMIT 1`, [
    date,
    excludeId ?? 0,
  ]);
  return row ? toHoliday(row) : null;
}

export async function insertHoliday(input: { date: string; name: string; isOptional: boolean }): Promise<number> {
  const result = await execute('INSERT INTO hr_holidays (holiday_date, name, is_optional) VALUES (?, ?, ?)', [
    input.date,
    input.name,
    input.isOptional ? 1 : 0,
  ]);
  return result.insertId;
}

export async function updateHoliday(
  id: number,
  patch: { date?: string; name?: string; isOptional?: boolean },
): Promise<void> {
  await execute(
    `UPDATE hr_holidays
        SET holiday_date = COALESCE(?, holiday_date),
            name = COALESCE(?, name),
            is_optional = COALESCE(?, is_optional)
      WHERE id = ?`,
    [
      patch.date ?? null,
      patch.name ?? null,
      patch.isOptional === undefined ? null : patch.isOptional ? 1 : 0,
      id,
    ],
  );
}

export async function deleteHoliday(id: number): Promise<number> {
  const result = await execute('DELETE FROM hr_holidays WHERE id = ?', [id]);
  return result.affectedRows;
}
