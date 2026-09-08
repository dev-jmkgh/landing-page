import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import {
  likeTerm,
  resolvePage,
  type AvailabilityState,
  type EmployeeRole,
  type Paginated,
} from '../shared.schema';
import type { EmployeeListQuery } from './employee.schema';

/** Data access for `telecaller_users`. No business rules — those live in the service. */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface EmployeeRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  email_verified_at: Date | null;
  phone: string | null;
  role: EmployeeRole;
  availability: AvailabilityState;
  is_active: number;
  approval_status: ApprovalStatus;
  registered_at: Date | null;
  approved_at: Date | null;
  rejection_reason: string | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type EmployeeRecord = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: EmployeeRole;
  availability: AvailabilityState;
  isActive: boolean;
  /**
   * Why an inactive employee is inactive.
   *
   * A pending employee ALSO has isActive = false — see migration 010. That is what makes
   * every existing `is_active = 1` query exclude them safely, and it means isActive alone
   * cannot tell "never approved" from "approved then switched off".
   */
  approvalStatus: ApprovalStatus;
  /**
   * When the applicant confirmed their email address, or null if they have not.
   *
   * A separate gate from `approvalStatus`, answering a different question: this is "does
   * this person control this mailbox", decided automatically by them, where approval is
   * "should this person work our leads", decided deliberately by a human. Both must be
   * satisfied before the account can sign in, and approval is refused while this is null
   * — see migration 011.
   */
  emailVerifiedAt: string | null;
  registeredAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * `password_hash` is not in this type and not in any SELECT below.
 *
 * The only code that needs it is the authentication service, which reads it with its
 * own dedicated query. Keeping it out of the shared record type means it cannot reach a
 * response body by being spread into one.
 */
export function toEmployeeRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    availability: row.availability,
    isActive: row.is_active === 1,
    approvalStatus: row.approval_status,
    /**
     * Null until the applicant entered the code emailed to them.
     *
     * Surfaced on the record rather than kept private to the auth module because the
     * approvals queue needs it: an administrator looking at a pending registration has
     * to be able to see that it is waiting on the applicant, not on them.
     */
    emailVerifiedAt: row.email_verified_at
      ? new Date(row.email_verified_at).toISOString()
      : null,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    rejectionReason: row.rejection_reason,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const EMPLOYEE_COLUMNS = `
  id, employee_code, name, email, email_verified_at, phone, role, availability, is_active,
  approval_status, registered_at, approved_at, rejection_reason,
  last_login_at, created_at, updated_at
`;

export async function findEmployee(id: number): Promise<EmployeeRecord | null> {
  const row = await queryOne<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM telecaller_users WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toEmployeeRecord(row) : null;
}

export async function findEmployeeByEmail(email: string): Promise<EmployeeRecord | null> {
  const row = await queryOne<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM telecaller_users WHERE email = ? LIMIT 1`,
    [email],
  );
  return row ? toEmployeeRecord(row) : null;
}

export async function listEmployees(
  filters: EmployeeListQuery,
): Promise<Paginated<EmployeeRecord>> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.role) {
    conditions.push('role = ?');
    params.push(filters.role);
  }
  if (filters.active !== undefined) {
    conditions.push('is_active = ?');
    params.push(filters.active ? 1 : 0);
  }
  if (filters.approval) {
    conditions.push('approval_status = ?');
    params.push(filters.approval);
  }
  if (filters.q) {
    conditions.push('(name LIKE ? OR email LIKE ? OR employee_code LIKE ? OR phone LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM telecaller_users ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM telecaller_users
       ${where}
      ORDER BY is_active DESC, name ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toEmployeeRecord), page, pageSize, total, totalPages };
}

/**
 * Every active telecaller, unpaginated.
 *
 * Feeds assignment pickers, which need the whole list at once — a paginated dropdown is
 * a worse experience than a long one. Safe to leave unbounded: this is a staff table,
 * not a data table.
 */
export async function listAssignableEmployees(): Promise<EmployeeRecord[]> {
  const rows = await query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM telecaller_users
      WHERE is_active = 1
        AND approval_status = 'approved'
      ORDER BY name ASC`,
  );
  return rows.map(toEmployeeRecord);
}


