import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  withTransaction,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import { addDays } from '../calendar/calendar.service';
import type { Page } from '../hr.schema';
import {
  paiseToAmount,
  paiseToDecimal,
  toPaise,
  type ComponentKind,
  type PayrollEmployee,
  type PayrollExclusion,
  type PayrollRun,
  type PayrollRunStatus,
  type Payslip,
  type PayslipLine,
  type PayslipSummary,
  type SalaryComponent,
  type SalaryStructure,
} from './payroll.schema';

/**
 * Reads and writes for payroll (`hr_salary_*`, `hr_payroll_runs`, `hr_payslip*`,
 * migration 030).
 *
 * Every statement here names HR tables only. Calendar dates are formatted in SQL — a bare
 * DATE through the UTC-pinned pool arrives as midnight UTC and renders a day early
 * anywhere west of Greenwich. DECIMAL columns arrive as strings and go through `toPaise`,
 * never `Number()`.
 *
 * LIMIT/OFFSET are interpolated, not bound: MySQL's prepared-statement protocol refuses
 * placeholders there, and both values come from Zod as positive integers (pageSize ≤ 100).
 */

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function likeTerm(value: string): string {
  return `%${value.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

/** Positive integers only, for an IN (...) list built from ids the server already holds. */
function idList(ids: number[]): string {
  const clean = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  return clean.length > 0 ? clean.join(',') : '0';
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/* -------------------------------------------------------------------------- */
/* Salary structures                                                           */
/* -------------------------------------------------------------------------- */

interface StructureRow extends RowDataPacket {
  id: number;
  user_id: number;
  effective_from: string;
  note: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  in_use: number;
}

interface ComponentRow extends RowDataPacket {
  id: number;
  structure_id: number;
  label: string;
  kind: ComponentKind;
  amount: string;
  prorated: number;
  sort_order: number;
}

/*
 * `in_use` goes through the (user_id, run_id) index: a person has a dozen payslips a
 * year, so the lookup is bounded by them rather than by the whole payslip table
 * (structure_id itself carries no index — see the module report).
 */
const STRUCTURE_COLUMNS = `
  s.id, s.user_id, DATE_FORMAT(s.effective_from, '%Y-%m-%d') AS effective_from,
  s.note, s.created_by_name, s.created_at,
  EXISTS (SELECT 1 FROM hr_payslips p WHERE p.user_id = s.user_id AND p.structure_id = s.id) AS in_use
`;

/** A component as the payroll computation consumes it: paise, not rupees. */
export type ComponentRecord = {
  id: number;
  structureId: number;
  label: string;
  kind: ComponentKind;
  amountPaise: number;
  prorated: boolean;
  sortOrder: number;
};

function toComponentRecord(row: ComponentRow): ComponentRecord {
  return {
    id: row.id,
    structureId: row.structure_id,
    label: row.label,
    kind: row.kind,
    amountPaise: toPaise(row.amount),
    prorated: row.kind === 'earning' && Number(row.prorated) === 1,
    sortOrder: Number(row.sort_order),
  };
}

export async function componentsFor(structureIds: number[]): Promise<Map<number, ComponentRecord[]>> {
  const result = new Map<number, ComponentRecord[]>();
  if (structureIds.length === 0) return result;
  const rows = await query<ComponentRow>(
    `SELECT id, structure_id, label, kind, amount, prorated, sort_order
       FROM hr_salary_components
      WHERE structure_id IN (${idList(structureIds)})
      ORDER BY structure_id ASC, sort_order ASC, id ASC`,
  );
  for (const row of rows) {
    const list = result.get(row.structure_id) ?? [];
    list.push(toComponentRecord(row));
    result.set(row.structure_id, list);
  }
  return result;
}

function toStructure(row: StructureRow, components: ComponentRecord[]): SalaryStructure {
  const sum = (kind: ComponentKind) =>
    components.filter((component) => component.kind === kind).reduce((total, c) => total + c.amountPaise, 0);
  const earnings = sum('earning');
  const deductions = sum('deduction');
  return {
    id: row.id,
    userId: row.user_id,
    effectiveFrom: row.effective_from,
    note: row.note,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at) ?? '',
    inUse: Number(row.in_use) === 1,
    components: components.map(
      (component): SalaryComponent => ({
        id: component.id,
        label: component.label,
        kind: component.kind,
        amount: paiseToAmount(component.amountPaise),
        prorated: component.prorated,
        sortOrder: component.sortOrder,
      }),
    ),
    totals: {
      earnings: paiseToAmount(earnings),
      deductions: paiseToAmount(deductions),
      net: paiseToAmount(earnings - deductions),
    },
  };
}

async function withComponents(rows: StructureRow[]): Promise<SalaryStructure[]> {
  const components = await componentsFor(rows.map((row) => row.id));
  return rows.map((row) => toStructure(row, components.get(row.id) ?? []));
}

export async function findStructure(id: number): Promise<SalaryStructure | null> {
  const row = await queryOne<StructureRow>(
    `SELECT ${STRUCTURE_COLUMNS} FROM hr_salary_structures s WHERE s.id = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;
  return (await withComponents([row]))[0] ?? null;
}

