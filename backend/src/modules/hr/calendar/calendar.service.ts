import { query, type RowDataPacket } from '../../../db/pool';
import { COMPANY_UTC_OFFSET, type AttendanceStatus, type WorkMode } from '../attendance/attendance.schema';
import { getHrSettings, parseWeekdays, WEEKDAYS, type Weekday } from '../settings/hrSettings';

/**
 * The HR calendar: what each day WAS for one employee.
 *
 * Leave day counts, the attendance month view, the admin register's "on leave" and
 * payroll's loss of pay all ask the same question — was this a working day for this
 * person, and if so were they here, on leave, or neither? They ask it HERE, so the
 * leave balance, the payslip and the report can never disagree about a day.
 *
 * Nothing is written. A day's classification is derived from four sources every time
 * it is asked for: the employee's employment dates and weekly offs, the holiday list,
 * approved leave, and the attendance roll-up. A holiday added in March therefore
 * reclassifies March's calendar at once, while a leave request keeps the day count it
 * was approved with (that is a snapshot on the request).
 *
 * DATES ARE `YYYY-MM-DD` STRINGS throughout, in the company's calendar. Date objects
 * appear only inside the arithmetic helpers, always at UTC midnight, so no server or
 * handset timezone can shift a day.
 */

/* -------------------------------------------------------------------------- */
/* Date arithmetic                                                             */
/* -------------------------------------------------------------------------- */

const OFFSET_MINUTES = (() => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(COMPANY_UTC_OFFSET);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
})();

/**
 * Today in the company's calendar.
 *
 * Computed from the fixed offset rather than the process timezone, so it agrees with
 * `LOCAL_TODAY` in SQL (which converts NOW() with the same offset) on any server.
 */