/* -------------------------------------------------------------------------- */
/* Self-registration approvals                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Registrations awaiting a decision, oldest first.
 *
 * Oldest first on purpose: this is a queue of people who cannot work until someone acts,
 * so the one who has waited longest is the most urgent. Newest-first ordering would bury
 * a forgotten applicant.
 */
export async function listPendingRegistrations(): Promise<EmployeeRecord[]> {
  const rows = await query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM telecaller_users
      WHERE approval_status = 'pending'
      ORDER BY registered_at ASC, id ASC`,
  );
  return rows.map(toEmployeeRecord);
}

export async function countPendingRegistrations(): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM telecaller_users WHERE approval_status = 'pending'`,
  );
  return Number(row?.total ?? 0);
}

/**
 * Approves a registration: activates the account and records who decided.
 *
 * Guarded on `approval_status = 'pending'`, which makes it idempotent and prevents it
 * being used to silently re-activate a deactivated employee — that is a different
 * action, with a different audit entry.
 */
export async function approveRegistration(
  id: number,
  approvedBy: number,
): Promise<boolean> {
  const result = await execute(
    `UPDATE telecaller_users
        SET approval_status = 'approved',
            is_active = 1,
            approved_by = ?,
            approved_at = NOW(),
            rejection_reason = NULL
      WHERE id = ? AND approval_status = 'pending'`,
    [approvedBy, id],
  );
  return result.affectedRows > 0;
}

/**
 * Rejects a registration.
 *
 * The row is kept rather than deleted, for two reasons: the applicant is shown the reason
 * on their next sign-in attempt rather than being left guessing, and the retained row
 * stops the same address simply re-registering into a fresh pending state — which would
 * make rejection meaningless. Reversing a rejection is an admin action, not a re-signup.
 *
 * `is_active = 0` is written even though a pending row already has it, and the caller
 * additionally revokes any mobile sessions. Both are belt-and-braces: the guard below
 * means only a pending row can be rejected and a pending row has never held a session,
 * but if that guard is ever relaxed the revocation must already be in place rather than
 * being remembered at the time.
 */
export async function rejectRegistration(
  id: number,
  rejectedBy: number,
  reason: string | null,
): Promise<boolean> {
  const result = await execute(
    `UPDATE telecaller_users
        SET approval_status = 'rejected',
            is_active = 0,
            approved_by = ?,
            approved_at = NOW(),
            rejection_reason = ?
      WHERE id = ? AND approval_status = 'pending'`,
    [rejectedBy, reason, id],
  );
  return result.affectedRows > 0;
}

/**
 * Reverses a rejection, putting the registration back in the queue.
 *
 * Needed because rejection is otherwise terminal and the row blocks the address from
 * re-registering — so without this an admin who rejects the wrong person has no way back
 * short of editing the database.
 */
export async function reopenRegistration(id: number): Promise<boolean> {
  const result = await execute(
    `UPDATE telecaller_users
        SET approval_status = 'pending',
            is_active = 0,
            approved_by = NULL,
            approved_at = NULL,
            rejection_reason = NULL
      WHERE id = ? AND approval_status = 'rejected'`,
    [id],
  );
  return result.affectedRows > 0;
}

export type InsertEmployeeData = {
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: EmployeeRole;
  createdBy: number | null;
};

export async function insertEmployee(data: InsertEmployeeData): Promise<number> {
  const result = await execute(
    /*
     * approval_status is stated EXPLICITLY rather than left to the column default.
     *
     * The default is 'pending' (fail-closed — see migration 010), so relying on it here
     * would make every administrator-created employee unable to sign in. An account an
     * admin created by hand, with a password they chose and handed over, is approved by
     * definition; there is nobody left to approve it.
     */
    `INSERT INTO telecaller_users
       (employee_code, name, email, phone, password_hash, role, created_by,
        approval_status, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', NOW())`,
    [
      data.employeeCode,
      data.name,
      data.email,
      data.phone,
      data.passwordHash,
      data.role,
      data.createdBy,
    ],
  );
  return result.insertId;
}

