import { query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { forbidden, notFound } from '../../../utils/httpError';
import type { Regularisation, RegularisationStatus } from '../attendance/attendance.schema';
import {
  calendarForUsers,
  companyToday,
  type CalendarDayStatus,
  type HalfDay,
  type LeaveKind,
} from '../calendar/calendar.service';
import type { HrActor } from '../hrAuth.service';
import type { Page } from '../hr.schema';
import { countPendingRequests } from '../leave/leave.repository';
import { isInTeam, teamCondition, teamScopeFor, type TeamScope } from './teamScope';

/**
 * A team manager's view: who is in today, and what is waiting for them to decide.
 *
 * Everything here is scoped through `teamScope.ts`. Nothing in this file decides team
 * membership on its own.
 */

/* -------------------------------------------------------------------------- */
/* Who may decide                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a decision the manager may not make.
 *
 * Their OWN request is 403 — they know it exists, and the honest answer is "not you".
 * Anybody outside their team is 404, as if the request did not exist: whether a
 * colleague in another department has asked for leave is not this manager's business,
 * and a 403 would confirm that they had.
 */
export async function assertCanDecide(scope: TeamScope, ownerId: number): Promise<void> {
  if (ownerId === scope.managerId) {
    throw forbidden('You cannot decide your own request. It goes to your manager or to HR.');
  }
  if (!(await isInTeam(scope, ownerId))) throw notFound('Request not found.');
}

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

export type TeamMember = {
  id: number;
  name: string;
  employeeCode: string;
  designationName: string | null;
  departmentName: string | null;
  today: {
    date: string;
    status: CalendarDayStatus;
    checkedInAt: string | null;
    checkedOutAt: string | null;
    /** A session is open right now (possibly one that began last night). */
    currentlyIn: boolean;
    /** Approved leave, work from home or field work covering today. */
    leave: { typeName: string; kind: LeaveKind; halfDay: HalfDay } | null;
  };
};

interface MemberRow extends RowDataPacket {
  id: number;
  name: string;
  employee_code: string;
  department_name: string | null;
  designation_name: string | null;
}

/**
 * One page of the team, with each person's day so far.
 *
 * Active, approved accounts only: a deactivated report has no "today". The day's status
 * comes from `calendarForUsers` for the page's people — one query per source for the
 * whole page, not one per person — so "absent" here means exactly what it means on the
 * register and the payslip.
 */
export async function listTeamMembers(
  scope: TeamScope,
  options: { q?: string; page: number; pageSize: number },
): Promise<Page<TeamMember>> {
  const team = teamCondition(scope, 'u');
  const conditions = ["u.approval_status = 'approved'", 'u.is_active = 1', team.sql];
  const params: SqlParam[] = [...team.params];

  if (options.q) {
    const term = `%${options.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    params.push(term, term, term);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_users u ${where}`,
    params,
  );

  // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
  const rows = await query<MemberRow>(
    `SELECT u.id, u.name, u.employee_code, d.name AS department_name, g.name AS designation_name
       FROM hr_users u
       LEFT JOIN hr_departments d  ON d.id = u.department_id
       LEFT JOIN hr_designations g ON g.id = u.designation_id
       ${where}
      ORDER BY u.name ASC, u.id ASC
      LIMIT ${Number(options.pageSize)} OFFSET ${Number((options.page - 1) * options.pageSize)}`,
    params,
  );

  const today = companyToday();
  const ids = rows.map((row) => row.id);
  const [calendars, open] = await Promise.all([
    calendarForUsers(ids, today, today),
    ids.length === 0
      ? Promise.resolve([] as Array<RowDataPacket & { user_id: number }>)
      : query<RowDataPacket & { user_id: number }>(
          // Ids come from the rows just read: integers by construction.
          `SELECT DISTINCT user_id FROM hr_attendance_sessions
            WHERE ended_at IS NULL AND user_id IN (${ids.map((id) => Number(id)).join(',')})`,
        ),
  ]);
  const openIds = new Set(open.map((row) => row.user_id));

  return {
    items: rows.map((row) => {
      const day = calendars.get(row.id)?.[0];
      return {
        id: row.id,
        name: row.name,
        employeeCode: row.employee_code,
        designationName: row.designation_name,
        departmentName: row.department_name,
        today: {
          date: today,
          status: day?.status ?? 'upcoming',
          checkedInAt: day?.attendance?.checkedInAt ?? null,
          checkedOutAt: day?.attendance?.checkedOutAt ?? null,
          currentlyIn: openIds.has(row.id),
          leave: day?.leave
            ? { typeName: day.leave.typeName, kind: day.leave.kind, halfDay: day.leave.halfDay }
            : null,
        },
      };
    }),
    total: Number(count?.total ?? 0),
    page: options.page,
    pageSize: options.pageSize,
  };
}

/* -------------------------------------------------------------------------- */
/* Corrections                                                                 */
/* -------------------------------------------------------------------------- */

interface RegularisationRow extends RowDataPacket {
  id: number;
  user_id: number;
  employee_name: string;
  employee_code: string;
  work_date: string;
  requested_check_in_at: Date | string | null;
  requested_check_out_at: Date | string | null;
  reason: string;
  status: RegularisationStatus;
  reviewed_at: Date | string | null;
  review_note: string | null;
  reviewer_name: string | null;
  created_at: Date | string;
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/*
 * The same columns and shape as regularisation.service's queue, scoped to the team. That
 * service's select and mapper are private to it; this mirrors them field for field so the
 * app renders a team correction exactly like one of its own.
 */
function toRegularisation(row: RegularisationRow): Regularisation {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    workDate: String(row.work_date),
    requestedCheckInAt: iso(row.requested_check_in_at),
    requestedCheckOutAt: iso(row.requested_check_out_at),
    reason: row.reason,
    status: row.status,
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note,
    reviewerName: row.reviewer_name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function regularisationWhere(scope: TeamScope, status: RegularisationStatus | 'all') {
  const team = teamCondition(scope, 'u');
  const conditions = [team.sql];
  const params: SqlParam[] = [...team.params];
  if (status !== 'all') {
    conditions.push('r.status = ?');
    params.push(status);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

export async function listTeamRegularisations(
  scope: TeamScope,
  status: RegularisationStatus | 'all',
  paging: { page: number; pageSize: number },
): Promise<Page<Regularisation>> {
  const { where, params } = regularisationWhere(scope, status);

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_regularisations r JOIN hr_users u ON u.id = r.user_id ${where}`,
    params,
  );

  const rows = await query<RegularisationRow>(
    `SELECT r.id, r.user_id, u.name AS employee_name, u.employee_code,
            DATE_FORMAT(r.work_date, '%Y-%m-%d') AS work_date,
            r.requested_check_in_at, r.requested_check_out_at,
            r.reason, r.status, r.reviewed_at, r.review_note, r.reviewer_name, r.created_at
       FROM hr_regularisations r
       JOIN hr_users u ON u.id = r.user_id
       ${where}
      ORDER BY (r.status = 'pending') DESC,
               CASE WHEN r.status = 'pending' THEN r.created_at END ASC,
               r.created_at DESC, r.id DESC
      LIMIT ${Number(paging.pageSize)} OFFSET ${Number((paging.page - 1) * paging.pageSize)}`,
    params,
  );

  return {
    items: rows.map(toRegularisation),
    total: Number(count?.total ?? 0),
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

async function countTeamPendingRegularisations(scope: TeamScope): Promise<number> {
  const { where, params } = regularisationWhere(scope, 'pending');
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_regularisations r JOIN hr_users u ON u.id = r.user_id ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What is waiting for this manager: pending leave and pending corrections from their
 * team. Exported for the dashboard's `team.pendingApprovals` (the sum of the two).
 * Meaningful only for an hr_manager / hr_admin; an employee has no team, and the
 * dashboard should not call this for one.
 */
export async function teamApprovalCounts(actor: HrActor): Promise<{ leave: number; regularisations: number }> {
  const scope = teamScopeFor(actor);
  const [leave, regularisations] = await Promise.all([
    countPendingRequests({ team: scope }),
    countTeamPendingRegularisations(scope),
  ]);
  return { leave, regularisations };
}
