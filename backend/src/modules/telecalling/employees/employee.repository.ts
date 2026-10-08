import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import {
  digitsOnly,
  likeTerm,
  resolvePage,
  type AvailabilityState,
  type DeviceSimMatch,
  type EmployeeRole,
  type Paginated,
} from '../shared.schema';
import type { EmployeeListQuery } from './employee.schema';

/** Data access for `telecaller_users`. No business rules — those live in the service. */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Whether the employee's handset confirmed or declined the company SIM (migration 021). */
export type CompanySimStatus = 'confirmed' | 'declined';

/**
 * The latest company-SIM report from the employee's handset, for admin visibility.
 *
 * Informational only. Whether a call is on the company line is decided per call by the
 * server against `company_phone`, never by trusting this.
 */
export type CompanySim = {
  status: CompanySimStatus;
  /** How the handset identified the SIM; null when the report was a decline. */
  method: DeviceSimMatch | null;
  label: string | null;
  slot: number | null;
  device: string | null;
  at: string | null;
};

export interface EmployeeRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  email_verified_at: Date | null;
  phone: string | null;
  company_phone: string | null;
  company_sim_status: CompanySimStatus | null;
  company_sim_method: DeviceSimMatch | null;
  company_sim_label: string | null;
  company_sim_slot: number | null;
  company_sim_device: string | null;
  company_sim_at: Date | null;
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
  /** The optional personal number. Not the line calls are verified against. */
  phone: string | null;
  /**
   * The company SIM number, canonical `+91XXXXXXXXXX`, or null when none is on file.
   *
   * Server-owned: entered at signup or by an admin, unique among live staff, and the
   * only number an incoming call is ever checked against. See migration 021.
   */
  companyPhone: string | null;
  /** The latest SIM confirmation from the employee's handset, or null if none yet. */
  companySim: CompanySim | null;
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
    companyPhone: row.company_phone,
    companySim: row.company_sim_status
      ? {
          status: row.company_sim_status,
          method: row.company_sim_method,
          label: row.company_sim_label,
          slot: row.company_sim_slot === null ? null : Number(row.company_sim_slot),
          device: row.company_sim_device,
          at: row.company_sim_at ? new Date(row.company_sim_at).toISOString() : null,
        }
      : null,
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
  id, employee_code, name, email, email_verified_at, phone, company_phone,
  company_sim_status, company_sim_method, company_sim_label, company_sim_slot,
  company_sim_device, company_sim_at, role, availability, is_active,
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
  /*
   * Who still has to be chased after the company-SIM rollout: working telecallers with
   * no company number on file, or whose phone has not confirmed the company SIM (never
   * set up, an older app, or "not in this phone"). Their incoming calls cannot be
   * recorded until both are in place.
   */
  if (filters.companySim === 'missing') {
    conditions.push(
      "role = 'telecaller' AND approval_status = 'approved' AND is_active = 1" +
        " AND (company_phone IS NULL OR NOT (company_sim_status <=> 'confirmed'))",
    );
  }
  if (filters.q) {
    const term = likeTerm(filters.q);
    /*
     * The company number is stored canonical (`+919876500002`), so a search typed the way
     * people write it (`98765 00002`) is matched on its digits against the 10-digit key
     * instead — but only from six digits, so an employee code (`TC-0002`) does not also
     * match every company number containing `0002`.
     */
    const digits = digitsOnly(filters.q);
    if (digits.length >= 6) {
      conditions.push(
        '(name LIKE ? OR email LIKE ? OR employee_code LIKE ? OR phone LIKE ? OR company_phone_key LIKE ?)',
      );
      params.push(term, term, term, term, likeTerm(digits.slice(-10)));
    } else {
      conditions.push('(name LIKE ? OR email LIKE ? OR employee_code LIKE ? OR phone LIKE ?)');
      params.push(term, term, term, term);
    }
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
 * Every active employee who can be given a lead, unpaginated.
 *
 * Feeds assignment pickers, which need the whole list at once — a paginated dropdown is
 * a worse experience than a long one. Safe to leave unbounded: this is a staff table,
 * not a data table.
 *
 * No role filter is needed, and that is a property of the schema rather than an
 * oversight. Every row in this table is a telecalling account; HR staff register into
 * `hr_users` and cannot appear here at all (migration 017). An earlier version carried
 * `AND role <> 'employee'` to keep HR self-registrations out of the assignment
 * dropdown — once the two tables were separated, that clause had nothing left to
 * exclude and the enum value it tested no longer exists.
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
 *
 * `companyPhone`, when given, is written in the SAME statement as the approval, so an
 * account never becomes live without the company number the admin just entered (null
 * keeps the one the applicant registered with). A number another live employee holds
 * fails here on the claim's unique index — the caller maps that.
 */
export async function approveRegistration(
  id: number,
  approvedBy: number,
  companyPhone: string | null,
): Promise<boolean> {
  const result = await execute(
    `UPDATE telecaller_users
        SET approval_status = 'approved',
            is_active = 1,
            approved_by = ?,
            approved_at = NOW(),
            rejection_reason = NULL,
            company_phone = COALESCE(?, company_phone)
      WHERE id = ? AND approval_status = 'pending'`,
    [approvedBy, companyPhone, id],
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
  /** Canonical `+91XXXXXXXXXX`, or null. Unique among live staff (migration 021). */
  companyPhone: string | null;
  passwordHash: string;
  role: EmployeeRole;
  createdBy: number | null;
};

export async function insertEmployee(data: InsertEmployeeData): Promise<number> {
  const result = await execute(
    /*
     * approval_status and email_verified_at are stated EXPLICITLY rather than left to the
     * column defaults.
     *
     * Both defaults are fail-closed — 'pending' (migration 010) and NULL (migration 011)
     * — and sign-in refuses either. An account an admin created by hand, with a password
     * they chose and handed over, is approved by definition, and nobody emailed its owner
     * a code to confirm, so a verified address is the truthful value. Leaving
     * email_verified_at to its default was a live bug: every admin-created employee was
     * told to "confirm your email address first" and could never sign in.
     *
     * NOW() is UTC here: the pool pins every session to +00:00 (`db/pool.ts`).
     */
    `INSERT INTO telecaller_users
       (employee_code, name, email, phone, company_phone, password_hash, role, created_by,
        approval_status, approved_at, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', NOW(), NOW())`,
    [
      data.employeeCode,
      data.name,
      data.email,
      data.phone,
      data.companyPhone,
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
  companyPhone?: string | null;
  role?: EmployeeRole;
  employeeCode?: string;
  isActive?: boolean;
  /**
   * Clears the handset's company-SIM report. Set when the company number changes: the
   * report confirmed a SIM for the OLD number, and keeping it would show the employee as
   * set up when their phone has never seen the new one.
   */
  resetCompanySim?: boolean;
};

/**
 * The SET clause for a partial update, shared by the pool and transaction forms so the
 * two cannot drift. Null when nothing was sent.
 */
function employeeUpdateStatement(
  id: number,
  fields: EmployeeUpdateFields,
): { sql: string; params: SqlParam[] } | null {
  const assignments: string[] = [];
  const params: SqlParam[] = [];

  const push = (column: string, value: SqlParam) => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (fields.name !== undefined) push('name', fields.name);
  if (fields.email !== undefined) push('email', fields.email);
  if (fields.phone !== undefined) push('phone', fields.phone);
  if (fields.companyPhone !== undefined) push('company_phone', fields.companyPhone);
  if (fields.role !== undefined) push('role', fields.role);
  if (fields.employeeCode !== undefined) push('employee_code', fields.employeeCode);
  if (fields.isActive !== undefined) push('is_active', fields.isActive ? 1 : 0);
  if (fields.resetCompanySim) {
    assignments.push(
      'company_sim_status = NULL, company_sim_method = NULL, company_sim_label = NULL,' +
        ' company_sim_slot = NULL, company_sim_device = NULL, company_sim_at = NULL',
    );
  }

  if (assignments.length === 0) return null;

  params.push(id);
  return { sql: `UPDATE telecaller_users SET ${assignments.join(', ')} WHERE id = ?`, params };
}

/**
 * Applies a partial update. Returns false when the caller sent no changed fields, so a
 * route can tell "nothing to do" apart from "no such employee".
 */
export async function updateEmployee(
  id: number,
  fields: EmployeeUpdateFields,
): Promise<boolean> {
  const statement = employeeUpdateStatement(id, fields);
  if (!statement) return false;

  const result = await execute(statement.sql, statement.params);
  return result.affectedRows > 0;
}

/** The same, inside the caller's transaction — for an edit that also deactivates. */
export async function updateEmployeeTx(
  connection: PoolConnection,
  id: number,
  fields: EmployeeUpdateFields,
): Promise<boolean> {
  const statement = employeeUpdateStatement(id, fields);
  if (!statement) return false;

  const [result] = await connection.execute<ResultSetHeader>(statement.sql, statement.params);
  return result.affectedRows > 0;
}

/**
 * Switches an employee off, inside the deactivation's transaction. Guarded on
 * `is_active = 1`, so false means it was already off.
 */
export async function deactivateEmployeeTx(
  connection: PoolConnection,
  id: number,
): Promise<boolean> {
  const [result] = await connection.execute<ResultSetHeader>(
    'UPDATE telecaller_users SET is_active = 0 WHERE id = ? AND is_active = 1',
    [id],
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

/** The same, inside the caller's transaction. */
export async function updatePasswordHashTx(
  connection: PoolConnection,
  id: number,
  passwordHash: string,
): Promise<boolean> {
  const [result] = await connection.execute<ResultSetHeader>(
    'UPDATE telecaller_users SET password_hash = ? WHERE id = ?',
    [passwordHash, id],
  );
  return result.affectedRows > 0;
}

/**
 * What a self-service password change has to know before it may touch anything: the
 * stored hash, and whether the account may still sign in at all. Read by its own query —
 * the hash is in no shared SELECT, so it cannot reach a response by being spread into one.
 */
export type PasswordAccount = {
  passwordHash: string;
  isActive: boolean;
  approvalStatus: ApprovalStatus;
  rejectionReason: string | null;
};

type PasswordAccountRow = RowDataPacket & {
  password_hash: string;
  is_active: number;
  approval_status: ApprovalStatus;
  rejection_reason: string | null;
};

function toPasswordAccount(row: PasswordAccountRow): PasswordAccount {
  return {
    passwordHash: row.password_hash,
    isActive: Number(row.is_active) === 1,
    approvalStatus: row.approval_status,
    rejectionReason: row.rejection_reason,
  };
}

const PASSWORD_ACCOUNT_COLUMNS = 'password_hash, is_active, approval_status, rejection_reason';

export async function readPasswordAccount(id: number): Promise<PasswordAccount | null> {
  const row = await queryOne<PasswordAccountRow>(
    `SELECT ${PASSWORD_ACCOUNT_COLUMNS} FROM telecaller_users WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toPasswordAccount(row) : null;
}

/**
 * The same, locked FOR UPDATE inside the change's transaction — the row deactivation
 * also locks, so a password change and a deactivation cannot interleave.
 */
export async function lockPasswordAccountTx(
  connection: PoolConnection,
  id: number,
): Promise<PasswordAccount | null> {
  const [rows] = await connection.execute<PasswordAccountRow[]>(
    `SELECT ${PASSWORD_ACCOUNT_COLUMNS} FROM telecaller_users WHERE id = ? FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  return row ? toPasswordAccount(row) : null;
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

/* -------------------------------------------------------------------------- */
/* Row locks for the assignment protocol                                       */
/* -------------------------------------------------------------------------- */

/**
 * An employee row read under a lock, with the one question every assigner asks.
 *
 * `assignable` is active AND approved — the same test as `listAssignableEmployees`. A
 * pending registration is also inactive (migration 010), but stating both keeps an
 * approval bypass from ever making a pending row look assignable.
 */
export type LockedEmployee = {
  id: number;
  name: string;
  employeeCode: string;
  isActive: boolean;
  approvalStatus: ApprovalStatus;
  assignable: boolean;
};

type LockedEmployeeRow = RowDataPacket & {
  id: number;
  name: string;
  employee_code: string;
  is_active: number;
  approval_status: ApprovalStatus;
};

const LOCK_COLUMNS = 'id, name, employee_code, is_active, approval_status';

function toLockedEmployee(row: LockedEmployeeRow): LockedEmployee {
  const isActive = Number(row.is_active) === 1;
  return {
    id: row.id,
    name: row.name,
    employeeCode: row.employee_code,
    isActive,
    approvalStatus: row.approval_status,
    assignable: isActive && row.approval_status === 'approved',
  };
}

/**
 * Exclusive lock on one employee row, for the writer that changes whether they can be
 * assigned work — deactivation. Taken FIRST in its transaction: the global lock order is
 * employee rows (ascending id), then leads (ascending id), then follow-ups. Every
 * writer following that order is what keeps two of them from waiting on each other.
 */
export async function lockEmployeeForUpdateTx(
  connection: PoolConnection,
  id: number,
): Promise<LockedEmployee | null> {
  const [rows] = await connection.execute<LockedEmployeeRow[]>(
    `SELECT ${LOCK_COLUMNS} FROM telecaller_users WHERE id = ? FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  return row ? toLockedEmployee(row) : null;
}

/**
 * Exclusive locks on several employee rows, taken in ascending id order whatever order
 * the ids arrive in — a handover from A to B and one from B to A at the same moment
 * would otherwise each hold one row and wait for the other. Returns the rows found, in
 * id order; a missing id is simply absent.
 */
export async function lockEmployeesForUpdateTx(
  connection: PoolConnection,
  ids: number[],
): Promise<LockedEmployee[]> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return [];

  const [rows] = await connection.execute<LockedEmployeeRow[]>(
    `SELECT ${LOCK_COLUMNS}
       FROM telecaller_users
      WHERE id IN (${unique.map(() => '?').join(', ')})
      ORDER BY id
        FOR UPDATE`,
    unique,
  );
  return rows.map(toLockedEmployee);
}

/**
 * Shared lock on the employee a piece of work is about to be assigned to, re-reading
 * whether they can take it.
 *
 * THIS is the half of the protocol every assigner runs. Deactivation takes the row
 * exclusively, counts that employee's pending follow-ups and flips `is_active`, all in
 * one transaction. An assigner reading `is_active` under this share lock in ITS
 * transaction is ordered against that: either it commits first and the deactivation's
 * count sees its row (and refuses), or the deactivation commits first and this read
 * returns `assignable: false`. A plain read outside the transaction — what every writer
 * did before — sees neither.
 *
 * `LOCK IN SHARE MODE`, not `FOR SHARE`: the supported MariaDB 10.6 has only the
 * former, and MySQL 8 still accepts it.
 */
export async function lockAssignableEmployeeTx(
  connection: PoolConnection,
  id: number,
): Promise<LockedEmployee | null> {
  const [rows] = await connection.execute<LockedEmployeeRow[]>(
    `SELECT ${LOCK_COLUMNS} FROM telecaller_users WHERE id = ? LOCK IN SHARE MODE`,
    [id],
  );
  const row = rows[0];
  return row ? toLockedEmployee(row) : null;
}

/**
 * An employee's name, read on the caller's transaction connection without a lock — for
 * wording a timeline line mid-transaction without borrowing a second pool connection
 * while this one holds row locks.
 */
export async function findEmployeeNameTx(
  connection: PoolConnection,
  id: number,
): Promise<string | null> {
  const [rows] = await connection.execute<(RowDataPacket & { name: string })[]>(
    'SELECT name FROM telecaller_users WHERE id = ? LIMIT 1',
    [id],
  );
  return rows[0]?.name ?? null;
}

/* -------------------------------------------------------------------------- */
/* Company line                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The company number an employee's incoming calls are verified against.
 *
 * Read fresh for every check rather than carried in the access token, so an admin
 * correcting a number takes effect on the next upload, not after the token expires.
 * Null when the employee does not exist; both fields null when no number is on file.
 */
export async function findEmployeeCompanyLine(
  id: number,
): Promise<{ companyPhone: string | null; companyPhoneKey: string | null } | null> {
  const row = await queryOne<
    RowDataPacket & { company_phone: string | null; company_phone_key: string | null }
  >('SELECT company_phone, company_phone_key FROM telecaller_users WHERE id = ? LIMIT 1', [id]);

  return row ? { companyPhone: row.company_phone, companyPhoneKey: row.company_phone_key } : null;
}

/**
 * Who currently holds a company number, by its 10-digit key — `exceptId` excluded, so
 * an employee's own row never reports a clash with itself.
 *
 * Reads `company_phone_claim`, not `company_phone`: the claim is NULL for a rejected
 * registration and a deactivated employee, so a number they used to hold is free again
 * — the same rule the unique index enforces, asked before the write so the refusal can
 * name the holder instead of surfacing as a duplicate-key error.
 */
export async function companyPhoneHolder(
  key: string,
  exceptId?: number,
): Promise<{ id: number; name: string; employeeCode: string } | null> {
  const row = await queryOne<RowDataPacket & { id: number; name: string; employee_code: string }>(
    `SELECT id, name, employee_code
       FROM telecaller_users
      WHERE company_phone_claim = ? AND id <> ?
      LIMIT 1`,
    [key, exceptId ?? 0],
  );

  return row ? { id: row.id, name: row.name, employeeCode: row.employee_code } : null;
}

/** What a handset reported about the company SIM, as stored on the employee row. */
export type CompanySimReport = {
  status: CompanySimStatus;
  method: DeviceSimMatch | null;
  label: string | null;
  slot: number | null;
  device: string | null;
};

/**
 * Stores a handset's company-SIM report. True when it changed anything.
 *
 * Two guards in the WHERE clause, so the decision is made on the row as it is at the
 * moment of writing rather than on an earlier read:
 *
 *   - `company_phone_key = confirmedFor` — the report is about the number on file. If an
 *     admin changed the number after the phone chose its SIM, nothing is written; the
 *     caller re-reads the line to tell that apart from "no change".
 *   - the report differs from what is stored — the phone re-sends its state on every
 *     launch until it lands, and a repeat must not touch `company_sim_at` or produce a
 *     second audit entry. Two identical reports racing are serialised by the row lock
 *     the UPDATE takes, and the second then matches nothing.
 */
export async function setCompanySimReport(
  userId: number,
  confirmedFor: string,
  report: CompanySimReport,
): Promise<boolean> {
  const result = await execute(
    `UPDATE telecaller_users
        SET company_sim_status = ?, company_sim_method = ?, company_sim_label = ?,
            company_sim_slot = ?, company_sim_device = ?, company_sim_at = NOW()
      WHERE id = ?
        AND company_phone_key = ?
        AND NOT (company_sim_status <=> ? AND company_sim_method <=> ? AND company_sim_label <=> ?
                 AND company_sim_slot <=> ? AND company_sim_device <=> ?)`,
    [
      report.status,
      report.method,
      report.label,
      report.slot,
      report.device,
      userId,
      confirmedFor,
      report.status,
      report.method,
      report.label,
      report.slot,
      report.device,
    ],
  );
  return result.affectedRows > 0;
}