export type EmployeeUpdateFields = {
  name?: string;
  email?: string;
  phone?: string | null;
  role?: EmployeeRole;
  employeeCode?: string;
  isActive?: boolean;
};

/**
 * Applies a partial update. Returns false when the caller sent no changed fields, so a
 * route can tell "nothing to do" apart from "no such employee".
 */
export async function updateEmployee(
  id: number,
  fields: EmployeeUpdateFields,
): Promise<boolean> {
  const assignments: string[] = [];
  const params: SqlParam[] = [];

  const push = (column: string, value: SqlParam) => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (fields.name !== undefined) push('name', fields.name);
  if (fields.email !== undefined) push('email', fields.email);
  if (fields.phone !== undefined) push('phone', fields.phone);
  if (fields.role !== undefined) push('role', fields.role);
  if (fields.employeeCode !== undefined) push('employee_code', fields.employeeCode);
  if (fields.isActive !== undefined) push('is_active', fields.isActive ? 1 : 0);

  if (assignments.length === 0) return false;

  params.push(id);
  const result = await execute(
    `UPDATE telecaller_users SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  );
  return result.affectedRows > 0;
}

export async function updatePasswordHash(id: number, passwordHash: string): Promise<boolean> {
  const result = await execute('UPDATE telecaller_users SET password_hash = ? WHERE id = ?', [
    passwordHash,
    id,
  ]);
  return result.affectedRows > 0;
}

/** Reads the stored hash for a password-change check. Deliberately its own query. */
export async function readPasswordHash(id: number): Promise<string | null> {
  const row = await queryOne<RowDataPacket & { password_hash: string }>(
    'SELECT password_hash FROM telecaller_users WHERE id = ? LIMIT 1',
    [id],
  );
  return row?.password_hash ?? null;
}

export async function setAvailability(
  id: number,
  availability: AvailabilityState,
): Promise<boolean> {
  const result = await execute('UPDATE telecaller_users SET availability = ? WHERE id = ?', [
    availability,
    id,
  ]);
  return result.affectedRows > 0;
}

/**
 * Next free `TC-####` code.
 *
 * Reads the highest existing numeric suffix rather than counting rows, so deleting an
 * employee does not cause the next hire to reuse a code that already appears on old
 * reports. Races are handled by the unique index plus a retry in the service — two
 * admins adding staff in the same second is rare enough not to warrant a lock.
 */
export async function nextEmployeeCode(): Promise<string> {
  const row = await queryOne<RowDataPacket & { highest: number | null }>(
    `SELECT MAX(CAST(SUBSTRING(employee_code, 4) AS UNSIGNED)) AS highest
       FROM telecaller_users
      WHERE employee_code REGEXP '^TC-[0-9]+$'`,
  );
  const next = Number(row?.highest ?? 0) + 1;
  return `TC-${String(next).padStart(4, '0')}`;
}

export async function employeeCodeExists(code: string, exceptId?: number): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM telecaller_users WHERE employee_code = ? AND id <> ?`,
    [code, exceptId ?? 0],
  );
  return Number(row?.total ?? 0) > 0;
}

export async function emailExists(email: string, exceptId?: number): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM telecaller_users WHERE email = ? AND id <> ?`,
    [email, exceptId ?? 0],
  );
  return Number(row?.total ?? 0) > 0;
}

/**
 * How many active leads an employee is carrying.
 *
 * Used by the admin employee list, and it is what a load-based assignment strategy
 * would read. "Active" excludes closed statuses — a telecaller with four hundred
 * converted leads is not busy.
 */
export async function countOpenLeads(userId: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM leads
      WHERE assigned_to = ?
        AND is_archived = 0
        AND status NOT IN ('converted','lost','not_interested','invalid_number')`,
    [userId],
  );
  return Number(row?.total ?? 0);
}
