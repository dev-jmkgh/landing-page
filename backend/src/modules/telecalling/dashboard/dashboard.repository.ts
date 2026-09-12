import { query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import type { DateRange } from '../shared.schema';

/**
 * Dashboard and report aggregates (spec: Mobile Modules 2 and 12, Admin Modules 2, 11, 12).
 *
 * Every figure here is computed at query time. There is no summary table and no nightly
 * rollup job, on purpose: a cached counter that is wrong is a bug that takes days to
 * notice and hours to trace, whereas a slow query announces itself immediately and can
 * be fixed with an index. When one of these does get slow, measure first — the indexes
 * in migrations 006–008 were chosen for exactly these shapes.
 */

/** Turns an optional YYYY-MM-DD range into a bounded SQL predicate on `column`. */
function rangeClause(
  column: string,
  range: DateRange,
  params: SqlParam[],
): string {
  const parts: string[] = [];

  if (range.from) {
    parts.push(`${column} >= ?`);
    params.push(`${range.from} 00:00:00`);
  }
  if (range.to) {
    parts.push(`${column} <= ?`);
    params.push(`${range.to} 23:59:59`);
  }

  return parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '';
}

/* -------------------------------------------------------------------------- */
/* Mobile dashboard                                                            */
/* -------------------------------------------------------------------------- */

export type EmployeeDashboard = {
  leads: {
    assigned: number;
    new: number;
    open: number;
    converted: number;
  };
  followUps: {
    today: number;
    overdue: number;
    upcoming: number;
  };
  calls: {
    today: number;
    answered: number;
    missed: number;
    talkTimeSeconds: number;
  };
  pendingCallbacks: number;
  unreadNotifications: number;
};

/**
 * Everything the mobile dashboard shows, in four queries rather than fourteen.
 *
 * The app opens on this screen at the start of a shift, frequently on a poor connection.
 * Grouping the counts by table means four round trips instead of one per tile — and each
 * of these queries is a single index scan.
 */
export async function employeeDashboard(userId: number): Promise<EmployeeDashboard> {
  const leadRow = await queryOne<
    RowDataPacket & {
      assigned: number;
      fresh: number;
      open: number;
      converted: number;
    }
  >(
    `SELECT COUNT(*) AS assigned,
            SUM(status = 'new') AS fresh,
            SUM(status NOT IN ('converted','lost','not_interested','invalid_number')) AS open,
            SUM(status = 'converted') AS converted
       FROM leads
      WHERE assigned_to = ? AND is_archived = 0`,
    [userId],
  );

  const followUpRow = await queryOne<
    RowDataPacket & { today: number; overdue: number; upcoming: number }
  >(
    `SELECT SUM(DATE(due_at) = CURDATE()) AS today,
            SUM(due_at < NOW()) AS overdue,
            SUM(due_at > NOW()) AS upcoming
       FROM follow_ups
      WHERE assigned_to = ? AND state = 'pending'`,
    [userId],
  );

  /**
   * Today's calls are bounded by `DATE(started_at) = CURDATE()` rather than by a
   * server-side window, so the figure matches what the telecaller sees in their own call
   * list. `started_at` is the client's timestamp — a call logged from the offline queue
   * counts on the day it happened, not the day it synced.
   */
  const callRow = await queryOne<
    RowDataPacket & {
      total: number;
      answered: number;
      missed: number;
      talk_time: number;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(outcome = 'answered') AS answered,
            SUM(outcome = 'missed') AS missed,
            COALESCE(SUM(CASE WHEN outcome = 'answered' THEN duration_seconds ELSE 0 END), 0) AS talk_time
       FROM calls
      WHERE user_id = ? AND DATE(started_at) = CURDATE()`,
    [userId],
  );

  const pendingRow = await queryOne<RowDataPacket & { total: number; unread: number }>(
    `SELECT
       (SELECT COUNT(*) FROM calls
         WHERE user_id = ?
           AND followed_up = 0
           AND outcome IN ('missed','rejected','busy','unreachable','no_answer')) AS total,
       (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS unread`,
    [userId, userId],
  );

  return {
    leads: {
      assigned: num(leadRow?.assigned),
      new: num(leadRow?.fresh),
      open: num(leadRow?.open),
      converted: num(leadRow?.converted),
    },
    followUps: {
      today: num(followUpRow?.today),
      overdue: num(followUpRow?.overdue),
      upcoming: num(followUpRow?.upcoming),
    },
    calls: {
      today: num(callRow?.total),
      answered: num(callRow?.answered),
      missed: num(callRow?.missed),
      talkTimeSeconds: num(callRow?.talk_time),
    },
    pendingCallbacks: num(pendingRow?.total),
    unreadNotifications: num(pendingRow?.unread),
  };
}

/**
 * `SUM(condition)` returns NULL over an empty set and a string for a DECIMAL in some
 * driver configurations. Both would reach the client as `null` or `"0"` and render as
 * blank tiles on a new employee's first day.
 */
function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* -------------------------------------------------------------------------- */
/* Employee activity summary (spec: Mobile Module 12)                          */
/* -------------------------------------------------------------------------- */

export type ActivitySummary = {
  calls: number;
  answered: number;
  missed: number;
  talkTimeSeconds: number;
  averageDurationSeconds: number;
  followUpsCompleted: number;
  followUpsPending: number;
  leadsContacted: number;
  leadsConverted: number;
};

/**
 * One employee's numbers over a date range.
 *
 * `leadsContacted` counts distinct leads with an answered call, not calls — a telecaller
 * who rang the same customer six times contacted one lead. Conflating the two is the
 * usual way a performance dashboard rewards persistence with a stranger instead of
 * reach across the list.
 */
export async function employeeActivitySummary(
  userId: number,
  range: DateRange,
): Promise<ActivitySummary> {
  const callParams: SqlParam[] = [userId];
  const callRange = rangeClause('started_at', range, callParams);

  const callRow = await queryOne<
    RowDataPacket & {
      total: number;
      answered: number;
      missed: number;
      talk_time: number;
      contacted: number;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(outcome = 'answered') AS answered,
            SUM(outcome IN ('missed','rejected','busy','unreachable','no_answer')) AS missed,
            COALESCE(SUM(CASE WHEN outcome = 'answered' THEN duration_seconds ELSE 0 END), 0) AS talk_time,
            COUNT(DISTINCT CASE WHEN outcome = 'answered' THEN lead_id END) AS contacted
       FROM calls
      WHERE user_id = ?${callRange}`,
    callParams,
  );

  const completedParams: SqlParam[] = [userId];
  const completedRange = rangeClause('completed_at', range, completedParams);

  const followUpRow = await queryOne<RowDataPacket & { completed: number }>(
    `SELECT COUNT(*) AS completed
       FROM follow_ups
      WHERE completed_by = ? AND state = 'completed'${completedRange}`,
    completedParams,
  );

  // Pending follow-ups are a live figure, not a historical one: "how much do I still
  // owe" does not change meaning because the report is filtered to last week.
  const pendingRow = await queryOne<RowDataPacket & { pending: number }>(
    `SELECT COUNT(*) AS pending FROM follow_ups WHERE assigned_to = ? AND state = 'pending'`,
    [userId],
  );

  const convertedParams: SqlParam[] = [userId];
  const convertedRange = rangeClause('converted_at', range, convertedParams);

  const convertedRow = await queryOne<RowDataPacket & { converted: number }>(
    `SELECT COUNT(*) AS converted
       FROM leads
      WHERE assigned_to = ? AND status = 'converted' AND converted_at IS NOT NULL${convertedRange}`,
    convertedParams,
  );

  const answered = num(callRow?.answered);
  const talkTime = num(callRow?.talk_time);

  return {
    calls: num(callRow?.total),
    answered,
    missed: num(callRow?.missed),
    talkTimeSeconds: talkTime,
    // Average over answered calls only. Including unanswered ones would divide real talk
    // time by a count that includes calls with none, halving the figure for no reason.
    averageDurationSeconds: answered > 0 ? Math.round(talkTime / answered) : 0,
    followUpsCompleted: num(followUpRow?.completed),
    followUpsPending: num(pendingRow?.pending),
    leadsContacted: num(callRow?.contacted),
    leadsConverted: num(convertedRow?.converted),
  };
}

/* -------------------------------------------------------------------------- */
/* Admin dashboard                                                             */
/* -------------------------------------------------------------------------- */

export type AdminDashboard = {
  leads: {
    total: number;
    new: number;
    assigned: number;
    unassigned: number;
    converted: number;
    lost: number;
    /** Customers who came to the office. Added with migration 012. */
    walkedIn: number;
  };
  calls: {
    total: number;
    answered: number;
    missed: number;
    talkTimeSeconds: number;
  };
  followUps: {
    today: number;
    overdue: number;
    completed: number;
  };
  employees: {
    total: number;
    active: number;
  };
  conversionRate: number;
};

export async function adminDashboard(range: DateRange): Promise<AdminDashboard> {
  const leadParams: SqlParam[] = [];
  const leadRange = rangeClause('created_at', range, leadParams);

  const leadRow = await queryOne<
    RowDataPacket & {
      total: number;
      fresh: number;
      assigned: number;
      unassigned: number;
      converted: number;
      lost: number;
      walked_in: number;
    }
  >(
    /*
     * One more SUM on a scan that was happening anyway. A separate query for the
     * walked-in tile would double the work to answer a question the same rows already
     * contain.
     */
    `SELECT COUNT(*) AS total,
            SUM(status = 'new') AS fresh,
            SUM(assigned_to IS NOT NULL) AS assigned,
            SUM(assigned_to IS NULL) AS unassigned,
            SUM(status = 'converted') AS converted,
            SUM(status = 'lost') AS lost,
            SUM(status = 'walked_in') AS walked_in
       FROM leads
      WHERE is_archived = 0${leadRange}`,
    leadParams,
  );

  const callParams: SqlParam[] = [];
  const callRange = rangeClause('started_at', range, callParams);

  const callRow = await queryOne<
    RowDataPacket & { total: number; answered: number; missed: number; talk_time: number }
  >(
    `SELECT COUNT(*) AS total,
            SUM(outcome = 'answered') AS answered,
            SUM(outcome IN ('missed','rejected','busy','unreachable','no_answer')) AS missed,
            COALESCE(SUM(CASE WHEN outcome = 'answered' THEN duration_seconds ELSE 0 END), 0) AS talk_time
       FROM calls
      WHERE 1 = 1${callRange}`,
    callParams,
  );

  const followUpRow = await queryOne<
    RowDataPacket & { today: number; overdue: number; completed: number }
  >(
    `SELECT SUM(state = 'pending' AND DATE(due_at) = CURDATE()) AS today,
            SUM(state = 'pending' AND due_at < NOW()) AS overdue,
            SUM(state = 'completed' AND DATE(completed_at) = CURDATE()) AS completed
       FROM follow_ups`,
  );

  /*
   * `total` counts only APPROVED accounts, and `active` only approved-and-enabled ones.
   *
   * Without the approval filter a pending self-registration would be counted in the
   * headcount tile the moment someone signed up — so the dashboard would report staff
   * the business does not have, and an unvetted applicant would inflate the denominator
   * of every per-employee average.
   */
  const employeeRow = await queryOne<RowDataPacket & { total: number; active: number }>(
    `SELECT COUNT(*) AS total,
            SUM(is_active = 1) AS active
       FROM telecaller_users
      WHERE approval_status = 'approved'`,
  );

  const total = num(leadRow?.total);
  const converted = num(leadRow?.converted);

  return {
    leads: {
      total,
      new: num(leadRow?.fresh),
      assigned: num(leadRow?.assigned),
      unassigned: num(leadRow?.unassigned),
      converted,
      lost: num(leadRow?.lost),
      walkedIn: num(leadRow?.walked_in),
    },
    calls: {
      total: num(callRow?.total),
      answered: num(callRow?.answered),
      missed: num(callRow?.missed),
      talkTimeSeconds: num(callRow?.talk_time),
    },
    followUps: {
      today: num(followUpRow?.today),
      overdue: num(followUpRow?.overdue),
      completed: num(followUpRow?.completed),
    },
    employees: {
      total: num(employeeRow?.total),
      active: num(employeeRow?.active),
    },
    // Rounded to one decimal. A conversion rate quoted to six places invites someone to
    // read meaning into noise from a sample of forty leads.
    conversionRate: total > 0 ? Math.round((converted / total) * 1000) / 10 : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Performance comparison (spec: Admin Module 12)                              */
/* -------------------------------------------------------------------------- */

export type EmployeePerformance = {
  userId: number;
  employeeCode: string;
  name: string;
  role: string;
  isActive: boolean;
  calls: number;
  answered: number;
  missed: number;
  talkTimeSeconds: number;
  averageDurationSeconds: number;
  followUpsCompleted: number;
  followUpsPending: number;
  leadsAssigned: number;
  leadsContacted: number;
  leadsConverted: number;
  conversionRate: number;
};

/**
 * One aggregate column in the performance query: its SQL and its own parameters,
 * kept together.
 *
 * The alternative — building the clauses in one place and the parameter list in another —
 * relies on two hand-maintained orderings agreeing. They will not stay in agreement, and
 * when they drift the query still runs and silently reports one employee's date range
 * against another's numbers. Pairing them means adding a column cannot get the binding
 * wrong.
 */
type AggregateColumn = { sql: string; alias: string; params: SqlParam[] };

function aggregate(
  alias: string,
  build: (rangeSql: string) => string,
  column: string,
  range: DateRange,
): AggregateColumn {
  const params: SqlParam[] = [];
  const rangeSql = rangeClause(column, range, params);
  return { alias, sql: build(rangeSql), params };
}

/** An aggregate that deliberately ignores the report's date range. */
function liveAggregate(alias: string, sql: string): AggregateColumn {
  return { alias, sql, params: [] };
}

/**
 * Every employee's numbers side by side.
 *
 * Written as correlated subqueries per employee rather than as four LEFT JOINs with
 * GROUP BY. Joining calls, follow-ups and leads in one statement multiplies rows across
 * the three dimensions, and the aggregates then have to be de-duplicated with
 * COUNT(DISTINCT ...) on every column — both slower and much easier to get quietly
 * wrong. The staff table has tens of rows, so the subqueries run tens of times against
 * indexes built for exactly these predicates.
 */
export async function employeePerformance(range: DateRange): Promise<EmployeePerformance[]> {
  const columns: AggregateColumn[] = [
    aggregate(
      'calls',
      (r) => `(SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'answered',
      (r) => `(SELECT SUM(c.outcome = 'answered') FROM calls c WHERE c.user_id = u.id${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'missed',
      (r) =>
        `(SELECT SUM(c.outcome IN ('missed','rejected','busy','unreachable','no_answer'))
            FROM calls c WHERE c.user_id = u.id${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'talk_time',
      (r) =>
        `(SELECT COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0)
            FROM calls c WHERE c.user_id = u.id${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'leads_contacted',
      (r) =>
        `(SELECT COUNT(DISTINCT c.lead_id) FROM calls c
           WHERE c.user_id = u.id AND c.outcome = 'answered' AND c.lead_id IS NOT NULL${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'follow_ups_completed',
      (r) =>
        `(SELECT COUNT(*) FROM follow_ups f
           WHERE f.completed_by = u.id AND f.state = 'completed'${r})`,
      'f.completed_at',
      range,
    ),
    // Unfiltered on purpose: "how much do I still owe" does not change meaning because
    // the report is filtered to last week. Same reasoning as employeeActivitySummary.
    liveAggregate(
      'follow_ups_pending',
      `(SELECT COUNT(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.state = 'pending')`,
    ),
    liveAggregate(
      'leads_assigned',
      `(SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.is_archived = 0)`,
    ),
    aggregate(
      'leads_converted',
      (r) =>
        `(SELECT COUNT(*) FROM leads l
           WHERE l.assigned_to = u.id AND l.status = 'converted' AND l.converted_at IS NOT NULL${r})`,
      'l.converted_at',
      range,
    ),
  ];

  const selectList = columns.map((column) => `${column.sql} AS ${column.alias}`).join(',\n            ');
  const params = columns.flatMap((column) => column.params);

  const rows = await query<
    RowDataPacket & {
      user_id: number;
      employee_code: string;
      name: string;
      role: string;
      is_active: number;
      calls: number;
      answered: number;
      missed: number;
      talk_time: number;
      follow_ups_completed: number;
      follow_ups_pending: number;
      leads_assigned: number;
      leads_contacted: number;
      leads_converted: number;
    }
  >(
    `SELECT u.id AS user_id, u.employee_code, u.name, u.role, u.is_active,
            ${selectList}
       FROM telecaller_users u
      WHERE u.approval_status = 'approved'
        AND (u.role = 'telecaller' OR EXISTS (SELECT 1 FROM calls c WHERE c.user_id = u.id))
      ORDER BY u.is_active DESC, u.name ASC`,
    params,
  );

  return rows.map((row) => {
    const answered = num(row.answered);
    const talkTime = num(row.talk_time);
    const assigned = num(row.leads_assigned);
    const converted = num(row.leads_converted);

    return {
      userId: row.user_id,
      employeeCode: row.employee_code,
      name: row.name,
      role: row.role,
      isActive: row.is_active === 1,
      calls: num(row.calls),
      answered,
      missed: num(row.missed),
      talkTimeSeconds: talkTime,
      averageDurationSeconds: answered > 0 ? Math.round(talkTime / answered) : 0,
      followUpsCompleted: num(row.follow_ups_completed),
      followUpsPending: num(row.follow_ups_pending),
      leadsAssigned: assigned,
      leadsContacted: num(row.leads_contacted),
      leadsConverted: converted,
      conversionRate: assigned > 0 ? Math.round((converted / assigned) * 1000) / 10 : 0,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Trends and breakdowns (spec: Admin Module 11)                               */
/* -------------------------------------------------------------------------- */

export type CallTrendPoint = {
  period: string;
  calls: number;
  answered: number;
  missed: number;
  talkTimeSeconds: number;
};

/**
 * Call volume grouped by day, week or month.
 *
 * The grouping expression is chosen from a closed set rather than built from input: it
 * lands in both SELECT and GROUP BY, where a bound parameter is not accepted.
 */
export async function callTrend(
  granularity: 'day' | 'week' | 'month',
  range: DateRange,
  userId?: number,
): Promise<CallTrendPoint[]> {
  const format =
    granularity === 'day' ? "'%Y-%m-%d'" : granularity === 'week' ? "'%x-W%v'" : "'%Y-%m'";

  const params: SqlParam[] = [];
  let where = 'WHERE 1 = 1';

  if (userId) {
    where += ' AND user_id = ?';
    params.push(userId);
  }

  where += rangeClause('started_at', range, params);

  const rows = await query<
    RowDataPacket & {
      period: string;
      calls: number;
      answered: number;
      missed: number;
      talk_time: number;
    }
  >(
    `SELECT DATE_FORMAT(started_at, ${format}) AS period,
            COUNT(*) AS calls,
            SUM(outcome = 'answered') AS answered,
            SUM(outcome IN ('missed','rejected','busy','unreachable','no_answer')) AS missed,
            COALESCE(SUM(CASE WHEN outcome = 'answered' THEN duration_seconds ELSE 0 END), 0) AS talk_time
       FROM calls
       ${where}
      GROUP BY period
      ORDER BY period ASC
      LIMIT 400`,
    params,
  );

  return rows.map((row) => ({
    period: row.period,
    calls: num(row.calls),
    answered: num(row.answered),
    missed: num(row.missed),
    talkTimeSeconds: num(row.talk_time),
  }));
}

export type BreakdownRow = {
  key: string;
  total: number;
  converted: number;
  conversionRate: number;
};

/** Lead counts and conversion grouped by status, source, or owner. */
export async function leadBreakdown(
  dimension: 'status' | 'source' | 'employee',
  range: DateRange,
): Promise<BreakdownRow[]> {
  const params: SqlParam[] = [];
  const where = `WHERE l.is_archived = 0${rangeClause('l.created_at', range, params)}`;

  const groupExpression =
    dimension === 'status'
      ? 'l.status'
      : dimension === 'source'
        ? 'l.source'
        : "COALESCE(u.name, 'Unassigned')";

  const join = dimension === 'employee' ? 'LEFT JOIN telecaller_users u ON u.id = l.assigned_to' : '';

  const rows = await query<RowDataPacket & { bucket: string; total: number; converted: number }>(
    `SELECT ${groupExpression} AS bucket,
            COUNT(*) AS total,
            SUM(l.status = 'converted') AS converted
       FROM leads l
       ${join}
       ${where}
      GROUP BY bucket
      ORDER BY total DESC
      LIMIT 100`,
    params,
  );

  return rows.map((row) => {
    const total = num(row.total);
    const converted = num(row.converted);
    return {
      key: row.bucket,
      total,
      converted,
      conversionRate: total > 0 ? Math.round((converted / total) * 1000) / 10 : 0,
    };
  });
}

/** Follow-up performance: booked, completed, still pending, and how late (Module 11). */
export type FollowUpPerformance = {
  created: number;
  completed: number;
  pending: number;
  overdue: number;
  cancelled: number;
  completedOnTime: number;
  completedLate: number;
};

export async function followUpPerformance(
  range: DateRange,
  userId?: number,
): Promise<FollowUpPerformance> {
  const params: SqlParam[] = [];
  let where = 'WHERE 1 = 1';

  if (userId) {
    where += ' AND assigned_to = ?';
    params.push(userId);
  }

  where += rangeClause('created_at', range, params);

  const row = await queryOne<
    RowDataPacket & {
      created: number;
      completed: number;
      pending: number;
      overdue: number;
      cancelled: number;
      on_time: number;
      late: number;
    }
  >(
    `SELECT COUNT(*) AS created,
            SUM(state = 'completed') AS completed,
            SUM(state = 'pending') AS pending,
            SUM(state = 'pending' AND due_at < NOW()) AS overdue,
            SUM(state = 'cancelled') AS cancelled,
            SUM(state = 'completed' AND completed_at <= due_at) AS on_time,
            SUM(state = 'completed' AND completed_at > due_at) AS late
       FROM follow_ups
       ${where}`,
    params,
  );

  return {
    created: num(row?.created),
    completed: num(row?.completed),
    pending: num(row?.pending),
    overdue: num(row?.overdue),
    cancelled: num(row?.cancelled),
    completedOnTime: num(row?.on_time),
    completedLate: num(row?.late),
  };
}

/* -------------------------------------------------------------------------- */
/* Overdue alerting (spec: Admin Module 10)                                    */
/* -------------------------------------------------------------------------- */

export type OverdueGroup = {
  userId: number;
  name: string;
  overdue: number;
  oldestDueAt: string;
};

/** Overdue follow-ups per employee, for the admin alert and the dashboard warning. */
export async function overdueByEmployee(minimumHours: number): Promise<OverdueGroup[]> {
  const hours = Math.min(Math.max(Math.trunc(minimumHours), 0), 24 * 90);

  const rows = await query<
    RowDataPacket & { user_id: number; name: string; overdue: number; oldest: Date }
  >(
    `SELECT f.assigned_to AS user_id, u.name, COUNT(*) AS overdue, MIN(f.due_at) AS oldest
       FROM follow_ups f
       JOIN telecaller_users u ON u.id = f.assigned_to
      WHERE f.state = 'pending'
        AND f.due_at < (NOW() - INTERVAL ${hours} HOUR)
      GROUP BY f.assigned_to, u.name
      ORDER BY overdue DESC`,
  );

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    overdue: num(row.overdue),
    oldestDueAt: new Date(row.oldest).toISOString(),
  }));
}
