import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { historyFor } from '../attendance/attendance.service';
import type { AttendanceDay } from '../attendance/attendance.schema';
import type { Page } from '../hr.schema';
import { findHrUser, type HrRegistrationRow } from '../hr.repository';
import type { Department, Designation } from './people.schema';

/**
 * SQL for employee records and the organisation lists.
 *
 * Every statement names an `hr_*` table and nothing else — the separation rule in
 * migration 017. Business rules (who may manage whom, which dates are allowed) live in
 * `people.service.ts`; this file only reads and writes.
 */

/* -------------------------------------------------------------------------- */
/* Departments                                                                 */
/* -------------------------------------------------------------------------- */

interface DepartmentRow extends RowDataPacket {
  id: number;
  name: string;
  code: string | null;
  is_active: number;
  employee_count: number;
}

/*
 * The headcount counts ACTIVE, APPROVED accounts — the same population the dashboard's
 * headcount uses — so the department list and the dashboard never disagree about how
 * many people work in Finance. A pending registration is not yet an employee, and a
 * deactivated account is not one any more.
 */
const DEPARTMENT_SELECT = `
  SELECT d.id, d.name, d.code, d.is_active,
         (SELECT COUNT(*) FROM hr_users u
           WHERE u.department_id = d.id AND u.is_active = 1 AND u.approval_status = 'approved')
           AS employee_count
    FROM hr_departments d
`;

function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    isActive: Number(row.is_active) === 1,
    employeeCount: Number(row.employee_count ?? 0),
  };
}

/** Every department. A bounded list — an organisation has tens, not thousands. */
export async function listDepartments(): Promise<Department[]> {
  const rows = await query<DepartmentRow>(`${DEPARTMENT_SELECT} ORDER BY d.is_active DESC, d.name ASC`);
  return rows.map(toDepartment);
}

export async function findDepartment(id: number): Promise<Department | null> {
  const row = await queryOne<DepartmentRow>(`${DEPARTMENT_SELECT} WHERE d.id = ?`, [id]);
  return row ? toDepartment(row) : null;
}

/**
 * Another department already using this name, if any.
 *
 * The comparison is the column's collation (utf8mb4_unicode_ci), the same one the
 * unique key enforces — so "finance" is caught as a duplicate of "Finance" here rather
 * than surfacing as a raw duplicate-key error from the insert.
 */
export async function departmentNameTaken(name: string, exceptId: number | null): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    `SELECT id FROM hr_departments WHERE name = ? ${exceptId ? 'AND id <> ?' : ''} LIMIT 1`,
    exceptId ? [name, exceptId] : [name],
  );
  return row !== null;
}

export async function insertDepartment(name: string, code: string | null): Promise<number> {
  const result = await execute('INSERT INTO hr_departments (name, code) VALUES (?, ?)', [name, code]);
  return result.insertId;
}