/** One employee's structures, newest first. */
export async function listStructures(
  userId: number,
  page: number,
  pageSize: number,
): Promise<Page<SalaryStructure>> {
  const count = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_salary_structures WHERE user_id = ?',
    [userId],
  );
  const rows = await query<StructureRow>(
    `SELECT ${STRUCTURE_COLUMNS} FROM hr_salary_structures s
      WHERE s.user_id = ?
      ORDER BY s.effective_from DESC, s.id DESC
      LIMIT ${Number(pageSize)} OFFSET ${Number((page - 1) * pageSize)}`,
    [userId],
  );
  return { items: await withComponents(rows), total: Number(count?.total ?? 0), page, pageSize };
}

export async function structureExistsFrom(userId: number, effectiveFrom: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM hr_salary_structures WHERE user_id = ? AND effective_from = ? LIMIT 1',
    [userId, effectiveFrom],
  );
  return row !== null;
}

export type NewStructure = {
  userId: number;
  effectiveFrom: string;
  note: string | null;
  createdBy: number | null;
  createdByName: string | null;
  components: Array<{ label: string; kind: ComponentKind; amountPaise: number; prorated: boolean }>;
};

/** Inserts a structure and its components together. Throws ER_DUP_ENTRY on (user, date). */
export async function insertStructure(input: NewStructure): Promise<number> {
  return withTransaction(async (connection) => {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO hr_salary_structures (user_id, effective_from, note, created_by, created_by_name)
       VALUES (?, ?, ?, ?, ?)`,
      [input.userId, input.effectiveFrom, input.note, input.createdBy, input.createdByName],
    );
    const structureId = result.insertId;

    const params: SqlParam[] = [];
    const values = input.components.map((component, index) => {
      params.push(
        structureId,
        component.label,
        component.kind,
        paiseToDecimal(component.amountPaise),
        // Deductions are fixed amounts; storing 0 keeps the column honest.
        component.kind === 'earning' && component.prorated ? 1 : 0,
        // The order the administrator entered them in, with room to insert later.
        (index + 1) * 10,
      );
      return '(?, ?, ?, ?, ?, ?)';
    });
    await connection.execute(
      `INSERT INTO hr_salary_components (structure_id, label, kind, amount, prorated, sort_order)
       VALUES ${values.join(', ')}`,
      params,
    );
    return structureId;
  });
}

/**
 * Deletes a structure unless a payslip was computed from it.
 *
 * The structure row is locked first, and the payroll write takes a SHARE lock on every
 * structure it used (see `replacePayslips`), so a run being processed at the same moment
 * cannot end up pointing at a structure this just removed: one of the two waits for the
 * other and then sees the truth.
 */
export async function deleteStructureIfUnused(id: number): Promise<'deleted' | 'in_use' | 'missing'> {
  return withTransaction(async (connection) => {
    const [locked] = await connection.execute<RowDataPacket[]>(
      'SELECT id, user_id FROM hr_salary_structures WHERE id = ? FOR UPDATE',
      [id],
    );
    const row = locked[0];
    if (!row) return 'missing';

    const [used] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM hr_payslips WHERE user_id = ? AND structure_id = ? LIMIT 1',
      [row.user_id, id],
    );
    if (used.length > 0) return 'in_use';

    // Components go with it (ON DELETE CASCADE).
    await connection.execute('DELETE FROM hr_salary_structures WHERE id = ?', [id]);
    return 'deleted';
  });
}

/* -------------------------------------------------------------------------- */
/* Who is set up for payroll                                                   */
/* -------------------------------------------------------------------------- */

interface PayrollEmployeeRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  is_active: number;
  department_id: number | null;
  department_name: string | null;
  designation_name: string | null;
  joining_date: string | null;
  exit_date: string | null;
  employment_status: string;
}

/** The structure in force on `date` per user ('current'), or the next one after it ('upcoming'). */
async function structuresAround(
  userIds: number[],
  date: string,
  which: 'current' | 'upcoming',
): Promise<Map<number, SalaryStructure>> {
  const result = new Map<number, SalaryStructure>();
  if (userIds.length === 0) return result;
  // (user_id, effective_from) is unique, so the correlated MAX/MIN picks one row per user.
  const pick =
    which === 'current'
      ? 'SELECT MAX(x.effective_from) FROM hr_salary_structures x WHERE x.user_id = s.user_id AND x.effective_from <= ?'
      : 'SELECT MIN(x.effective_from) FROM hr_salary_structures x WHERE x.user_id = s.user_id AND x.effective_from > ?';
  const rows = await query<StructureRow>(
    `SELECT ${STRUCTURE_COLUMNS} FROM hr_salary_structures s
      WHERE s.user_id IN (${idList(userIds)}) AND s.effective_from = (${pick})`,
    [date],
  );
  for (const structure of await withComponents(rows)) result.set(structure.userId, structure);
  return result;
}

export async function listPayrollEmployees(filters: {
  q?: string;
  departmentId?: number;
  setUp?: 'true' | 'false';
  today: string;
  page: number;
  pageSize: number;
}): Promise<Page<PayrollEmployee>> {
  // A deleted employee has no salary to set up.
  const conditions: string[] = ["u.approval_status = 'approved'", 'u.deleted_at IS NULL'];
  const params: SqlParam[] = [];

  if (filters.q) {
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term, term);
  }
  if (filters.departmentId) {
    conditions.push('u.department_id = ?');
    params.push(filters.departmentId);
  }
  if (filters.setUp) {
    conditions.push(
      `${filters.setUp === 'true' ? '' : 'NOT '}EXISTS (SELECT 1 FROM hr_salary_structures x WHERE x.user_id = u.id)`,
    );
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_users u ${where}`,
    params,
  );

  const rows = await query<PayrollEmployeeRow>(
    `SELECT u.id, u.employee_code, u.name, u.email, u.is_active,
            u.department_id, d.name AS department_name, g.name AS designation_name,
            DATE_FORMAT(u.joining_date, '%Y-%m-%d') AS joining_date,
            DATE_FORMAT(u.exit_date, '%Y-%m-%d')    AS exit_date,
            u.employment_status
       FROM hr_users u
       LEFT JOIN hr_departments d  ON d.id = u.department_id
       LEFT JOIN hr_designations g ON g.id = u.designation_id
       ${where}
      ORDER BY u.name ASC, u.id ASC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );

  const ids = rows.map((row) => row.id);
  const [current, upcoming] = await Promise.all([
    structuresAround(ids, filters.today, 'current'),
    structuresAround(ids, filters.today, 'upcoming'),
  ]);

  return {
    items: rows.map((row) => ({
      user: {
        id: row.id,
        employeeCode: row.employee_code,
        name: row.name,
        email: row.email,
        isActive: Number(row.is_active) === 1,
        departmentId: row.department_id,
        departmentName: row.department_name,
        designationName: row.designation_name,
        joiningDate: row.joining_date,
        exitDate: row.exit_date,
        employmentStatus: row.employment_status,
      },
      currentStructure: current.get(row.id) ?? null,
      upcomingStructure: upcoming.get(row.id) ?? null,
    })),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function hrUserExists(userId: number): Promise<{ name: string; employeeCode: string } | null> {
  const row = await queryOne<RowDataPacket & { name: string; employee_code: string }>(
    'SELECT name, employee_code FROM hr_users WHERE id = ? LIMIT 1',
    [userId],
  );
  return row ? { name: row.name, employeeCode: row.employee_code } : null;
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

interface RunRow extends RowDataPacket {
  id: number;
  period: string;
  period_start: string;
  period_end: string;
  status: PayrollRunStatus;
  employee_count: number;
  total_gross: string;
  total_deductions: string;
  total_net: string;
  note: string | null;
  processed_at: Date | string | null;
  approved_at: Date | string | null;
  approved_by_name: string | null;
  created_at: Date | string;
  calculated_through: string | null;
  exclusions: unknown;
}

const RUN_COLUMNS = `
  id, period,
  DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start,
  DATE_FORMAT(period_end, '%Y-%m-%d')   AS period_end,
  status, employee_count, total_gross, total_deductions, total_net, note,
  processed_at, approved_at, approved_by_name, created_at,
  DATE_FORMAT(calculated_through, '%Y-%m-%d') AS calculated_through,
  exclusions
`;

/** The driver returns JSON columns parsed or as text depending on version; accept both. */
function parseExclusions(value: unknown): PayrollExclusion[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? (list as PayrollExclusion[]) : [];
}

function toRun(row: RunRow): PayrollRun {
  return {
    id: row.id,
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    employeeCount: Number(row.employee_count),
    totalGross: paiseToAmount(toPaise(row.total_gross)),
    totalDeductions: paiseToAmount(toPaise(row.total_deductions)),
    totalNet: paiseToAmount(toPaise(row.total_net)),
    note: row.note,
    processedAt: iso(row.processed_at),
    approvedAt: iso(row.approved_at),
    approvedByName: row.approved_by_name,
    createdAt: iso(row.created_at) ?? '',
    processableFrom: row.period_start,
    approvableFrom: addDays(row.period_end, 1),
    calculatedThrough: row.calculated_through,
    provisional: row.calculated_through !== null && row.calculated_through < row.period_end,
    exclusions: parseExclusions(row.exclusions),
  };
}

export async function findRun(id: number): Promise<PayrollRun | null> {
  const row = await queryOne<RunRow>(`SELECT ${RUN_COLUMNS} FROM hr_payroll_runs WHERE id = ? LIMIT 1`, [id]);
  return row ? toRun(row) : null;
}

export async function findRunByPeriod(period: string): Promise<PayrollRun | null> {
  const row = await queryOne<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM hr_payroll_runs WHERE period = ? LIMIT 1`,
    [period],
  );
  return row ? toRun(row) : null;
}

export async function listRuns(filters: {
  status?: PayrollRunStatus;
  page: number;
  pageSize: number;
}): Promise<Page<PayrollRun>> {
  const where = filters.status ? 'WHERE status = ?' : '';
  const params: SqlParam[] = filters.status ? [filters.status] : [];
  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_payroll_runs ${where}`,
    params,
  );
  const rows = await query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM hr_payroll_runs ${where}
      ORDER BY period DESC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );
  return { items: rows.map(toRun), total: Number(count?.total ?? 0), page: filters.page, pageSize: filters.pageSize };
}

/** Runs whose period falls in `year`, oldest first. At most twelve. */
export async function runsForYear(year: number): Promise<PayrollRun[]> {
  const rows = await query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM hr_payroll_runs WHERE period LIKE ? ORDER BY period ASC`,
    [`${year}-%`],
  );
  return rows.map(toRun);
}

