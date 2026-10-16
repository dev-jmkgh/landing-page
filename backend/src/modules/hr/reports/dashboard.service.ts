import { query, queryOne, type RowDataPacket } from '../../../db/pool';
import { hasHrRole } from '../../../middleware/hrActor';
import type { AttendanceDay, WorkMode } from '../attendance/attendance.schema';
import {
  assignmentFor,
  closeStaleSessions,
  missingPunchFor,
  todayFor,
} from '../attendance/attendance.service';
import { pendingCount as pendingRegularisations } from '../attendance/regularisation.service';
import {
  addDays,
  calendarForUsers,
  companyToday,
  eachDate,
  holidaysBetween,
  type CalendarDayStatus,
  type LeaveKind,
} from '../calendar/calendar.service';
import type { HrActor } from '../hrAuth.service';
import type { Holiday, LeaveBalance } from '../leave/leave.schema';
import { countPendingRequests as countPendingLeave } from '../leave/leave.repository';
import { balancesFor, nextApprovedLeave, pendingLeaveCount } from '../leave/leave.service';
import {
  countUnreadHrNotifications,
  latestHrNotifications,
  type HrNotification,
} from '../notifications/hrNotifications.repository';
import { lastApprovedRun, latestApprovedPayslip } from '../payroll/payroll.service';
import { countQueue as countRequestQueue } from '../requests/requests.repository';
import { openRequestCount } from '../requests/requests.service';
import { teamApprovalCounts } from '../team/team.service';
import { shiftEndInstant } from './companyClock';

/**
 * The two dashboards: the employee's home screen in the HR app, and HR's overview in
 * the admin portal.
 *
 * Both are ONE BOUNDED AGGREGATE — a fixed number of small queries whatever the size of
 * anybody's history — so the screen that opens first is never the slow one.
 *
 * NOTHING IS INVENTED. A figure the server has no data for is null or absent and the
 * screen says "not recorded"; an untracked leave type has no balance rather than a zero
 * one; a payslip that is not approved does not exist as far as the employee can tell.
 */

/* ========================================================================== */
/* The employee's dashboard                                                    */
/* ========================================================================== */

export type EmployeeDashboard = {
  today: {
    /** The company date the figures are for. */
    date: string;
    /** Today's attendance, or null when nothing has been recorded yet. */
    day: AttendanceDay | null;
    assignment: {
      workMode: WorkMode;
      geofenced: boolean;
      dayOverride: 'wfh' | 'field' | null;
      shift: { id: number; name: string; startsAt: string; endsAt: string } | null;
      location: { id: number; name: string } | null;
    };
    /** The latest day still needing a correction, as on the attendance screen. */
    missingPunch: { workDate: string } | null;
  };
  leave: {
    year: number;
    /** TRACKED `kind='leave'` types only, at most four. Empty when HR tracks none. */
    balances: LeaveBalance[];
    /** Own requests waiting for a decision, every kind. */
    pendingRequests: number;
    /** The next approved leave / wfh / field request still to come or under way. */
    nextApproved: {
      id: number;
      startDate: string;
      endDate: string;
      typeName: string;
      kind: LeaveKind;
    } | null;
  };
  requests: { open: number };
  notifications: { unread: number; latest: HrNotification[] };
  payslip: { latest: { id: number; period: string; netPay: number } | null };
  holidays: { upcoming: Holiday[] };
  /** Present only for a team manager (hr_manager / hr_admin); null for everyone else. */
  team: { pendingApprovals: number; leave: number; regularisations: number } | null;
};

const MAX_BALANCES = 4;
const UPCOMING_HOLIDAYS = 3;

/**
 * The next few holidays within a year, days off first: an optional holiday is not a day
 * off unless leave is taken for it, so it is the less useful thing to show when space
 * is short.
 */