export async function updateDepartment(
  id: number,
  patch: { name?: string; code?: string | null; isActive?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  // Column names come from this fixed list, never from the request.
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.code !== undefined) {
    sets.push('code = ?');
    params.push(patch.code);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    params.push(patch.isActive ? 1 : 0);
  }
  if (sets.length === 0) return;
  await execute(`UPDATE hr_departments SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/* -------------------------------------------------------------------------- */
/* Designations                                                                */
/* -------------------------------------------------------------------------- */

interface DesignationRow extends RowDataPacket {
  id: number;
  name: string;
  is_active: number;
  employee_count: number;
}

const DESIGNATION_SELECT = `
  SELECT g.id, g.name, g.is_active,
         (SELECT COUNT(*) FROM hr_users u
           WHERE u.designation_id = g.id AND u.is_active = 1 AND u.approval_status = 'approved')
           AS employee_count
    FROM hr_designations g
`;

function toDesignation(row: DesignationRow): Designation {
  return {
    id: row.id,
    name: row.name,
    isActive: Number(row.is_active) === 1,
    employeeCount: Number(row.employee_count ?? 0),
  };
}

export async function listDesignations(): Promise<Designation[]> {
  const rows = await query<DesignationRow>(`${DESIGNATION_SELECT} ORDER BY g.is_active DESC, g.name ASC`);
  return rows.map(toDesignation);
}

export async function findDesignation(id: number): Promise<Designation | null> {
  const row = await queryOne<DesignationRow>(`${DESIGNATION_SELECT} WHERE g.id = ?`, [id]);
  return row ? toDesignation(row) : null;
}

export async function designationNameTaken(name: string, exceptId: number | null): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    `SELECT id FROM hr_designations WHERE name = ? ${exceptId ? 'AND id <> ?' : ''} LIMIT 1`,
    exceptId ? [name, exceptId] : [name],
  );
  return row !== null;
}

export async function insertDesignation(name: string): Promise<number> {
  const result = await execute('INSERT INTO hr_designations (name) VALUES (?)', [name]);
  return result.insertId;
}

export async function updateDesignation(
  id: number,
  patch: { name?: string; isActive?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    params.push(patch.isActive ? 1 : 0);
  }
  if (sets.length === 0) return;
  await execute(`UPDATE hr_designations SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/* -------------------------------------------------------------------------- */
/* Employees                                                                   */
/* -------------------------------------------------------------------------- */

interface AssignmentRow extends RowDataPacket {
  work_mode: 'office' | 'remote' | 'field';
  work_location_id: number | null;
  work_location_name: string | null;
  shift_id: number | null;
  shift_name: string | null;
}

/**
 * One employee as the admin detail screen shows them: the profile plus the assignment —
 * the same shape as one row of the directory (`HrRegistrationRow`), so the list and the
 * detail cannot disagree about a field.
 */
export async function findEmployee(id: number): Promise<HrRegistrationRow | null> {
  const [profile, assignment] = await Promise.all([
    findHrUser(id),
    queryOne<AssignmentRow>(
      `SELECT u.work_mode, u.work_location_id, l.name AS work_location_name,
              u.shift_id, s.name AS shift_name
         FROM hr_users u
         LEFT JOIN hr_work_locations l ON l.id = u.work_location_id
         LEFT JOIN hr_shifts s         ON s.id = u.shift_id
        WHERE u.id = ? LIMIT 1`,
      [id],
    ),
  ]);
  if (!profile || !assignment) return null;

  return {
    ...profile,
    workMode: assignment.work_mode,
    workLocationId: assignment.work_location_id,
    workLocationName: assignment.work_location_name,
    shiftId: assignment.shift_id,
    shiftName: assignment.shift_name,
  };
}

/**
 * How many accounts name this person as their manager — whatever state those accounts
 * are in, matching what the directory's `managerId` filter lists.
 */
export async function countDirectReports(id: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_users WHERE manager_id = ?',
    [id],
  );
  return Number(row?.total ?? 0);
}

/**
 * The bits of an account the reference checks need. A deleted account IS found — its
 * attendance history stays readable — and says so in `deleted`.
 */
export async function findAccountState(
  id: number,
): Promise<{ id: number; name: string; approvalStatus: string; deleted: boolean } | null> {
  const row = await queryOne<
    RowDataPacket & { id: number; name: string; approval_status: string; deleted_at: Date | string | null }
  >('SELECT id, name, approval_status, deleted_at FROM hr_users WHERE id = ? LIMIT 1', [id]);
  return row
    ? { id: row.id, name: row.name, approvalStatus: row.approval_status, deleted: row.deleted_at !== null }
    : null;
}

export async function hrEmailTaken(email: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM hr_users WHERE email = ? LIMIT 1',
    [email],
  );
  return row !== null;
}

export type EmployeeInsert = {
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: string;
  departmentId: number | null;
  designationId: number | null;
  managerId: number | null;
  joiningDate: string | null;
  employmentType: string;
  employmentStatus: string;
  approvedBy: number | null;
};

/**
 * Inserts an administrator-created account: approved, active and email-verified in the
 * one statement, with the timestamps from SQL. The three access columns are written
 * explicitly for the same reason signup writes them — they are the access boundary and
 * must not depend on a column default.
 */
export async function insertEmployee(input: EmployeeInsert): Promise<number> {
  const result = await execute(
    `INSERT INTO hr_users
       (employee_code, name, email, phone, password_hash, role,
        is_active, approval_status, email_verified_at, approved_by, approved_at, registered_at,
        department_id, designation_id, manager_id, joining_date,
        employment_type, employment_status)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'approved', NOW(), ?, NOW(), NOW(), ?, ?, ?, ?, ?, ?)`,
    [
      input.employeeCode,
      input.name,
      input.email,
      input.phone,
      input.passwordHash,
      input.role,
      input.approvedBy,
      input.departmentId,
      input.designationId,
      input.managerId,
      input.joiningDate,
      input.employmentType,
      input.employmentStatus,
    ],
  );
  return result.insertId;
}

