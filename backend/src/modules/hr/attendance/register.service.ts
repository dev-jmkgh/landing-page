import { queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { companyToday, holidaysBetween, weekdayOf } from '../calendar/calendar.service';
import { getHrSettings, type HrSettings, type Weekday } from '../settings/hrSettings';
import { LOCAL_NOW, LOCAL_TODAY } from './attendance.schema';

/**
 * The register's filters as SQL, shared by the register itself (`GET /admin/hr/attendance`),
 * the review queue (`GET /admin/hr/attendance/exceptions`) and the HR dashboard's figures.
 *
 * ONE DEFINITION, SO A FIGURE AND ITS LIST CANNOT DISAGREE. Every figure on the dashboard
 * is a `COUNT(*)` of exactly the query the screen it opens runs with the same filters — so
 * "12 late" opens a register whose total is 12, at any headcount, and the list behind it
 * is paged, searchable and exportable like any other.
 */

/**
 * What the register's `status` filter can ask for — the day as the calendar classifies it
 * (`calendar.service`), plus the two arrangements and the two live states.
 *
 *   present, late, half_day — attended, and how: the day's own roll-up. For today that is
 *       where the day stands so far (checked in on time counts as present), as on the
 *       dashboard; once the day is over, the verdict on its hours.
 *   checked_out — today, attended and out (not in right now).
 *   yet_to_check_in — today, a working day with nothing recorded yet.
 *   absent, on_leave, holiday, weekly_off — the calendar's verdicts for a day not attended.
 *   wfh, field — on an approved work-from-home / field-work request that day.
 *   currently_in — checked in now, and the shift is not over.
 *   not_checked_out — still checked in after the shift ended, or a check-out the system
 *       closed (a missing punch).
 */
export const REGISTER_STATUS_FILTERS = [
  'present',
  'late',
  'half_day',
  'absent',
  'on_leave',
  'holiday',
  'weekly_off',
  'wfh',
  'field',
  'currently_in',
  'checked_out',
  'yet_to_check_in',
  'not_checked_out',
] as const;
export type RegisterStatusFilter = (typeof REGISTER_STATUS_FILTERS)[number];

export type RegisterFilters = {
  date: string;
  userId?: number;
  q?: string;
  departmentId?: number;
  /** The employee's ASSIGNED site — not where a punch happened to be made. */
  locationId?: number;
  status?: RegisterStatusFilter;
};

type DateFacts = {
  date: string;
  weekday: Weekday;
  defaultWeeklyOff: Weekday[];
  isHoliday: boolean;
  /** The date has a verdict: it is over, and tracking had begun by then. */
  judged: boolean;
  /** The company's today: the day in progress. */
  isToday: boolean;
};

/*
 * An open session is OVERDUE once its shift has ended — the shift recorded on the day,
 * overnight shifts ending the next morning — or, with no shift, once its day is over.
 * The same rule `dashboard.service` used to apply in Node, here in SQL.
 */
const SHIFT_END = `DATE_ADD(CAST(CONCAT(a.work_date, ' ', a.shift_ends_at) AS DATETIME),
                     INTERVAL (a.shift_starts_at IS NOT NULL AND a.shift_ends_at <= a.shift_starts_at) DAY)`;
const OVERDUE = `((a.shift_ends_at IS NULL AND a.work_date < ${LOCAL_TODAY})
                  OR (a.shift_ends_at IS NOT NULL AND ${LOCAL_NOW} > ${SHIFT_END}))`;
const OPEN_SESSION = `EXISTS (SELECT 1 FROM hr_attendance_sessions os
                       WHERE os.attendance_id = a.id AND os.ended_at IS NULL)`;
const ATTENDED = "a.status IN ('present','late','half_day')";

/**
 * The SQL twin of the calendar's day classifier, for ONE date across many people.
 *
 * WHY A TWIN EXISTS AT ALL. The register is paged, so a status filter has to run in SQL —
 * filtering a page in Node would leave `total` counting the unfiltered list and every page
 * but the last short. The calendar service remains THE classifier: each row's `dayStatus`
 * comes from `calendarForUsers`, and these fragments mirror its precedence
 * (`resolveStatus`, `verdictOf`) so a filter never returns a row whose own day disagrees:
 *
 *   not employed → attended (present/late/half_day) → holiday → weekly off → on leave
 *   → not yet judged / untracked → absent
 *
 * The date-level facts — is it a holiday, is it judged yet — are the same for everybody on
 * the register, so they are decided once in Node and collapse a fragment to `1 = 0` where
 * they rule a status out.
 */
function statusCondition(status: RegisterStatusFilter, facts: DateFacts): { sql: string; params: SqlParam[] } {
  const employed = {
    sql: '(u.joining_date IS NULL OR u.joining_date <= ?) AND (u.exit_date IS NULL OR u.exit_date >= ?)',
    params: [facts.date, facts.date] as SqlParam[],
  };
  const notAttended = `(a.id IS NULL OR NOT (${ATTENDED}))`;
  // A shift's own SET when they have a shift; the company default when they do not —
  // the same fallback `loadContexts` applies in the calendar.
  const weeklyOff = {
    sql: 'FIND_IN_SET(?, IF(sh.id IS NULL, ?, sh.weekly_off_days)) > 0',
    params: [facts.weekday, facts.defaultWeeklyOff.join(',')] as SqlParam[],
  };
  const approvedRequest = (kind: 'leave' | 'wfh' | 'field') => ({
    sql: `EXISTS (SELECT 1 FROM hr_leave_requests r
                    JOIN hr_leave_types t ON t.id = r.leave_type_id
                   WHERE r.user_id = u.id AND r.status = 'approved' AND t.kind = ?
                     AND r.start_date <= ? AND r.end_date >= ?)`,
    params: [kind, facts.date, facts.date] as SqlParam[],
  });
  const onLeave = approvedRequest('leave');
  const never = { sql: '1 = 0', params: [] as SqlParam[] };

  switch (status) {
    case 'present':
    case 'late':
    case 'half_day':
      // The calendar's verdict for an attended day is its roll-up, in progress or not.
      return { sql: `(${employed.sql} AND a.status = ?)`, params: [...employed.params, status] };
    case 'checked_out':
      if (!facts.isToday) return never;
      return { sql: `(${employed.sql} AND ${ATTENDED} AND a.checked_out_at IS NOT NULL)`, params: employed.params };
    case 'yet_to_check_in':
      if (!facts.isToday || facts.isHoliday) return never;
      return {
        sql: `(${employed.sql} AND ${notAttended} AND NOT (${weeklyOff.sql}) AND NOT ${onLeave.sql})`,
        params: [...employed.params, ...weeklyOff.params, ...onLeave.params],
      };
    case 'holiday':
      if (!facts.isHoliday) return never;
      return { sql: `(${employed.sql} AND ${notAttended})`, params: employed.params };
    case 'weekly_off':
      if (facts.isHoliday) return never;
      return {
        sql: `(${employed.sql} AND ${notAttended} AND ${weeklyOff.sql})`,
        params: [...employed.params, ...weeklyOff.params],
      };
    case 'on_leave':
      if (facts.isHoliday) return never;
      return {
        sql: `(${employed.sql} AND ${notAttended} AND NOT (${weeklyOff.sql}) AND ${onLeave.sql})`,
        params: [...employed.params, ...weeklyOff.params, ...onLeave.params],
      };
    case 'absent':
      if (facts.isHoliday || !facts.judged) return never;
      return {
        sql: `(${employed.sql} AND ${notAttended} AND NOT (${weeklyOff.sql}) AND NOT ${onLeave.sql})`,
        params: [...employed.params, ...weeklyOff.params, ...onLeave.params],
      };
    case 'wfh':
    case 'field': {
      const request = approvedRequest(status);
      return { sql: `(${employed.sql} AND ${request.sql})`, params: [...employed.params, ...request.params] };
    }
    case 'currently_in':
      return {
        sql: `(${employed.sql} AND ${ATTENDED} AND ${OPEN_SESSION} AND NOT ${OVERDUE})`,
        params: employed.params,
      };
    case 'not_checked_out':
      return { sql: `(a.missing_punch = 1 OR (${OPEN_SESSION} AND ${OVERDUE}))`, params: [] };
  }
}

/**
 * What every date's filter needs to know beyond the row: the HR settings and the holidays.
 * Loaded once for a range, so the dashboard's dozens of counts do not each read them again.
 */
export type RegisterContext = {
  settings: HrSettings;
  holidays: Array<{ date: string; name: string; isOptional: boolean }>;
};

export async function loadRegisterContext(from: string, to: string): Promise<RegisterContext> {
  const [settings, holidays] = await Promise.all([getHrSettings(), holidaysBetween(from, to)]);
  return { settings, holidays };
}

/**
 * The register's FROM … WHERE for these filters: every approved, active employee — a LEFT
 * JOIN from `hr_users`, so the people with no attendance are on it — with the date's day.
 * `params` are in placeholder order; append nothing before the LIMIT. Pass `context` when
 * it is already loaded for a range that covers the date.
 */
export async function registerQuery(
  filters: RegisterFilters,
  context?: RegisterContext,
): Promise<{ from: string; params: SqlParam[] }> {
  const today = companyToday();
  const date = filters.date;
  const { settings, holidays: known } = context ?? (await loadRegisterContext(date, date));
  const holidays = known.filter((holiday) => holiday.date === date);
  const trackedFrom = settings.attendanceTrackedFrom;

  const conditions: string[] = ["u.approval_status = 'approved'", 'u.is_active = 1'];
  const whereParams: SqlParam[] = [];

  if (filters.userId) {
    conditions.push('u.id = ?');
    whereParams.push(filters.userId);
  }
  if (filters.q) {
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    const term = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    whereParams.push(term, term, term);
  }
  if (filters.departmentId) {
    conditions.push('u.department_id = ?');
    whereParams.push(filters.departmentId);
  }
  if (filters.locationId) {
    conditions.push('u.work_location_id = ?');
    whereParams.push(filters.locationId);
  }
  if (filters.status) {
    const condition = statusCondition(filters.status, {
      date,
      weekday: weekdayOf(date),
      defaultWeeklyOff: settings.defaultWeeklyOff,
      isHoliday: holidays.some((holiday) => !holiday.isOptional),
      judged: date < today && !(trackedFrom !== null && date < trackedFrom),
      isToday: date === today,
    });
    conditions.push(condition.sql);
    whereParams.push(...condition.params);
  }

  return {
    from: `
      FROM hr_users u
      LEFT JOIN hr_attendance a
             ON a.user_id = u.id
            AND a.work_date = ?
      LEFT JOIN hr_work_locations l ON l.id = a.check_in_location_id
      LEFT JOIN hr_departments d    ON d.id = u.department_id
      LEFT JOIN hr_designations g   ON g.id = u.designation_id
      LEFT JOIN hr_shifts sh        ON sh.id = u.shift_id
     WHERE ${conditions.join(' AND ')}`,
    params: [date, ...whereParams],
  };
}

/** The register's total for these filters — what its pager will say. */
export async function countRegister(filters: RegisterFilters, context?: RegisterContext): Promise<number> {
  const { from, params } = await registerQuery(filters, context);
  const row = await queryOne<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total ${from}`, params);
  return Number(row?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* The review queue                                                            */
/* -------------------------------------------------------------------------- */

export type ExceptionFilters = {
  /** Absent: either kind. */
  type?: 'missing_punch' | 'flagged';
  /** Absent: reviewed or not. */
  reviewed?: 'true' | 'false';
  from?: string;
  to?: string;
  userId?: number;
};

/** The review queue's WHERE, on `hr_attendance a`. */
export function exceptionsWhere(filters: ExceptionFilters): { where: string; params: SqlParam[] } {
  const conditions: string[] = [
    filters.type === 'missing_punch'
      ? 'a.missing_punch = 1'
      : filters.type === 'flagged'
        ? 'a.flagged = 1'
        : '(a.missing_punch = 1 OR a.flagged = 1)',
  ];
  const params: SqlParam[] = [];

  if (filters.reviewed !== undefined) {
    conditions.push(filters.reviewed === 'true' ? 'a.flag_reviewed_at IS NOT NULL' : 'a.flag_reviewed_at IS NULL');
  }
  if (filters.from) {
    conditions.push('a.work_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('a.work_date <= ?');
    params.push(filters.to);
  }
  if (filters.userId) {
    conditions.push('a.user_id = ?');
    params.push(filters.userId);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

/** The review queue's total for these filters — what its pager will say. */
export async function countExceptions(filters: ExceptionFilters): Promise<number> {
  const { where, params } = exceptionsWhere(filters);
  const row = await queryOne<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total FROM hr_attendance a ${where}`, params);
  return Number(row?.total ?? 0);
}