export function companyToday(now: Date = new Date()): string {
  return new Date(now.getTime() + OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Every date from `from` to `to` inclusive. Refuses ranges over 400 days. */
export function eachDate(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  if (span > 400) throw new Error(`Calendar range too long: ${from}..${to}`);
  return Array.from({ length: span + 1 }, (_, index) => addDays(from, index));
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** First and last day of a `YYYY-MM` period. */
export function monthBounds(period: string): { start: string; end: string } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const start = `${period}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export type LeaveKind = 'leave' | 'wfh' | 'field';
export type HalfDay = 'none' | 'first_half' | 'second_half';

export type CalendarLeave = {
  requestId: number;
  leaveTypeId: number;
  typeName: string;
  typeCode: string;
  kind: LeaveKind;
  isPaid: boolean;
  halfDay: HalfDay;
  status: 'approved' | 'pending';
};

export type CalendarHoliday = { id: number; date: string; name: string; isOptional: boolean };

export type CalendarAttendance = {
  status: AttendanceStatus;
  workedMinutes: number | null;
  lateMinutes: number;
  earlyMinutes: number;
  missingPunch: boolean;
  flagged: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  workMode: WorkMode;
};

/**
 * What a day was, as one word.
 *
 *   present / late / half_day — attended, as the attendance roll-up recorded it
 *   holiday / weekly_off      — not a working day for this person
 *   on_leave                  — approved leave (a half day shows here too; payroll
 *                               splits it)
 *   absent                    — a past working day with no attendance and no leave
 *   upcoming                  — today or later, not yet judged
 *   untracked                 — before attendance tracking began (HR setting), so no
 *                               punch carries no meaning
 *   not_employed              — before the joining date or after the exit date
 */
export type CalendarDayStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'absent'
  | 'on_leave'
  | 'holiday'
  | 'weekly_off'
  | 'upcoming'
  | 'untracked'
  | 'not_employed';

export type CalendarDay = {
  date: string;
  weekday: Weekday;
  isToday: boolean;
  employed: boolean;
  weeklyOff: boolean;
  /** Includes optional holidays, which are NOT days off — see `isOptional`. */
  holiday: { id: number; name: string; isOptional: boolean } | null;
  /** Approved leave, wfh or field work covering the day. */
  leave: CalendarLeave | null;
  /** A request still waiting for a decision. Only when asked for. */
  pendingLeave: CalendarLeave | null;
  attendance: CalendarAttendance | null;
  status: CalendarDayStatus;
};

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

type EmployeeCalendarContext = {
  userId: number;
  joiningDate: string | null;
  exitDate: string | null;
  weeklyOff: Weekday[];
};

interface ContextRow extends RowDataPacket {
  id: number;
  joining_date: string | null;
  exit_date: string | null;
  weekly_off_days: string | null;
  has_shift: number;
}

function idList(ids: number[]): string {
  // Integers by construction (callers pass ids from rows or validated params).
  return ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0).join(',') || '0';
}

async function loadContexts(userIds: number[]): Promise<Map<number, EmployeeCalendarContext>> {
  const settings = await getHrSettings();
  const rows = await query<ContextRow>(
    `SELECT u.id,
            DATE_FORMAT(u.joining_date, '%Y-%m-%d') AS joining_date,
            DATE_FORMAT(u.exit_date, '%Y-%m-%d')    AS exit_date,
            s.weekly_off_days,
            (s.id IS NOT NULL) AS has_shift
       FROM hr_users u
       LEFT JOIN hr_shifts s ON s.id = u.shift_id
      WHERE u.id IN (${idList(userIds)})`,
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        userId: row.id,
        joiningDate: row.joining_date,
        exitDate: row.exit_date,
        weeklyOff: Number(row.has_shift) === 1
          ? parseWeekdays(row.weekly_off_days ?? '', [])
          : settings.defaultWeeklyOff,
      },
    ]),
  );
}

interface HolidayRow extends RowDataPacket {
  id: number;
  holiday_date: string;
  name: string;
  is_optional: number;
}

export async function holidaysBetween(from: string, to: string): Promise<CalendarHoliday[]> {
  const rows = await query<HolidayRow>(
    `SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, is_optional
       FROM hr_holidays WHERE holiday_date BETWEEN ? AND ?
      ORDER BY holiday_date ASC`,
    [from, to],
  );
  return rows.map((row) => ({
    id: row.id,
    date: row.holiday_date,
    name: row.name,
    isOptional: Number(row.is_optional) === 1,
  }));
}

interface LeaveRow extends RowDataPacket {
  id: number;
  user_id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  half_day: HalfDay;
  status: 'approved' | 'pending';
  type_name: string;
  type_code: string;
  kind: LeaveKind;
  is_paid: number;
}

async function loadLeave(
  userIds: number[],
  from: string,
  to: string,
  includePending: boolean,
): Promise<LeaveRow[]> {
  return query<LeaveRow>(
    `SELECT r.id, r.user_id, r.leave_type_id,
            DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(r.end_date, '%Y-%m-%d')   AS end_date,
            r.half_day, r.status,
            t.name AS type_name, t.code AS type_code, t.kind, t.is_paid
       FROM hr_leave_requests r
       JOIN hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.user_id IN (${idList(userIds)})
        AND r.status IN (${includePending ? "'approved','pending'" : "'approved'"})
        AND r.start_date <= ? AND r.end_date >= ?
      ORDER BY r.start_date ASC, r.id ASC`,
    [to, from],
  );
}

interface AttendanceRow extends RowDataPacket {
  user_id: number;
  work_date: string;
  status: AttendanceStatus;
  worked_minutes: number | null;
  late_minutes: number;
  early_minutes: number;
  missing_punch: number;
  flagged: number;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  work_mode: WorkMode;
}

async function loadAttendance(userIds: number[], from: string, to: string): Promise<AttendanceRow[]> {
  return query<AttendanceRow>(
    `SELECT user_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, status,
            worked_minutes, late_minutes, early_minutes, missing_punch, flagged,
            checked_in_at, checked_out_at, work_mode
       FROM hr_attendance
      WHERE user_id IN (${idList(userIds)}) AND work_date BETWEEN ? AND ?`,
    [from, to],
  );
}

const ATTENDED: ReadonlySet<AttendanceStatus> = new Set(['present', 'late', 'half_day']);

function toLeave(row: LeaveRow): CalendarLeave {
  return {
    requestId: row.id,
    leaveTypeId: row.leave_type_id,
    typeName: row.type_name,
    typeCode: row.type_code,
    kind: row.kind,
    isPaid: Number(row.is_paid) === 1,
    halfDay: row.half_day,
    status: row.status,
  };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

function employedOn(context: EmployeeCalendarContext, date: string): boolean {
  if (context.joiningDate && date < context.joiningDate) return false;
  if (context.exitDate && date > context.exitDate) return false;
  return true;
}

function resolveStatus(day: Omit<CalendarDay, 'status'>, today: string, trackedFrom: string | null): CalendarDayStatus {
  if (!day.employed) return 'not_employed';
  if (day.attendance && ATTENDED.has(day.attendance.status)) return day.attendance.status;
  if (day.holiday && !day.holiday.isOptional) return 'holiday';
  if (day.weeklyOff) return 'weekly_off';
  if (day.leave && day.leave.kind === 'leave') return 'on_leave';
  if (day.date >= today) return 'upcoming';
  if (trackedFrom && day.date < trackedFrom) return 'untracked';
  return 'absent';
}

/**
 * The calendar for several employees at once — one query per source, not per person,
 * so a payroll run or a report over a hundred people is five queries.
 */
export async function calendarForUsers(
  userIds: number[],
  from: string,
  to: string,
  options: { includePending?: boolean; today?: string } = {},
): Promise<Map<number, CalendarDay[]>> {
  const result = new Map<number, CalendarDay[]>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return result;

  const dates = eachDate(from, to);
  const today = options.today ?? companyToday();

  const [settings, contexts, holidays, leave, attendance] = await Promise.all([
    getHrSettings(),
    loadContexts(ids),
    holidaysBetween(from, to),
    loadLeave(ids, from, to, options.includePending ?? false),
    loadAttendance(ids, from, to),
  ]);

  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]));

  const attendanceByKey = new Map(
    attendance.map((row) => [`${row.user_id}:${row.work_date}`, row]),
  );

  const leaveByUser = new Map<number, LeaveRow[]>();
  for (const row of leave) {
    const list = leaveByUser.get(row.user_id) ?? [];
    list.push(row);
    leaveByUser.set(row.user_id, list);
  }

  for (const userId of ids) {
    const context = contexts.get(userId);
    if (!context) continue;

    const requests = leaveByUser.get(userId) ?? [];

    const days = dates.map((date): CalendarDay => {
      const weekday = weekdayOf(date);
      const holiday = holidayByDate.get(date) ?? null;
      const covering = requests.filter((row) => row.start_date <= date && row.end_date >= date);
      const approved = covering.find((row) => row.status === 'approved') ?? null;
      const pending = covering.find((row) => row.status === 'pending') ?? null;
      const record = attendanceByKey.get(`${userId}:${date}`) ?? null;

      const base: Omit<CalendarDay, 'status'> = {
        date,
        weekday,
        isToday: date === today,
        employed: employedOn(context, date),
        weeklyOff: context.weeklyOff.includes(weekday),
        holiday: holiday ? { id: holiday.id, name: holiday.name, isOptional: holiday.isOptional } : null,
        leave: approved ? toLeave(approved) : null,
        pendingLeave: pending ? toLeave(pending) : null,
        attendance: record
          ? {
              status: record.status,
              workedMinutes: record.worked_minutes === null ? null : Number(record.worked_minutes),
              lateMinutes: Number(record.late_minutes),
              earlyMinutes: Number(record.early_minutes),
              missingPunch: Number(record.missing_punch) === 1,
              flagged: Number(record.flagged) === 1,
              checkedInAt: record.checked_in_at ? new Date(record.checked_in_at).toISOString() : null,
              checkedOutAt: record.checked_out_at ? new Date(record.checked_out_at).toISOString() : null,
              workMode: record.work_mode,
            }
          : null,
      };

      return { ...base, status: resolveStatus(base, today, settings.attendanceTrackedFrom) };
    });

    result.set(userId, days);
  }

  return result;
}

export async function calendarFor(
  userId: number,
  from: string,
  to: string,
  options: { includePending?: boolean; today?: string } = {},
): Promise<CalendarDay[]> {
  return (await calendarForUsers([userId], from, to, options)).get(userId) ?? [];
}

/* -------------------------------------------------------------------------- */
/* Leave day counting                                                          */
/* -------------------------------------------------------------------------- */

export type LeaveDayCount = {
  /** Working days the request costs. Halves for a half-day request. */
  days: number;
  /** Dates in the range that cost nothing, and why — so the app can say so. */
  excluded: Array<{ date: string; reason: 'holiday' | 'weekly_off' | 'not_employed'; name?: string }>;
};

/**
 * How many working days a leave request from `start` to `end` costs this employee.
 *
 * Weekly offs and (non-optional) holidays inside the range are free; days outside the
 * employment dates are not leave at all. A half-day request is only ever one day, and
 * costs half of it.
 */
export async function countLeaveDays(
  userId: number,
  start: string,
  end: string,
  halfDay: HalfDay = 'none',
): Promise<LeaveDayCount> {
  const [contexts, holidays] = await Promise.all([loadContexts([userId]), holidaysBetween(start, end)]);
  const context = contexts.get(userId);
  if (!context) return { days: 0, excluded: [] };

  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]));
  const excluded: LeaveDayCount['excluded'] = [];
  let days = 0;

  for (const date of eachDate(start, end)) {
    const holiday = holidayByDate.get(date);
    if (!employedOn(context, date)) excluded.push({ date, reason: 'not_employed' });
    else if (holiday && !holiday.isOptional) excluded.push({ date, reason: 'holiday', name: holiday.name });
    else if (context.weeklyOff.includes(weekdayOf(date))) excluded.push({ date, reason: 'weekly_off' });
    else days += 1;
  }

  if (halfDay !== 'none' && start === end && days === 1) days = 0.5;
  return { days, excluded };
}

/* -------------------------------------------------------------------------- */
/* Payroll                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How one day splits for payroll. The fields sum to exactly 1.
 *
 * Loss of pay is `unpaidLeave + absent`. `unemployed` days are not payable at all and
 * are prorated out separately. Everything else is paid.
 *
 * Precedence: not employed, then holiday and weekly off (paid whatever else happened —
 * working on a holiday does not make it less of one), then recorded leave, then
 * attendance for whatever part of the day leave did not cover. Days before attendance
 * tracking began are paid without judging the part leave does not explain.
 *
 * Only meaningful for days that have ENDED: payroll refuses a period that has not.
 */
export type PayrollDaySplit = {
  unemployed: number;
  weeklyOff: number;
  holiday: number;
  present: number;
  paidLeave: number;
  unpaidLeave: number;
  absent: number;
  untracked: number;
};

export function payrollSplit(day: CalendarDay, trackedFrom: string | null): PayrollDaySplit {
  const split: PayrollDaySplit = {
    unemployed: 0,
    weeklyOff: 0,
    holiday: 0,
    present: 0,
    paidLeave: 0,
    unpaidLeave: 0,
    absent: 0,
    untracked: 0,
  };

  if (!day.employed) {
    split.unemployed = 1;
    return split;
  }
  if (day.holiday && !day.holiday.isOptional) {
    split.holiday = 1;
    return split;
  }
  if (day.weeklyOff) {
    split.weeklyOff = 1;
    return split;
  }

  const leave = day.leave && day.leave.kind === 'leave' ? day.leave : null;
  const leaveFraction = leave ? (leave.halfDay === 'none' ? 1 : 0.5) : 0;
  if (leave) {
    if (leave.isPaid) split.paidLeave = leaveFraction;
    else split.unpaidLeave = leaveFraction;
  }

  const remaining = 1 - leaveFraction;
  if (remaining <= 0) return split;

  if (trackedFrom && day.date < trackedFrom) {
    split.untracked = remaining;
    return split;
  }

  const attended = day.attendance && ATTENDED.has(day.attendance.status);
  if (!attended) {
    split.absent = remaining;
  } else if (day.attendance!.status === 'half_day' && remaining === 1) {
    // A half day worked with no leave behind the other half: half present, half absent.
    split.present = 0.5;
    split.absent = 0.5;
  } else {
    split.present = remaining;
  }

  return split;
}