async function upcomingHolidays(today: string): Promise<Holiday[]> {
  const rows = await query<RowDataPacket & { id: number; holiday_date: string; name: string; is_optional: number }>(
    `SELECT id, DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, is_optional
       FROM hr_holidays
      WHERE holiday_date BETWEEN ? AND ?
      ORDER BY is_optional ASC, holiday_date ASC
      LIMIT ${UPCOMING_HOLIDAYS}`,
    [today, addDays(today, 365)],
  );
  /*
   * Chosen non-optional first, SHOWN in date order. Listing a December holiday above a
   * November one because the November one is optional reads as a wrong calendar.
   */
  return rows
    .map((row) => ({
      id: row.id,
      date: row.holiday_date,
      name: row.name,
      isOptional: Number(row.is_optional) === 1,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What waits on this manager: pending leave and pending corrections from their team.
 * Counted by the team module itself (`/team/approvals/count`), so the home-screen badge
 * and the queue it opens cannot disagree about who is on the team.
 */
async function teamPending(actor: HrActor): Promise<NonNullable<EmployeeDashboard['team']>> {
  const { leave, regularisations } = await teamApprovalCounts(actor);
  return { pendingApprovals: leave + regularisations, leave, regularisations };
}

export async function employeeDashboard(actor: HrActor): Promise<EmployeeDashboard> {
  const userId = actor.id;
  const today = companyToday();
  const year = Number(today.slice(0, 4));

  // As /attendance/today does: a session forgotten yesterday is closed first, so the
  // home screen does not show yesterday morning's check-in as still running.
  await closeStaleSessions(userId);

  const [
    day,
    assignment,
    missingPunch,
    balances,
    pendingRequests,
    nextApproved,
    openRequests,
    unread,
    latest,
    payslip,
    holidays,
    team,
  ] = await Promise.all([
    todayFor(userId),
    assignmentFor(userId),
    missingPunchFor(userId),
    balancesFor(userId, year),
    pendingLeaveCount(userId),
    // Ends today or later, so leave already under way counts: "on leave until Friday".
    nextApprovedLeave(userId),
    openRequestCount(userId),
    countUnreadHrNotifications(userId),
    latestHrNotifications(userId, 3),
    latestApprovedPayslip(userId),
    upcomingHolidays(today),
    hasHrRole(actor.role, 'hr_manager') ? teamPending(actor) : Promise.resolve(null),
  ]);

  return {
    today: {
      date: today,
      day,
      assignment: {
        workMode: assignment.workMode,
        geofenced: assignment.geofenced,
        dayOverride: assignment.dayOverride,
        shift: assignment.shift
          ? {
              id: assignment.shift.id,
              name: assignment.shift.name,
              startsAt: assignment.shift.startsAt.slice(0, 5),
              endsAt: assignment.shift.endsAt.slice(0, 5),
            }
          : null,
        location: assignment.location ? { id: assignment.location.id, name: assignment.location.name } : null,
      },
      missingPunch,
    },
    leave: {
      year,
      balances: balances
        .filter((balance) => balance.tracked && balance.leaveType.kind === 'leave')
        .slice(0, MAX_BALANCES),
      pendingRequests,
      nextApproved,
    },
    requests: { open: openRequests },
    notifications: { unread, latest },
    payslip: { latest: payslip },
    holidays: { upcoming: holidays },
    team,
  };
}

/* ========================================================================== */
/* HR's overview in the admin portal                                           */
/* ========================================================================== */

export type AdminDashboardTrendPoint = {
  date: string;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
};

export type AdminDashboard = {
  date: string;
  isToday: boolean;
  headcount: {
    /** Active, approved accounts. */
    total: number;
    /** `departmentId`/`name` null is the group with no department recorded. */
    byDepartment: Array<{ departmentId: number | null; name: string | null; count: number }>;
  };
  today: {
    present: number;
    late: number;
    halfDay: number;
    /** Past days only: today, somebody not in yet is `notYetIn`, not absent. */
    absent: number;
    onLeave: number;
    /** A working day with nothing recorded yet — only ever non-zero for today or later. */
    notYetIn: number;
    /** On an approved work-from-home / field-work request that day. */
    wfh: number;
    field: number;
    holiday: boolean;
    holidayName: string | null;
    weeklyOff: number;
    /**
     * Live figures, as of NOW, so null unless `date` is today. Disjoint: every open
     * session is one or the other.
     *   currentlyIn   — an open session that is still within its shift (or has no shift
     *                   and began today): working right now.
     *   notCheckedOut — an open session past its shift end, or from an earlier day with
     *                   no shift to judge by: probably a forgotten check-out.
     */
    currentlyIn: number | null;
    notCheckedOut: number | null;
    /** Days flagged as a missing punch in the seven days ending `date`. */
    missingPunches: number;
    /** Days with a flagged punch nobody has reviewed yet, up to `date`. */
    flaggedUnreviewed: number;
  };
  pending: { registrations: number; regularisations: number; leave: number; requests: number };
  /** The fourteen days ending `date`, oldest first. */
  trend: AdminDashboardTrendPoint[];
  /** Admin role only — salary totals are not a supervisor's to see. Null otherwise. */
  payroll: { lastApproved: { period: string; totalNet: number; employeeCount: number } | null } | null;
};

const TREND_DAYS = 14;
const MISSING_PUNCH_DAYS = 7;
/** The calendar loads five queries per batch; 200 people keeps each IN list modest. */
const CALENDAR_BATCH = 200;

const ACTIVE_EMPLOYEE = "u.is_active = 1 AND u.approval_status = 'approved'";

async function openSessionCounts(today: string, now: number): Promise<{ currentlyIn: number; notCheckedOut: number }> {
  // At most one open session per person (migration 019), so this is bounded by headcount.
  const rows = await query<RowDataPacket & { work_date: string; starts_at: string | null; ends_at: string | null }>(
    `SELECT DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
            TIME_FORMAT(a.shift_starts_at, '%H:%i') AS starts_at,
            TIME_FORMAT(a.shift_ends_at, '%H:%i')   AS ends_at
       FROM hr_attendance_sessions s
       JOIN hr_attendance a ON a.id = s.attendance_id
       JOIN hr_users u ON u.id = s.user_id
      WHERE s.ended_at IS NULL AND ${ACTIVE_EMPLOYEE}`,
  );

  let currentlyIn = 0;
  let notCheckedOut = 0;
  for (const row of rows) {
    const end = shiftEndInstant(row.work_date, row.starts_at, row.ends_at);
    const overdue = end === null ? row.work_date < today : end < now;
    if (overdue) notCheckedOut += 1;
    else currentlyIn += 1;
  }
  return { currentlyIn, notCheckedOut };
}

export async function adminDashboard(input: { date?: string; includePayroll: boolean }): Promise<AdminDashboard> {
  const today = companyToday();
  const date = input.date ?? today;
  const isToday = date === today;
  const trendFrom = addDays(date, -(TREND_DAYS - 1));

  const [employees, departments, holidays] = await Promise.all([
    query<RowDataPacket & { id: number }>(
      `SELECT u.id FROM hr_users u WHERE ${ACTIVE_EMPLOYEE} ORDER BY u.id ASC`,
    ),
    query<RowDataPacket & { department_id: number | null; name: string | null; total: number }>(
      `SELECT u.department_id, d.name, COUNT(*) AS total
         FROM hr_users u
         LEFT JOIN hr_departments d ON d.id = u.department_id
        WHERE ${ACTIVE_EMPLOYEE}
        GROUP BY u.department_id, d.name
        ORDER BY d.name IS NULL, d.name ASC`,
    ),
    holidaysBetween(date, date),
  ]);

  /*
   * Every day of the trend and the headline row comes from calendarForUsers — the same
   * classification payroll and leave use — in batches of 200 people. "Absent" therefore
   * already excludes people on leave, on a holiday or on a weekly off.
   */
  const dates = eachDate(trendFrom, date);
  const trend = new Map<string, AdminDashboardTrendPoint>(
    dates.map((day) => [day, { date: day, present: 0, late: 0, halfDay: 0, absent: 0, onLeave: 0 }]),
  );
  const statusCounts = new Map<CalendarDayStatus, number>();
  let wfh = 0;
  let field = 0;

  const ids = employees.map((row) => row.id);
  for (let start = 0; start < ids.length; start += CALENDAR_BATCH) {
    const calendars = await calendarForUsers(ids.slice(start, start + CALENDAR_BATCH), trendFrom, date);
    for (const days of calendars.values()) {
      for (const day of days) {
        const point = trend.get(day.date);
        if (point) {
          if (day.status === 'present') point.present += 1;
          else if (day.status === 'late') point.late += 1;
          else if (day.status === 'half_day') point.halfDay += 1;
          else if (day.status === 'absent') point.absent += 1;
          else if (day.status === 'on_leave') point.onLeave += 1;
        }
        if (day.date === date) {
          statusCounts.set(day.status, (statusCounts.get(day.status) ?? 0) + 1);
          if (day.leave?.kind === 'wfh') wfh += 1;
          if (day.leave?.kind === 'field') field += 1;
        }
      }
    }
  }
  const status = (key: CalendarDayStatus) => statusCounts.get(key) ?? 0;

  const [live, exceptions, pending, payroll] = await Promise.all([
    isToday ? openSessionCounts(today, Date.now()) : Promise.resolve(null),
    queryOne<RowDataPacket & { missing: number; flagged: number }>(
      `SELECT
         (SELECT COUNT(*) FROM hr_attendance a JOIN hr_users u ON u.id = a.user_id
           WHERE a.missing_punch = 1 AND a.work_date BETWEEN ? AND ? AND ${ACTIVE_EMPLOYEE}) AS missing,
         (SELECT COUNT(*) FROM hr_attendance a JOIN hr_users u ON u.id = a.user_id
           WHERE a.flagged = 1 AND a.flag_reviewed_at IS NULL AND a.work_date <= ?
             AND ${ACTIVE_EMPLOYEE}) AS flagged`,
      [addDays(date, -(MISSING_PUNCH_DAYS - 1)), date, date],
    ),
    // The same counters the queues' own badges use, so the numbers here match them.
    Promise.all([
      queryOne<RowDataPacket & { registrations: number }>(
        `SELECT COUNT(*) AS registrations FROM hr_users WHERE approval_status = 'pending'`,
      ),
      pendingRegularisations(),
      countPendingLeave(),
      countRequestQueue(),
    ]),
    input.includePayroll ? lastApprovedRun() : Promise.resolve(null),
  ]);

  const [registrations, regularisations, leavePending, requestQueue] = pending;
  const holiday = holidays.find((entry) => !entry.isOptional) ?? null;

  return {
    date,
    isToday,
    headcount: {
      total: ids.length,
      byDepartment: departments.map((row) => ({
        departmentId: row.department_id === null ? null : Number(row.department_id),
        name: row.name,
        count: Number(row.total),
      })),
    },
    today: {
      present: status('present'),
      late: status('late'),
      halfDay: status('half_day'),
      absent: status('absent'),
      onLeave: status('on_leave'),
      notYetIn: status('upcoming'),
      wfh,
      field,
      holiday: holiday !== null,
      holidayName: holiday?.name ?? null,
      weeklyOff: status('weekly_off'),
      currentlyIn: live ? live.currentlyIn : null,
      notCheckedOut: live ? live.notCheckedOut : null,
      missingPunches: Number(exceptions?.missing ?? 0),
      flaggedUnreviewed: Number(exceptions?.flagged ?? 0),
    },
    pending: {
      registrations: Number(registrations?.registrations ?? 0),
      regularisations,
      leave: leavePending,
      // Both still need HR: nobody has picked up an open one, an in-progress one is not done.
      requests: requestQueue.open + requestQueue.inProgress,
    },
    trend: dates.map((day) => trend.get(day)!),
    payroll: input.includePayroll
      ? {
          lastApproved: payroll
            ? { period: payroll.period, totalNet: payroll.totalNet, employeeCount: payroll.employeeCount }
            : null,
        }
      : null,
  };
}
