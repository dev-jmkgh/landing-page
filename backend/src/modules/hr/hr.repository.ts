import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import type { HrApprovalStatus, HrEmployeeProfile, HrRole } from './hr.schema';

/**
 * Reads and writes against `hr_users`.
 *
 * Every statement in this file names `hr_users`. Nothing here touches
 * `telecaller_users`, and that is the property the whole separation rests on — see
 * migration 017. A query added here that joined the telecalling tables would quietly
 * reintroduce the coupling the two tables exist to prevent.
 */

/** The assignment columns, joined onto the list query only. */
export interface HrAssignmentColumns {
  work_mode: 'office' | 'remote' | 'field';
  work_location_id: number | null;
  work_location_name: string | null;
  shift_id: number | null;
  shift_name: string | null;
}

export interface HrUserRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  email_verified_at: Date | string | null;
  phone: string | null;
  role: HrRole;
  is_active: number;
  approval_status: HrApprovalStatus;
  rejection_reason: string | null;
  registered_at: Date | string | null;
  approved_at: Date | string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
}

const HR_USER_COLUMNS = `
  id, employee_code, name, email, email_verified_at, phone, role,
  is_active, approval_status, rejection_reason, registered_at,
  approved_at, last_login_at, created_at
`;

/* The same columns prefixed for the join below, plus the assignment. */
const HR_USER_LIST_COLUMNS = `
  u.id, u.employee_code, u.name, u.email, u.email_verified_at, u.phone, u.role,
  u.is_active, u.approval_status, u.rejection_reason, u.registered_at,
  u.approved_at, u.last_login_at, u.created_at,
  u.work_mode, u.work_location_id, u.shift_id,
  l.name AS work_location_name, s.name AS shift_name
`;

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function toHrProfile(row: HrUserRow): HrEmployeeProfile {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.is_active === 1,
    approvalStatus: row.approval_status,
    rejectionReason: row.rejection_reason,
    emailVerifiedAt: iso(row.email_verified_at),
    registeredAt: iso(row.registered_at),
    approvedAt: iso(row.approved_at),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
  };
}

export async function findHrUser(id: number): Promise<HrEmployeeProfile | null> {
  const row = await queryOne<HrUserRow>(
    `SELECT ${HR_USER_COLUMNS} FROM hr_users WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toHrProfile(row) : null;
}

export async function findHrUserByEmail(email: string): Promise<HrEmployeeProfile | null> {
  const row = await queryOne<HrUserRow>(
    `SELECT ${HR_USER_COLUMNS} FROM hr_users WHERE email = ? LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  return row ? toHrProfile(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Administration                                                              */
/* -------------------------------------------------------------------------- */

export type HrRegistrationFilters = {
  approval?: HrApprovalStatus;
  q?: string;
  page: number;
  pageSize: number;
};

/**
 * An employee as the ADMIN list shows them: the profile, plus what they are assigned
 * to work.
 *
 * The assignment is not on `HrEmployeeProfile` because that shape is what `/hr/auth/me`
 * returns to the employee's own app, and the app already reads its assignment from
 * `/hr/attendance/today` — where it arrives alongside the geofence flag the server
 * derived from it. Two sources for the same fact is how they come to disagree.
 */
export type HrRegistrationRow = HrEmployeeProfile & {
  workMode: 'office' | 'remote' | 'field';
  workLocationId: number | null;
  workLocationName: string | null;
  shiftId: number | null;
  shiftName: string | null;
};

export async function listHrUsers(
  filters: HrRegistrationFilters,
): Promise<{ items: HrRegistrationRow[]; total: number; page: number; pageSize: number }> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.approval) {
    conditions.push('u.approval_status = ?');
    params.push(filters.approval);
  }

  if (filters.q) {
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR u.employee_code LIKE ? OR u.phone LIKE ?)');
    const term = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    params.push(term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_users u ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);

  const offset = (filters.page - 1) * filters.pageSize;

  /*
   * LIMIT and OFFSET are interpolated, not bound.
   *
   * MySQL's prepared-statement protocol does not accept placeholders there — `LIMIT ?`
   * fails with "Incorrect arguments to mysqld_stmt_execute", which is the same trap the
   * call-log query hit. Interpolation is safe because both values arrive from Zod as
   * `int().positive()` with pageSize capped at 100, so neither can carry SQL. Every
   * other paginated query in this codebase does the same.
   */
  const rows = await query<HrUserRow & HrAssignmentColumns>(
    `SELECT ${HR_USER_LIST_COLUMNS}
       FROM hr_users u
       LEFT JOIN hr_work_locations l ON l.id = u.work_location_id
       LEFT JOIN hr_shifts s         ON s.id = u.shift_id
       ${where}
      ORDER BY
        /* Pending first: the queue exists to be emptied, not browsed. */
        CASE u.approval_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        u.registered_at DESC,
        u.id DESC
      LIMIT ${filters.pageSize} OFFSET ${offset}`,
    params,
  );

  return {
    items: rows.map((row) => ({
      ...toHrProfile(row),
      workMode: row.work_mode,
      workLocationId: row.work_location_id,
      workLocationName: row.work_location_name,
      shiftId: row.shift_id,
      shiftName: row.shift_name,
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/**
 * Approves a registration.
 *
 * Guarded on `approval_status = 'pending'` in the UPDATE itself rather than by reading
 * first and writing second. Two administrators clicking Approve on the same row would
 * otherwise both succeed, and the second would overwrite the first one's name and
 * timestamp in the audit trail.
 *
 * An account must have CONFIRMED ITS EMAIL before it can be approved. Without that
 * condition an administrator could let in an address nobody has proven they can read —
 * which is the entire thing email verification exists to stop, defeated by one click.
 * The caller distinguishes the two failures so the refusal can say which it was.
 */
export async function approveHrUser(id: number, adminId: number | null): Promise<boolean> {
  const result = await execute(
    `UPDATE hr_users
        SET approval_status = 'approved',
            is_active       = 1,
            approved_by     = ?,
            approved_at     = NOW(),
            rejection_reason = NULL
      WHERE id = ?
        AND approval_status = 'pending'
        AND email_verified_at IS NOT NULL`,
    [adminId, id],
  );
  return result.affectedRows > 0;
}

/**
 * Rejects a registration.
 *
 * `is_active` is forced to 0 rather than left alone: a rejected row must not be able to
 * sign in even if some other path had set the flag.
 */
export async function rejectHrUser(
  id: number,
  adminId: number | null,
  reason: string | null,
): Promise<boolean> {
  const result = await execute(
    `UPDATE hr_users
        SET approval_status  = 'rejected',
            is_active        = 0,
            approved_by      = ?,
            approved_at      = NOW(),
            rejection_reason = ?
      WHERE id = ?
        AND approval_status = 'pending'`,
    [adminId, reason, id],
  );
  return result.affectedRows > 0;
}

/** Switches an approved account off, or back on. Rejected rows are not reachable here. */
export async function setHrUserActive(id: number, active: boolean): Promise<boolean> {
  const result = await execute(
    `UPDATE hr_users
        SET is_active = ?
      WHERE id = ? AND approval_status = 'approved'`,
    [active ? 1 : 0, id],
  );
  return result.affectedRows > 0;
}