export async function lastApprovedRun(): Promise<PayrollRun | null> {
  const row = await queryOne<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM hr_payroll_runs WHERE status = 'approved' ORDER BY period DESC LIMIT 1`,
  );
  return row ? toRun(row) : null;
}

/** Throws ER_DUP_ENTRY when the period already has a run. */
export async function insertRun(input: {
  period: string;
  periodStart: string;
  periodEnd: string;
  note: string | null;
  createdBy: number | null;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO hr_payroll_runs (period, period_start, period_end, status, note, created_by)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
    [input.period, input.periodStart, input.periodEnd, input.note, input.createdBy],
  );
  return result.insertId;
}

/**
 * Approves a processed run. Guarded in the UPDATE itself, so two administrators cannot
 * both approve, a draft cannot be approved, and an empty run (nobody to pay) cannot be
 * frozen — a frozen empty month could never be processed again once structures exist.
 */
export async function approveRunRow(
  id: number,
  approver: { id: number | null; name: string },
): Promise<boolean> {
  const result = await execute(
    `UPDATE hr_payroll_runs
        SET status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = NOW()
      WHERE id = ? AND status = 'processed' AND employee_count > 0
        AND calculated_through IS NOT NULL AND calculated_through >= period_end`,
    [approver.id, approver.name.slice(0, 120), id],
  );
  return result.affectedRows > 0;
}

/** Deletes a draft or processed run; its payslips and lines cascade. */
export async function deleteRunRow(id: number): Promise<boolean> {
  const result = await execute(
    "DELETE FROM hr_payroll_runs WHERE id = ? AND status IN ('draft','processed')",
    [id],
  );
  return result.affectedRows > 0;
}

/* -------------------------------------------------------------------------- */
/* Processing                                                                  */
/* -------------------------------------------------------------------------- */

interface EligibleRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  department_name: string | null;
  designation_name: string | null;
  structure_id: number | null;
  next_structure_from: string | null;
}

export type PayrollCandidate = {
  userId: number;
  employeeCode: string;
  employeeName: string;
  departmentName: string | null;
  designationName: string | null;
  /** The structure in force at the period end, or null when there is none. */
  structureId: number | null;
  /** When there is none in force: the first one that starts after the period, if any. */
  nextStructureFrom: string | null;
};

/**
 * Approved accounts employed for at least one day of the period, with the structure in
 * force at its end (latest effective_from on or before `periodEnd`).
 *
 * Active or not: someone deactivated on the 20th still worked the first nineteen days.
 * DELETED is different: an administrator deleting an employee takes them out of every pay
 * period not yet approved, the current one included (the user's rule, 2026-10-28). Only
 * approved periods keep their payslips, and those are never recalculated.
 *
 * A NULL joining date means employed throughout — HR has not recorded one, and refusing
 * to pay them would be the wrong failure. The caller splits off the ones without a
 * structure (reported, not paid).
 */
export async function payrollCandidates(periodStart: string, periodEnd: string): Promise<PayrollCandidate[]> {
  const rows = await query<EligibleRow>(
    `SELECT u.id, u.employee_code, u.name, d.name AS department_name, g.name AS designation_name,
            (SELECT s.id FROM hr_salary_structures s
              WHERE s.user_id = u.id AND s.effective_from <= ?
              ORDER BY s.effective_from DESC LIMIT 1) AS structure_id,
            (SELECT DATE_FORMAT(MIN(s.effective_from), '%Y-%m-%d') FROM hr_salary_structures s
              WHERE s.user_id = u.id AND s.effective_from > ?) AS next_structure_from
       FROM hr_users u
       LEFT JOIN hr_departments d  ON d.id = u.department_id
       LEFT JOIN hr_designations g ON g.id = u.designation_id
      WHERE u.approval_status = 'approved'
        AND u.deleted_at IS NULL
        AND (u.joining_date IS NULL OR u.joining_date <= ?)
        AND (u.exit_date IS NULL OR u.exit_date >= ?)
      ORDER BY u.id ASC`,
    [periodEnd, periodEnd, periodEnd, periodStart],
  );
  return rows.map((row) => ({
    userId: row.id,
    employeeCode: row.employee_code,
    employeeName: row.name,
    departmentName: row.department_name,
    designationName: row.designation_name,
    structureId: row.structure_id === null ? null : Number(row.structure_id),
    nextStructureFrom: row.next_structure_from,
  }));
}

/** Days as stored: DECIMAL(5,1), carried here as tenths. */
export type DayTenths = {
  daysInPeriod: number;
  unemployed: number;
  weeklyOff: number;
  holiday: number;
  present: number;
  paidLeave: number;
  unpaidLeave: number;
  absent: number;
  untracked: number;
  /** Days after the calculation date: not yet paid, not loss of pay. */
  remaining: number;
  lop: number;
  /** Loss of pay an administrator waived by paying in full (already out of `lop`). */
  lopWaived: number;
  paid: number;
};

export type ComputedPayslip = PayrollCandidate & {
  structureId: number;
  days: DayTenths;
  /** Why the employee is paid in full this period, when an administrator decided so. */
  fullPayReason: string | null;
  grossPaise: number;
  lopPaise: number;
  deductionsPaise: number;
  netPaise: number;
  lines: Array<{ label: string; kind: ComponentKind; fullPaise: number; amountPaise: number; sortOrder: number }>;
};

export class RunChangedError extends Error {
  constructor(readonly reason: 'missing' | 'approved' | 'structures_changed') {
    super(reason);
  }
}

const tenths = (value: number) => (value / 10).toFixed(1);

/**
 * Replaces a run's payslips with `slips` and rolls the totals onto it, in ONE
 * transaction.
 *
 * The run row is locked first and its status re-read under the lock, so an approval
 * that landed after the caller's check wins cleanly (this refuses) and an approval that
 * arrives during the write waits and then approves what was written. The structures
 * used are share-locked and counted, so one deleted in the meantime aborts the write
 * instead of leaving a payslip pointing at nothing.
 *
 * Payslips are inserted in batches and their ids read back by (run_id, user_id) — which
 * is unique — rather than assumed consecutive: InnoDB does not promise consecutive ids
 * for a multi-row insert under the interleaved auto-increment lock mode.
 */
export async function replacePayslips(
  runId: number,
  slips: ComputedPayslip[],
  processedBy: number | null,
  outcome: { calculatedThrough: string; exclusions: PayrollExclusion[] },
): Promise<void> {
  await withTransaction(async (connection: PoolConnection) => {
    const [locked] = await connection.execute<RowDataPacket[]>(
      'SELECT status FROM hr_payroll_runs WHERE id = ? FOR UPDATE',
      [runId],
    );
    const run = locked[0];
    if (!run) throw new RunChangedError('missing');
    if (run.status === 'approved') throw new RunChangedError('approved');

    const structureIds = [...new Set(slips.map((slip) => slip.structureId))];
    if (structureIds.length > 0) {
      const [present] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM hr_salary_structures WHERE id IN (${idList(structureIds)}) LOCK IN SHARE MODE`,
      );
      if (present.length !== structureIds.length) throw new RunChangedError('structures_changed');
    }

    // Lines go with them (ON DELETE CASCADE).
    await connection.execute('DELETE FROM hr_payslips WHERE run_id = ?', [runId]);

    for (const batch of chunks(slips, 100)) {
      const params: SqlParam[] = [];
      const values = batch.map((slip) => {
        params.push(
          runId,
          slip.userId,
          slip.structureId,
          slip.employeeCode.slice(0, 24),
          slip.employeeName.slice(0, 120),
          slip.departmentName ? slip.departmentName.slice(0, 120) : null,
          slip.designationName ? slip.designationName.slice(0, 120) : null,
          slip.days.daysInPeriod / 10,
          tenths(slip.days.unemployed),
          tenths(slip.days.weeklyOff),
          tenths(slip.days.holiday),
          tenths(slip.days.present),
          tenths(slip.days.paidLeave),
          tenths(slip.days.unpaidLeave),
          tenths(slip.days.absent),
          tenths(slip.days.untracked),
          tenths(slip.days.remaining),
          tenths(slip.days.lop),
          tenths(slip.days.lopWaived),
          slip.fullPayReason ? slip.fullPayReason.slice(0, 500) : null,
          tenths(slip.days.paid),
          paiseToDecimal(slip.grossPaise),
          paiseToDecimal(slip.lopPaise),
          paiseToDecimal(slip.deductionsPaise),
          paiseToDecimal(slip.netPaise),
        );
        return `(${new Array(25).fill('?').join(', ')})`;
      });
      await connection.execute(
        `INSERT INTO hr_payslips
           (run_id, user_id, structure_id, employee_code, employee_name, department_name,
            designation_name, days_in_period, unemployed_days, weekly_off_days, holiday_days,
            present_days, paid_leave_days, unpaid_leave_days, absent_days, untracked_days,
            remaining_days, lop_days, lop_waived_days, full_pay_reason, paid_days,
            gross_earnings, lop_amount, total_deductions, net_pay)
         VALUES ${values.join(', ')}`,
        params,
      );
    }

    const [inserted] = await connection.execute<RowDataPacket[]>(
      'SELECT id, user_id FROM hr_payslips WHERE run_id = ?',
      [runId],
    );
    const payslipIdByUser = new Map(inserted.map((row) => [Number(row.user_id), Number(row.id)]));

    const lines = slips.flatMap((slip) =>
      slip.lines.map((line) => ({ payslipId: payslipIdByUser.get(slip.userId)!, ...line })),
    );
    for (const batch of chunks(lines, 400)) {
      const params: SqlParam[] = [];
      const values = batch.map((line) => {
        params.push(
          line.payslipId,
          line.label.slice(0, 80),
          line.kind,
          paiseToDecimal(line.fullPaise),
          paiseToDecimal(line.amountPaise),
          line.sortOrder,
        );
        return '(?, ?, ?, ?, ?, ?)';
      });
      await connection.execute(
        `INSERT INTO hr_payslip_lines (payslip_id, label, kind, full_amount, amount, sort_order)
         VALUES ${values.join(', ')}`,
        params,
      );
    }

    const total = (pick: (slip: ComputedPayslip) => number) => slips.reduce((sum, slip) => sum + pick(slip), 0);
    await connection.execute(
      `UPDATE hr_payroll_runs
          SET status = 'processed', employee_count = ?, total_gross = ?, total_deductions = ?,
              total_net = ?, processed_by = ?, processed_at = NOW(),
              calculated_through = ?, exclusions = ?
        WHERE id = ?`,
      [
        slips.length,
        paiseToDecimal(total((slip) => slip.grossPaise)),
        paiseToDecimal(total((slip) => slip.deductionsPaise)),
        paiseToDecimal(total((slip) => slip.netPaise)),
        processedBy,
        outcome.calculatedThrough,
        JSON.stringify(outcome.exclusions),
        runId,
      ],
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Paying in full                                                              */
/* -------------------------------------------------------------------------- */

/** Who is paid in full in a pay period, and why — by employee. */
export async function fullPayFor(runId: number): Promise<Map<number, string>> {
  const rows = await query<RowDataPacket & { user_id: number; reason: string }>(
    'SELECT user_id, reason FROM hr_payroll_full_pay WHERE run_id = ?',
    [runId],
  );
  return new Map(rows.map((row) => [Number(row.user_id), row.reason]));
}

/** Records (or replaces) the decision to pay one employee in full for a pay period. */
export async function setFullPay(
  runId: number,
  userId: number,
  reason: string,
  setBy: { id: number | null; name: string },
): Promise<void> {
  await execute(
    `INSERT INTO hr_payroll_full_pay (run_id, user_id, reason, set_by, set_by_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), set_by = VALUES(set_by),
                             set_by_name = VALUES(set_by_name), created_at = CURRENT_TIMESTAMP`,
    [runId, userId, reason, setBy.id, setBy.name.slice(0, 160)],
  );
}

/** Withdraws it. Returns whether there was one. */
export async function clearFullPay(runId: number, userId: number): Promise<boolean> {
  const result = await execute('DELETE FROM hr_payroll_full_pay WHERE run_id = ? AND user_id = ?', [runId, userId]);
  return result.affectedRows > 0;
}

/* -------------------------------------------------------------------------- */
/* Payslips                                                                    */
/* -------------------------------------------------------------------------- */

interface PayslipRow extends RowDataPacket {
  id: number;
  run_id: number;
  period: string;
  period_start: string;
  period_end: string;
  run_status: PayrollRunStatus;
  approved_at: Date | string | null;
  user_id: number;
  structure_id: number | null;
  employee_code: string;
  employee_name: string;
  department_name: string | null;
  designation_name: string | null;
  days_in_period: number;
  unemployed_days: string;
  weekly_off_days: string;
  holiday_days: string;
  present_days: string;
  paid_leave_days: string;
  unpaid_leave_days: string;
  absent_days: string;
  untracked_days: string;
  remaining_days: string;
  lop_days: string;
  lop_waived_days: string;
  full_pay_reason: string | null;
  paid_days: string;
  gross_earnings: string;
  lop_amount: string;
  total_deductions: string;
  net_pay: string;
}

const PAYSLIP_SELECT = `
  SELECT p.id, p.run_id, r.period,
         DATE_FORMAT(r.period_start, '%Y-%m-%d') AS period_start,
         DATE_FORMAT(r.period_end, '%Y-%m-%d')   AS period_end,
         r.status AS run_status, r.approved_at,
         p.user_id, p.structure_id, p.employee_code, p.employee_name,
         p.department_name, p.designation_name,
         p.days_in_period, p.unemployed_days, p.weekly_off_days, p.holiday_days,
         p.present_days, p.paid_leave_days, p.unpaid_leave_days, p.absent_days,
         p.untracked_days, p.remaining_days, p.lop_days, p.lop_waived_days, p.full_pay_reason, p.paid_days,
         p.gross_earnings, p.lop_amount, p.total_deductions, p.net_pay
    FROM hr_payslips p
    JOIN hr_payroll_runs r ON r.id = p.run_id
`;

interface LineRow extends RowDataPacket {
  payslip_id: number;
  label: string;
  kind: ComponentKind;
  full_amount: string;
  amount: string;
}

async function linesFor(payslipIds: number[]): Promise<Map<number, PayslipLine[]>> {
  const result = new Map<number, PayslipLine[]>();
  if (payslipIds.length === 0) return result;
  const rows = await query<LineRow>(
    `SELECT payslip_id, label, kind, full_amount, amount
       FROM hr_payslip_lines
      WHERE payslip_id IN (${idList(payslipIds)})
      ORDER BY payslip_id ASC, FIELD(kind, 'earning', 'deduction'), sort_order ASC, id ASC`,
  );
  for (const row of rows) {
    const list = result.get(row.payslip_id) ?? [];
    list.push({
      label: row.label,
      kind: row.kind,
      fullAmount: paiseToAmount(toPaise(row.full_amount)),
      amount: paiseToAmount(toPaise(row.amount)),
    });
    result.set(row.payslip_id, list);
  }
  return result;
}

const days = (value: string | number) => Number(value);
const money = (value: string) => paiseToAmount(toPaise(value));

function toPayslip(row: PayslipRow, lines: PayslipLine[]): Payslip {
  return {
    id: row.id,
    runId: row.run_id,
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    runStatus: row.run_status,
    approvedAt: iso(row.approved_at),
    userId: row.user_id,
    structureId: row.structure_id === null ? null : Number(row.structure_id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    departmentName: row.department_name,
    designationName: row.designation_name,
    daysInPeriod: days(row.days_in_period),
    unemployedDays: days(row.unemployed_days),
    weeklyOffDays: days(row.weekly_off_days),
    holidayDays: days(row.holiday_days),
    presentDays: days(row.present_days),
    paidLeaveDays: days(row.paid_leave_days),
    unpaidLeaveDays: days(row.unpaid_leave_days),
    absentDays: days(row.absent_days),
    untrackedDays: days(row.untracked_days),
    remainingDays: days(row.remaining_days),
    lopDays: days(row.lop_days),
    lopWaivedDays: days(row.lop_waived_days),
    fullPayReason: row.full_pay_reason,
    paidDays: days(row.paid_days),
    grossEarnings: money(row.gross_earnings),
    lopAmount: money(row.lop_amount),
    totalDeductions: money(row.total_deductions),
    netPay: money(row.net_pay),
    lines,
  };
}

async function withLines(rows: PayslipRow[]): Promise<Payslip[]> {
  const lines = await linesFor(rows.map((row) => row.id));
  return rows.map((row) => toPayslip(row, lines.get(row.id) ?? []));
}

/** Any payslip, any status — the admin view. */
export async function findPayslip(id: number): Promise<Payslip | null> {
  const row = await queryOne<PayslipRow>(`${PAYSLIP_SELECT} WHERE p.id = ? LIMIT 1`, [id]);
  return row ? ((await withLines([row]))[0] ?? null) : null;
}

/**
 * The employee's own payslip, and only once its run is APPROVED.
 *
 * Both conditions are in the WHERE clause, so a draft payslip and somebody else's
 * payslip are the same "not found" — the app cannot tell which, and neither can anyone
 * probing ids.
 */
export async function findPayslipForEmployee(id: number, userId: number): Promise<Payslip | null> {
  const row = await queryOne<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.id = ? AND p.user_id = ? AND r.status = 'approved' LIMIT 1`,
    [id, userId],
  );
  return row ? ((await withLines([row]))[0] ?? null) : null;
}

export async function listRunPayslips(
  runId: number,
  filters: { q?: string; page: number; pageSize: number },
): Promise<Page<Payslip>> {
  const conditions = ['p.run_id = ?'];
  const params: SqlParam[] = [runId];
  if (filters.q) {
    conditions.push('(p.employee_name LIKE ? OR p.employee_code LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_payslips p ${where}`,
    params,
  );
  const rows = await query<PayslipRow>(
    `${PAYSLIP_SELECT} ${where}
      ORDER BY p.employee_name ASC, p.id ASC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );
  return {
    items: await withLines(rows),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/**
 * Every payslip of one run, without lines, for the CSV. Bounded by the run — one row per
 * employee paid that month — which is the bound the export rule asks for.
 */
export async function allRunPayslips(runId: number): Promise<Payslip[]> {
  const rows = await query<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.run_id = ? ORDER BY p.employee_name ASC, p.id ASC`,
    [runId],
  );
  return rows.map((row) => toPayslip(row, []));
}

export async function payslipOwners(runId: number): Promise<Array<{ payslipId: number; userId: number }>> {
  const rows = await query<RowDataPacket & { id: number; user_id: number }>(
    'SELECT id, user_id FROM hr_payslips WHERE run_id = ?',
    [runId],
  );
  return rows.map((row) => ({ payslipId: Number(row.id), userId: Number(row.user_id) }));
}

function toSummary(row: PayslipRow): PayslipSummary {
  return {
    id: row.id,
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    netPay: money(row.net_pay),
    grossEarnings: money(row.gross_earnings),
    totalDeductions: money(row.total_deductions),
    lopDays: days(row.lop_days),
    paidDays: days(row.paid_days),
    approvedAt: iso(row.approved_at),
  };
}

/** The employee's own payslips of APPROVED runs, newest period first. */
export async function listPayslipsForEmployee(
  userId: number,
  filters: { year?: number; page: number; pageSize: number },
): Promise<Page<PayslipSummary>> {
  const conditions = ['p.user_id = ?', "r.status = 'approved'"];
  const params: SqlParam[] = [userId];
  if (filters.year) {
    conditions.push('r.period LIKE ?');
    params.push(`${filters.year}-%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_payslips p JOIN hr_payroll_runs r ON r.id = p.run_id ${where}`,
    params,
  );
  const rows = await query<PayslipRow>(
    `${PAYSLIP_SELECT} ${where}
      ORDER BY r.period DESC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );
  return {
    items: rows.map(toSummary),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function latestApprovedPayslipRow(
  userId: number,
): Promise<{ id: number; period: string; netPay: number } | null> {
  const row = await queryOne<RowDataPacket & { id: number; period: string; net_pay: string }>(
    `SELECT p.id, r.period, p.net_pay
       FROM hr_payslips p
       JOIN hr_payroll_runs r ON r.id = p.run_id
      WHERE p.user_id = ? AND r.status = 'approved'
      ORDER BY r.period DESC
      LIMIT 1`,
    [userId],
  );
  return row ? { id: Number(row.id), period: row.period, netPay: money(row.net_pay) } : null;
}
