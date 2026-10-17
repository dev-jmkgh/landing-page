import type { Response } from 'express';
import { query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { badRequest } from '../../../utils/httpError';
import { describeError, logger } from '../../../utils/logger';
import { COMPANY_UTC_OFFSET, type WorkMode } from '../attendance/attendance.schema';
import {
  addDays,
  calendarForUsers,
  companyToday,
  daysBetween,
  isIsoDate,
  verdictOf,
  type CalendarDay,
  type CalendarDayStatus,
  type LeaveKind,
} from '../calendar/calendar.service';
import { HR_USER_FROM } from '../hr.repository';
import type { HrEmploymentStatus, HrEmploymentType, Page } from '../hr.schema';
import type { PayrollRun } from '../payroll/payroll.schema';
import { payrollRunsForYear } from '../payroll/payroll.service';
import { companyDateTime } from './companyClock';
import { CsvStream, type CsvValue } from './csv';
import { leaveBalancesForUsers, leaveTypesForYear } from './figures';

/**
 * HR reports for the admin portal: attendance (summary and day by day), leave, the
 * employee directory, payroll by year, and the HR audit trail.
 *
 * EVERY DAY IS CLASSIFIED BY THE CALENDAR SERVICE. Present, absent, on leave, holiday
 * and weekly off come from `calendarForUsers`, the same function leave day counts and
 * payroll's loss of pay use — so a report can never call a day "absent" that the
 * payslip paid as a holiday. Nothing here re-derives a day from the attendance table.
 *
 * Each report pages over EMPLOYEES in JSON (the screen shows one page at a time) and
 * streams the whole result as CSV (`format=csv`). The CSV is bounded by the validated
 * date range, never by "the first N rows" — a truncated export that looks complete is
 * worse than a refusal.
 */

/* -------------------------------------------------------------------------- */
/* Ranges                                                                      */
/* -------------------------------------------------------------------------- */

export const REPORT_LIMITS = {
  /** The attendance summary, JSON and CSV: a quarter. */
  attendanceDays: 93,
  /** The day-by-day report on screen: a month of rows per person is already a lot of paging. */
  dailyJsonDays: 31,
  /** The day-by-day CSV: a quarter. */
  dailyCsvDays: 93,
} as const;

export type DateRange = { from: string; to: string; days: number };

/**
 * A validated, inclusive company-calendar range. Defaults to the current month so far.
 *
 * The regex on the query only checks the SHAPE — `2026-02-30` has the right shape — so
 * real-date validity is checked here too, before it reaches SQL and comes back as NULL.
 */
export function resolveRange(input: { from?: string; to?: string }, maxDays: number): DateRange {
  const to = input.to ?? companyToday();
  const from = input.from ?? `${to.slice(0, 7)}-01`;

  if (!isIsoDate(from)) throw badRequest('Enter a real start date.', { from: 'Enter a real date.' });
  if (!isIsoDate(to)) throw badRequest('Enter a real end date.', { to: 'Enter a real date.' });
  if (from > to) {
    throw badRequest('The start date must be on or before the end date.', {
      from: 'Must be on or before the end date.',
    });
  }

  const days = daysBetween(from, to) + 1;
  if (days > maxDays) {
    throw badRequest(`Choose a range of ${maxDays} days or fewer. This one covers ${days} days.`, {
      to: `Choose a range of ${maxDays} days or fewer.`,
    });
  }
  return { from, to, days };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** `on_leave` → `On leave`. For CSV cells a person reads; JSON keeps the codes. */
export function humanise(code: string | null | undefined): string | null {
  if (!code) return null;
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const paise = (value: number): number => Math.round(value * 100);

function likeTerm(value: string): string {
  return `%${value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

/**
 * Runs an export. A failure before the first row went out is rethrown and becomes the
 * usual JSON error. A failure AFTER cannot (the error handler skips a response whose
 * headers are sent, which would leave it hanging), so it is logged and the connection
 * is cut — the download fails visibly instead of stopping short and looking complete.
 */
async function streamCsv(
  response: Response,
  filename: string,
  header: string[],
  produce: (csv: CsvStream) => Promise<void>,
): Promise<void> {
  const csv = new CsvStream(response, filename, header);
  try {
    await produce(csv);
    csv.end();
  } catch (error) {
    if (!csv.started) throw error;
    logger.error('HR report export failed part-way', { filename, ...describeError(error) });
    response.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* Which employees a report covers                                             */
/* -------------------------------------------------------------------------- */

export type EmployeeScope = {
  departmentId?: number;
  designationId?: number;
  userId?: number;
  /** The ASSIGNED site, as the register filters it. */
  locationId?: number;
  employmentStatus?: HrEmploymentStatus;
  active?: boolean;
  q?: string;
};

/**
 * What makes an account part of a period's report.
 *
 * Approved accounts whose employment overlaps the period, that are either still active
 * or have activity in it. The second half matters: somebody who left in the middle of
 * the month worked half of it, and switching their account off must not delete those
 * days from the month's report — but a long-gone account with nothing in the period
 * should not pad every report with a row of zeros.
 */
type Activity = { kind: 'attendance' | 'leave'; from: string; to: string };

function scopeWhere(scope: EmployeeScope, activity: Activity | null): { where: string; params: SqlParam[] } {
  const conditions = ["u.approval_status = 'approved'"];
  const params: SqlParam[] = [];

  if (activity) {
    conditions.push('(u.joining_date IS NULL OR u.joining_date <= ?)', '(u.exit_date IS NULL OR u.exit_date >= ?)');
    params.push(activity.to, activity.from);
    if (scope.active === undefined) {
      conditions.push(
        activity.kind === 'attendance'
          ? `(u.is_active = 1 OR EXISTS (SELECT 1 FROM hr_attendance x
               WHERE x.user_id = u.id AND x.work_date BETWEEN ? AND ?))`
          : `(u.is_active = 1 OR EXISTS (SELECT 1 FROM hr_leave_requests x
               WHERE x.user_id = u.id AND x.status = 'approved' AND x.start_date BETWEEN ? AND ?))`,
      );
      params.push(activity.from, activity.to);
    }
  }
  if (scope.active !== undefined) {
    conditions.push('u.is_active = ?');
    params.push(scope.active ? 1 : 0);
  }
  if (scope.departmentId) {
    conditions.push('u.department_id = ?');
    params.push(scope.departmentId);
  }
  if (scope.designationId) {
    conditions.push('u.designation_id = ?');
    params.push(scope.designationId);
  }
  if (scope.userId) {
    conditions.push('u.id = ?');
    params.push(scope.userId);
  }
  if (scope.locationId) {
    conditions.push('u.work_location_id = ?');
    params.push(scope.locationId);
  }
  if (scope.employmentStatus) {
    conditions.push('u.employment_status = ?');
    params.push(scope.employmentStatus);
  }
  if (scope.q) {
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR u.employee_code LIKE ?)');
    const term = likeTerm(scope.q);
    params.push(term, term, term);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

interface EmployeeRow extends RowDataPacket {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  phone: string | null;
  is_active: number;
  department_name: string | null;
  designation_name: string | null;
  manager_name: string | null;
  joining_date: string | null;
  exit_date: string | null;
  employment_type: HrEmploymentType;
  employment_status: HrEmploymentStatus;
  work_mode: WorkMode;
  location_name: string | null;
  shift_name: string | null;
}

const EMPLOYEE_COLUMNS = `
  u.id, u.employee_code, u.name, u.email, u.phone, u.is_active,
  d.name AS department_name, g.name AS designation_name, m.name AS manager_name,
  DATE_FORMAT(u.joining_date, '%Y-%m-%d') AS joining_date,
  DATE_FORMAT(u.exit_date, '%Y-%m-%d')    AS exit_date,
  u.employment_type, u.employment_status, u.work_mode,
  l.name AS location_name, s.name AS shift_name
`;

async function countEmployees(filter: { where: string; params: SqlParam[] }): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_users u ${filter.where}`,
    filter.params,
  );
  return Number(row?.total ?? 0);
}

/**
 * One window of employees, by name. LIMIT/OFFSET are interpolated: they are integers
 * computed here from Zod-validated, bounded page parameters (MySQL's prepared protocol
 * does not take placeholders there reliably).
 */
async function employeeWindow(
  filter: { where: string; params: SqlParam[] },
  limit: number,
  offset: number,
): Promise<EmployeeRow[]> {
  if (limit <= 0) return [];
  return query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM ${HR_USER_FROM}
       ${filter.where}
      ORDER BY u.name ASC, u.id ASC
      LIMIT ${Math.floor(limit)} OFFSET ${Math.max(0, Math.floor(offset))}`,
    filter.params,
  );
}

/**
 * Every employee in the scope, a batch at a time — for exports. 200 matches the
 * calendar's comfortable batch size: five queries per batch however long the range.
 */
async function forEachEmployeeBatch(
  filter: { where: string; params: SqlParam[] },
  handle: (rows: EmployeeRow[]) => Promise<boolean | void>,
  size = 200,
): Promise<void> {
  for (let offset = 0; ; offset += size) {
    const rows = await employeeWindow(filter, size, offset);
    if (rows.length === 0) return;
    if ((await handle(rows)) === false) return;
    if (rows.length < size) return;
  }
}

/* -------------------------------------------------------------------------- */
/* Attendance summary — one row per employee over a range                      */
/* -------------------------------------------------------------------------- */

export type AttendanceReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  designationName: string | null;
  workMode: WorkMode;
  locationName: string | null;
  /** Calendar days in the range. Every status count below adds up to this. */
  days: number;
  /** present + late + halfDay. */
  attended: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holidays: number;
  weeklyOffs: number;
  /** Today or later, not judged yet. */
  upcoming: number;
  /** Before attendance tracking began (HR setting). */
  untracked: number;
  notEmployed: number;
  /** Days covered by an approved work-from-home / field-work request. */
  wfhDays: number;
  fieldDays: number;
  /** Sum over days with closed sessions. */
  totalWorkedMinutes: number;
  /** Over days that produced hours; null when none did — never an invented zero. */
  averageWorkedMinutes: number | null;
  totalLateMinutes: number;
  missingPunches: number;
  flagged: number;
};

function summarise(employee: EmployeeRow, days: CalendarDay[]): AttendanceReportRow {
  // Totals count verdicts; a day still in progress counts as what it is so far.
  const count = (status: CalendarDayStatus) => days.filter((day) => verdictOf(day) === status).length;
  const worked = days
    .map((day) => day.attendance?.workedMinutes)
    .filter((value): value is number => typeof value === 'number');
  const totalWorked = worked.reduce((sum, value) => sum + value, 0);

  const present = count('present');
  const late = count('late');
  const halfDay = count('half_day');

  return {
    userId: employee.id,
    employeeCode: employee.employee_code,
    name: employee.name,
    departmentName: employee.department_name,
    designationName: employee.designation_name,
    workMode: employee.work_mode,
    locationName: employee.location_name,
    days: days.length,
    attended: present + late + halfDay,
    present,
    late,
    halfDay,
    absent: count('absent'),
    onLeave: count('on_leave'),
    holidays: count('holiday'),
    weeklyOffs: count('weekly_off'),
    upcoming: count('upcoming'),
    untracked: count('untracked'),
    notEmployed: count('not_employed'),
    wfhDays: days.filter((day) => day.leave?.kind === 'wfh').length,
    fieldDays: days.filter((day) => day.leave?.kind === 'field').length,
    totalWorkedMinutes: totalWorked,
    averageWorkedMinutes: worked.length > 0 ? Math.round(totalWorked / worked.length) : null,
    totalLateMinutes: days.reduce((sum, day) => sum + (day.attendance?.lateMinutes ?? 0), 0),
    missingPunches: days.filter((day) => day.attendance?.missingPunch).length,
    flagged: days.filter((day) => day.attendance?.flagged).length,
  };
}

async function summariseBatch(rows: EmployeeRow[], range: DateRange): Promise<AttendanceReportRow[]> {
  if (rows.length === 0) return [];
  const calendars = await calendarForUsers(rows.map((row) => row.id), range.from, range.to);
  return rows.map((row) => summarise(row, calendars.get(row.id) ?? []));
}

export async function attendanceReport(
  scope: EmployeeScope,
  range: DateRange,
  paging: { page: number; pageSize: number },
): Promise<Page<AttendanceReportRow> & { from: string; to: string }> {
  const filter = scopeWhere(scope, { kind: 'attendance', from: range.from, to: range.to });
  const total = await countEmployees(filter);
  const rows = await employeeWindow(filter, paging.pageSize, (paging.page - 1) * paging.pageSize);
  return {
    from: range.from,
    to: range.to,
    items: await summariseBatch(rows, range),
    total,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

const ATTENDANCE_CSV_HEADER = [
  'Employee code', 'Name', 'Department', 'Designation', 'Work mode', 'Site', 'From', 'To',
  'Days', 'Attended', 'Present', 'Late', 'Half day', 'Absent', 'On leave', 'Holidays',
  'Weekly offs', 'Upcoming', 'Untracked', 'Not employed', 'WFH days', 'Field days',
  'Worked minutes', 'Average worked minutes', 'Late minutes', 'Missing punches', 'Flagged days',
];

export async function exportAttendanceCsv(scope: EmployeeScope, range: DateRange, response: Response): Promise<void> {
  const filter = scopeWhere(scope, { kind: 'attendance', from: range.from, to: range.to });
  await streamCsv(response, `hr-attendance-${range.from}-to-${range.to}.csv`, ATTENDANCE_CSV_HEADER, async (csv) => {
    await forEachEmployeeBatch(filter, async (rows) => {
      if (csv.aborted) return false;
      const summaries = await summariseBatch(rows, range);
      await csv.write(
        summaries.map((row): CsvValue[] => [
          row.employeeCode, row.name, row.departmentName, row.designationName, humanise(row.workMode),
          row.locationName, range.from, range.to, row.days, row.attended, row.present, row.late,
          row.halfDay, row.absent, row.onLeave, row.holidays, row.weeklyOffs, row.upcoming,
          row.untracked, row.notEmployed, row.wfhDays, row.fieldDays, row.totalWorkedMinutes,
          row.averageWorkedMinutes, row.totalLateMinutes, row.missingPunches, row.flagged,
        ]),
      );
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Attendance day by day — one row per employee per date                       */
/* -------------------------------------------------------------------------- */

export type DailyReportRow = {
  date: string;
  weekday: string;
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  status: CalendarDayStatus;
  /** First check-in, ISO UTC. */
  firstIn: string | null;
  /** Last check-out, ISO UTC; null while a session is open or nothing was recorded. */
  lastOut: string | null;
  workedMinutes: number | null;
  /** Null when there is no attendance for the day — not late is not the same as not there. */
  lateMinutes: number | null;
  late: boolean;
  /** As recorded on the day (an approved WFH day records 'remote'). */
  workMode: WorkMode | null;
  /** The site the first punch was made against, when there was one. */
  site: string | null;
  leaveType: string | null;
  holiday: string | null;
  missingPunch: boolean;
  flagged: boolean;
};

/**
 * The site of each day's FIRST punch. Read from the sessions — since migration 019 the
 * day row is a roll-up and its own location column is only set on days from before then
 * — falling back to that column for those old days.
 */
async function sitesFor(userIds: number[], range: DateRange): Promise<Map<string, string>> {
  const sites = new Map<string, string>();
  if (userIds.length === 0) return sites;
  const rows = await query<RowDataPacket & { user_id: number; work_date: string; site_name: string }>(
    `SELECT a.user_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date, l.name AS site_name
       FROM hr_attendance a
       LEFT JOIN hr_attendance_sessions s ON s.attendance_id = a.id
       JOIN hr_work_locations l ON l.id = COALESCE(s.in_location_id, a.check_in_location_id)
      WHERE a.user_id IN (${userIds.map(Number).join(',')}) AND a.work_date BETWEEN ? AND ?
      ORDER BY s.started_at ASC`,
    [range.from, range.to],
  );
  for (const row of rows) {
    const key = `${row.user_id}:${row.work_date}`;
    if (!sites.has(key)) sites.set(key, row.site_name);
  }
  return sites;
}

async function dailyRowsFor(rows: EmployeeRow[], range: DateRange): Promise<DailyReportRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [calendars, sites] = await Promise.all([
    calendarForUsers(ids, range.from, range.to),
    sitesFor(ids, range),
  ]);

  const out: DailyReportRow[] = [];
  for (const employee of rows) {
    for (const day of calendars.get(employee.id) ?? []) {
      const attendance = day.attendance;
      out.push({
        date: day.date,
        weekday: day.weekday,
        userId: employee.id,
        employeeCode: employee.employee_code,
        name: employee.name,
        departmentName: employee.department_name,
        status: day.status,
        firstIn: attendance?.checkedInAt ?? null,
        lastOut: attendance?.checkedOutAt ?? null,
        workedMinutes: attendance?.workedMinutes ?? null,
        lateMinutes: attendance ? attendance.lateMinutes : null,
        late: (attendance?.lateMinutes ?? 0) > 0,
        workMode: attendance?.workMode ?? null,
        site: sites.get(`${employee.id}:${day.date}`) ?? null,
        leaveType: day.leave?.typeName ?? null,
        holiday: day.holiday?.name ?? null,
        missingPunch: attendance?.missingPunch ?? false,
        flagged: attendance?.flagged ?? false,
      });
    }
  }
  return out;
}

/**
 * Paged over (employee, date) rows, employee-major: each employee's days in order, then
 * the next employee. That keeps a page a CONTIGUOUS window of employees, so one page is
 * one employee query and one calendar load, whatever the page number.
 */
export async function dailyReport(
  scope: EmployeeScope,
  range: DateRange,
  paging: { page: number; pageSize: number },
): Promise<Page<DailyReportRow> & { from: string; to: string }> {
  const filter = scopeWhere(scope, { kind: 'attendance', from: range.from, to: range.to });
  const employees = await countEmployees(filter);
  const total = employees * range.days;

  const offset = (paging.page - 1) * paging.pageSize;
  let items: DailyReportRow[] = [];
  if (offset < total) {
    const firstEmployee = Math.floor(offset / range.days);
    const lastEmployee = Math.min(employees - 1, Math.floor((offset + paging.pageSize - 1) / range.days));
    const window = await employeeWindow(filter, lastEmployee - firstEmployee + 1, firstEmployee);
    const rows = await dailyRowsFor(window, range);
    const skip = offset - firstEmployee * range.days;
    items = rows.slice(skip, skip + paging.pageSize);
  }

  return { from: range.from, to: range.to, items, total, page: paging.page, pageSize: paging.pageSize };
}

const DAILY_CSV_HEADER = [
  'Date', 'Weekday', 'Employee code', 'Name', 'Department', 'Status', 'First in', 'Last out',
  'Worked minutes', 'Late minutes', 'Late', 'Work mode', 'Site', 'Leave', 'Holiday',
  'Missing punch', 'Flagged',
];

export async function exportDailyCsv(scope: EmployeeScope, range: DateRange, response: Response): Promise<void> {
  const filter = scopeWhere(scope, { kind: 'attendance', from: range.from, to: range.to });
  // Fewer employees per batch: each one is up to 93 rows.
  await streamCsv(response, `hr-attendance-daily-${range.from}-to-${range.to}.csv`, DAILY_CSV_HEADER, async (csv) => {
    await forEachEmployeeBatch(
      filter,
      async (rows) => {
        if (csv.aborted) return false;
        const days = await dailyRowsFor(rows, range);
        await csv.write(
          days.map((row): CsvValue[] => [
            row.date, humanise(row.weekday), row.employeeCode, row.name, row.departmentName,
            humanise(row.status), companyDateTime(row.firstIn), companyDateTime(row.lastOut),
            row.workedMinutes, row.lateMinutes, row.late, humanise(row.workMode), row.site,
            row.leaveType, row.holiday, row.missingPunch, row.flagged,
          ]),
        );
      },
      50,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Leave — per employee per type, for one year                                 */
/* -------------------------------------------------------------------------- */

export type LeaveReportCell = {
  leaveTypeId: number;
  code: string;
  name: string;
  kind: LeaveKind;
  isPaid: boolean;
  tracked: boolean;
  /** Null when untracked — there is no entitlement to show. */
  entitled: number | null;
  used: number;
  pending: number;
  available: number | null;
};

export type LeaveReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  designationName: string | null;
  types: LeaveReportCell[];
  /** Approved days of the arrangements that have no balance by design. */
  untrackedUsage: { wfh: number; field: number; unpaid: number };
};

async function leaveRowsFor(rows: EmployeeRow[], year: number): Promise<LeaveReportRow[]> {
  if (rows.length === 0) return [];
  const types = await leaveTypesForYear(year);
  const balances = await leaveBalancesForUsers(rows.map((row) => row.id), year, types);

  return rows.map((employee) => {
    const cells = (balances.get(employee.id) ?? []).map(
      (balance): LeaveReportCell => ({
        leaveTypeId: balance.leaveType.id,
        code: balance.leaveType.code,
        name: balance.leaveType.name,
        kind: balance.leaveType.kind,
        isPaid: balance.leaveType.isPaid,
        tracked: balance.tracked,
        entitled: balance.entitled,
        used: balance.used,
        pending: balance.pending,
        available: balance.available,
      }),
    );
    // Summed in tenths: day counts are DECIMAL(5,1).
    const usedOf = (match: (cell: LeaveReportCell) => boolean) =>
      cells.filter(match).reduce((sum, cell) => sum + Math.round(cell.used * 10), 0) / 10;
    return {
      userId: employee.id,
      employeeCode: employee.employee_code,
      name: employee.name,
      departmentName: employee.department_name,
      designationName: employee.designation_name,
      types: cells,
      untrackedUsage: {
        wfh: usedOf((cell) => cell.kind === 'wfh'),
        field: usedOf((cell) => cell.kind === 'field'),
        unpaid: usedOf((cell) => cell.kind === 'leave' && !cell.isPaid),
      },
    };
  });
}

function yearActivity(year: number): Activity {
  return { kind: 'leave', from: `${year}-01-01`, to: `${year}-12-31` };
}

export async function leaveReport(
  scope: EmployeeScope,
  year: number,
  paging: { page: number; pageSize: number },
): Promise<Page<LeaveReportRow> & { year: number }> {
  const filter = scopeWhere(scope, yearActivity(year));
  const total = await countEmployees(filter);
  const rows = await employeeWindow(filter, paging.pageSize, (paging.page - 1) * paging.pageSize);
  return { year, items: await leaveRowsFor(rows, year), total, page: paging.page, pageSize: paging.pageSize };
}

const LEAVE_CSV_HEADER = [
  'Employee code', 'Name', 'Department', 'Year', 'Leave type', 'Code', 'Kind', 'Paid',
  'Tracked', 'Entitled', 'Used', 'Pending', 'Available',
];

/** Long format — one row per employee per type — so the columns never depend on the type list. */
export async function exportLeaveCsv(scope: EmployeeScope, year: number, response: Response): Promise<void> {
  const filter = scopeWhere(scope, yearActivity(year));
  await streamCsv(response, `hr-leave-${year}.csv`, LEAVE_CSV_HEADER, async (csv) => {
    await forEachEmployeeBatch(filter, async (rows) => {
      if (csv.aborted) return false;
      const report = await leaveRowsFor(rows, year);
      await csv.write(
        report.flatMap((row) =>
          row.types.map((cell): CsvValue[] => [
            row.employeeCode, row.name, row.departmentName, year, cell.name, cell.code,
            humanise(cell.kind === 'wfh' ? 'work_from_home' : cell.kind), cell.isPaid, cell.tracked,
            cell.entitled, cell.used, cell.pending, cell.available,
          ]),
        ),
      );
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Employee directory                                                          */
/* -------------------------------------------------------------------------- */

export type EmployeeReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  departmentName: string | null;
  designationName: string | null;
  managerName: string | null;
  joiningDate: string | null;
  exitDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  workMode: WorkMode;
  locationName: string | null;
  shiftName: string | null;
  isActive: boolean;
};

function toEmployeeReportRow(row: EmployeeRow): EmployeeReportRow {
  return {
    userId: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    departmentName: row.department_name,
    designationName: row.designation_name,
    managerName: row.manager_name,
    joiningDate: row.joining_date,
    exitDate: row.exit_date,
    employmentType: row.employment_type,
    employmentStatus: row.employment_status,
    workMode: row.work_mode,
    locationName: row.location_name,
    shiftName: row.shift_name,
    isActive: Number(row.is_active) === 1,
  };
}

/** Approved accounts only: a pending registration is not yet an employee. */
export async function employeesReport(
  scope: EmployeeScope,
  paging: { page: number; pageSize: number },
): Promise<Page<EmployeeReportRow>> {
  const filter = scopeWhere(scope, null);
  const total = await countEmployees(filter);
  const rows = await employeeWindow(filter, paging.pageSize, (paging.page - 1) * paging.pageSize);
  return { items: rows.map(toEmployeeReportRow), total, page: paging.page, pageSize: paging.pageSize };
}

const EMPLOYEE_CSV_HEADER = [
  'Employee code', 'Name', 'Email', 'Phone', 'Department', 'Designation', 'Manager',
  'Joining date', 'Exit date', 'Employment type', 'Employment status', 'Work mode', 'Site',
  'Shift', 'Active',
];

export async function exportEmployeesCsv(scope: EmployeeScope, response: Response): Promise<void> {
  const filter = scopeWhere(scope, null);
  await streamCsv(response, `hr-employees-${companyToday()}.csv`, EMPLOYEE_CSV_HEADER, async (csv) => {
    await forEachEmployeeBatch(
      filter,
      async (rows) => {
        if (csv.aborted) return false;
        await csv.write(
          rows.map(toEmployeeReportRow).map((row): CsvValue[] => [
            row.employeeCode, row.name, row.email, row.phone, row.departmentName,
            row.designationName, row.managerName, row.joiningDate, row.exitDate,
            humanise(row.employmentType), humanise(row.employmentStatus), humanise(row.workMode),
            row.locationName, row.shiftName, row.isActive,
          ]),
        );
      },
      500,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Payroll by year — ADMIN ONLY at the route                                   */
/* -------------------------------------------------------------------------- */

export type PayrollYearReport = {
  year: number;
  /** The year's runs, oldest first, as the payroll module records them. At most twelve. */
  items: PayrollRun[];
  /**
   * Summed over APPROVED runs only. A draft or processed run can still be recomputed,
   * so adding it to a year's paid total would report money nobody has signed off.
   */
  /** `payslips` counts payslips issued, not distinct people: most people are paid every month. */
  approvedTotals: { runs: number; payslips: number; gross: number; deductions: number; net: number };
};

export async function payrollYearReport(year: number): Promise<PayrollYearReport> {
  // One run per month by the unique period key, so this is bounded at twelve.
  const runs = (await payrollRunsForYear(year)).slice(0, 12);
  const approved = runs.filter((run) => run.status === 'approved');
  // Summed in integer paise, then back to rupees: a float sum of twelve amounts drifts.
  const sum = (pick: (run: PayrollRun) => number) =>
    approved.reduce((total, run) => total + paise(pick(run)), 0) / 100;

  return {
    year,
    items: runs,
    approvedTotals: {
      runs: approved.length,
      payslips: approved.reduce((total, run) => total + run.employeeCount, 0),
      gross: sum((run) => run.totalGross),
      deductions: sum((run) => run.totalDeductions),
      net: sum((run) => run.totalNet),
    },
  };
}

export const PAYROLL_CSV_HEADER = [
  'Period', 'Status', 'Employees', 'Gross', 'Deductions', 'Net', 'Approved at', 'Approved by',
];

/** Money is written with both decimals (`30000.00`), the way the payslip prints it. */

export function payrollYearCsvRows(report: PayrollYearReport): CsvValue[][] {
  return report.items.map((run) => [
    run.period, humanise(run.status), run.employeeCount, run.totalGross.toFixed(2),
    run.totalDeductions.toFixed(2), run.totalNet.toFixed(2), companyDateTime(run.approvedAt),
    run.approvedByName,
  ]);
}

/* -------------------------------------------------------------------------- */
/* The HR audit trail — ADMIN ONLY at the route                                */
/* -------------------------------------------------------------------------- */

export type HrAuditRecord = {
  id: number;
  actorType: string;
  actorId: number | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  meta: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
};

export type HrAuditFilters = {
  action?: string;
  entityType?: string;
  q?: string;
  /** Inclusive company-calendar days on `created_at`. */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
};

interface AuditRow extends RowDataPacket {
  id: number;
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  summary: string;
  meta: unknown;
  ip_address: string | null;
  created_at: Date | string;
}

function parseMeta(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The start of a company-calendar day, as the UTC instant `created_at` is stored in. */
function companyDayStart(date: string): Date {
  return new Date(`${date}T00:00:00${COMPANY_UTC_OFFSET}`);
}

/**
 * The HR slice of `audit_logs`: every row whose entity type starts `hr_`.
 *
 * The underscore is ESCAPED. In LIKE an unescaped `_` matches any one character, so
 * `'hr_%'` would also admit `hrx…`, `hrs…` or any other entity type a future module
 * happens to start with those letters — a leak of another product's trail into this
 * view. An explicit `ESCAPE '!'` rather than a backslash, so the meaning does not
 * depend on the server's `NO_BACKSLASH_ESCAPES` mode.
 */
export async function listHrAudit(filters: HrAuditFilters): Promise<Page<HrAuditRecord>> {
  const conditions = ["entity_type LIKE 'hr!_%' ESCAPE '!'"];
  const params: SqlParam[] = [];

  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.entityType) {
    conditions.push('entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.from) {
    if (!isIsoDate(filters.from)) throw badRequest('Enter a real start date.', { from: 'Enter a real date.' });
    conditions.push('created_at >= ?');
    params.push(companyDayStart(filters.from));
  }
  if (filters.to) {
    if (!isIsoDate(filters.to)) throw badRequest('Enter a real end date.', { to: 'Enter a real date.' });
    conditions.push('created_at < ?');
    params.push(companyDayStart(addDays(filters.to, 1)));
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw badRequest('The start date must be on or before the end date.', {
      from: 'Must be on or before the end date.',
    });
  }
  if (filters.q) {
    conditions.push('(summary LIKE ? OR actor_label LIKE ? OR action LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term, term);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM audit_logs ${where}`,
    params,
  );
  const offset = (filters.page - 1) * filters.pageSize;
  // LIMIT/OFFSET interpolated: Zod-validated positive integers, page size capped at 100.
  const rows = await query<AuditRow>(
    `SELECT id, actor_type, actor_id, actor_label, action, entity_type, entity_id,
            summary, meta, ip_address, created_at
       FROM audit_logs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number(offset)}`,
    params,
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id === null ? null : Number(row.actor_id),
      actorLabel: row.actor_label,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id === null ? null : Number(row.entity_id),
      summary: row.summary,
      meta: parseMeta(row.meta),
      ipAddress: row.ip_address,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** The current company year, for defaults. */
export function companyYear(): number {
  return Number(companyToday().slice(0, 4));
}