/** The record columns an administrator may edit, keyed by the API field name. */
export const EMPLOYEE_COLUMNS = {
  name: 'name',
  phone: 'phone',
  role: 'role',
  departmentId: 'department_id',
  designationId: 'designation_id',
  managerId: 'manager_id',
  joiningDate: 'joining_date',
  exitDate: 'exit_date',
  employmentType: 'employment_type',
  employmentStatus: 'employment_status',
  dateOfBirth: 'date_of_birth',
  address: 'address',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
} as const;
export type EmployeeField = keyof typeof EMPLOYEE_COLUMNS;

/**
 * Writes the named fields, inside the caller's transaction.
 *
 * The SET clause is built from present keys — but the column for each key comes from
 * `EMPLOYEE_COLUMNS`, a fixed map, so a key the map does not know cannot reach SQL and a
 * typo fails the type check rather than silently nulling a column.
 */
export async function updateEmployeeTx(
  connection: PoolConnection,
  id: number,
  changes: Partial<Record<EmployeeField, string | number | null>>,
): Promise<void> {
  const keys = Object.keys(changes) as EmployeeField[];
  if (keys.length === 0) return;
  const sets = keys.map((key) => `${EMPLOYEE_COLUMNS[key]} = ?`);
  const params = keys.map((key) => changes[key] ?? null);
  await connection.execute(`UPDATE hr_users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

/**
 * The reporting line above `startId`, walked one row at a time with each row LOCKED.
 *
 * Returns the ids from `startId` upwards. Locking the chain is what stops two
 * administrators closing a loop between them at the same moment (A→B saved while B→A is
 * being saved): the second walk waits for the first commit and then sees the edge it
 * made. `maxDepth` bounds the walk; a chain that long is reported as such by the caller.
 */
export async function managerChainTx(
  connection: PoolConnection,
  startId: number,
  maxDepth: number,
): Promise<{ chain: number[]; truncated: boolean }> {
  const chain: number[] = [];
  let cursor: number | null = startId;

  while (cursor !== null && chain.length < maxDepth) {
    chain.push(cursor);
    const result: [(RowDataPacket & { manager_id: number | null })[], unknown] = await connection.execute<
      (RowDataPacket & { manager_id: number | null })[]
    >('SELECT manager_id FROM hr_users WHERE id = ? FOR UPDATE', [cursor]);
    const next: number | null = result[0][0]?.manager_id ?? null;
    // A loop that already exists further up (it cannot, but data typed by hand can) ends
    // the walk instead of spinning to the depth limit.
    if (next !== null && chain.includes(Number(next))) {
      chain.push(Number(next));
      return { chain, truncated: false };
    }
    cursor = next === null ? null : Number(next);
  }

  return { chain, truncated: cursor !== null };
}

/* -------------------------------------------------------------------------- */
/* An employee's attendance, a page at a time                                  */
/* -------------------------------------------------------------------------- */

/**
 * One page of an employee's recorded days, newest first.
 *
 * Reuses `historyFor` for the rows themselves, so a day here is the exact shape the app's
 * history shows (sessions included). The trick that makes that possible: a user has ONE
 * row per date, so a page of rows ordered by date is a contiguous run of dates — and the
 * rows between the page's oldest and newest date are exactly the page. Asking
 * `historyFor` for that narrower range returns the page and nothing else.
 */
export async function attendancePage(
  userId: number,
  from: string,
  to: string,
  paging: { page: number; pageSize: number },
): Promise<Page<AttendanceDay>> {
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_attendance WHERE user_id = ? AND work_date BETWEEN ? AND ?',
    [userId, from, to],
  );
  const total = Number(countRow?.total ?? 0);

  // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
  const dates = await query<RowDataPacket & { work_date: string }>(
    `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date
       FROM hr_attendance
      WHERE user_id = ? AND work_date BETWEEN ? AND ?
      ORDER BY work_date DESC
      LIMIT ${Number(paging.pageSize)} OFFSET ${Number((paging.page - 1) * paging.pageSize)}`,
    [userId, from, to],
  );

  const newest = dates[0]?.work_date;
  const oldest = dates[dates.length - 1]?.work_date;
  const items = newest && oldest ? await historyFor(userId, oldest, newest) : [];

  return { items, total, page: paging.page, pageSize: paging.pageSize };
}
