import { query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import {
  bucketSql,
  companyRangeClause,
  companyTodayCondition,
  localSql,
  MAX_CHART_FRAMES,
  type Granularity,
} from '../companyTime';
import {
  companyLineSql,
  UNANSWERED_SQL_LIST,
  type DateRange,
  type LeadStatus,
} from '../shared.schema';

/**
 * Dashboard and report aggregates (spec: Mobile Modules 2 and 12, Admin Modules 2, 11, 12).
 *
 * Every figure here is computed at query time. There is no summary table and no nightly
 * rollup job, on purpose: a cached counter that is wrong is a bug that takes days to
 * notice and hours to trace, whereas a slow query announces itself immediately and can
 * be fixed with an index. When one of these does get slow, measure first — the indexes
 * in migrations 006–008 and 024 were chosen for exactly these shapes.
 *
 * Two rules hold for every query in this file, because a tile, the chart beside it and
 * the list either of them opens must count the same rows:
 *
 *   - A day is the company's day, in IST. Ranges and "today" are half-open instant bounds
 *     from `companyTime.ts` — never `CURDATE()` or `'YYYY-MM-DD 00:00:00'`, which inside
 *     the UTC-pinned pool end the working day at 05:30 in the morning.
 *   - A call counts only on the company line (`companyLineSql`): every outgoing call, and
 *     an incoming one once it was verified as received on the employee's company SIM.
 *     Older unverified incoming rows stay in the table and in lead history, and are in no
 *     figure here — that is where personal calls on a second SIM sit.
 */

/**
 * A report window as two instants — `start` inclusive, `end` exclusive.
 *
 * For a caller that has already worked out the exact window, such as the daily email: it
 * reports one finished IST day, and must count exactly the instants it names rather than
 * have them re-derived from calendar dates.
 */
export type InstantRange = { start: Date; end: Date };

/**
 * What a report can be bounded by: inclusive IST calendar dates — what every screen
 * sends — or an exact instant window.
 */
export type ReportRange = DateRange | InstantRange;

function isInstantRange(range: ReportRange): range is InstantRange {
  return 'start' in range;
}

/**
 * Turns a report range into a bounded SQL predicate on `column`, pushing the bounds.
 *
 * Calendar dates go through `companyRangeClause`: half-open IST day bounds, bound as Date
 * objects. This used to bind `'${from} 00:00:00'` and `'${to} 23:59:59'` against UTC
 * columns, so every range — every tile, report and the mobile "My activity" — ran from
 * 05:30 to 05:29 IST and filed early-morning calls under the previous day, while the
 * lists the tiles open drew the line somewhere else.
 *
 * An instant window is bound exactly as given, with the same half-open shape.
 */
function rangeClause(column: string, range: ReportRange, params: SqlParam[]): string {
  if (isInstantRange(range)) {
    params.push(range.start, range.end);
    return ` AND ${column} >= ? AND ${column} < ?`;
  }
  return companyRangeClause(column, range, params);
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
  /**
   * Calls the customer made to us.
   *
   * Separate from `calls`, which counts both directions, because the two answer different
   * questions: `calls.today` is how much work the telecaller did, `incoming` is how much
   * work came to them. A day of forty outgoing calls and a day of forty incoming ones are
   * not the same day, and one number cannot say which it was.
   */
  incoming: {
    today: number;
    missedToday: number;
    /** Not day-bounded: a call missed on Friday is still unhandled on Monday. */
    unhandled: number;
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
    /*
     * `fresh` counts leads never contacted, NOT leads whose status is still 'new'.
     *
     * Those are different sets and the difference is not small. Logging a call does not
     * change a lead's status — the post-call sheet only writes one if the telecaller
     * picks it — so a lead that has been rung twice stays 'new' and kept appearing under
     * "Not yet called". The reverse also happened: a lead set to 'not_reachable' without
     * a call left the tile while still never having been contacted.
     *
     * `last_contacted_at` is the column that records contact, maintained by the call
     * logger, so it is the one the tile's own label describes.
     */
    `SELECT COUNT(*) AS assigned,
            SUM(last_contacted_at IS NULL) AS fresh,
            SUM(status NOT IN ('converted','lost','not_interested','invalid_number')) AS open,
            SUM(status = 'converted') AS converted
       FROM leads
      WHERE assigned_to = ? AND is_archived = 0`,
    [userId],
  );

  /*
   * One instant for both "today" windows below, so a request that straddles IST midnight
   * cannot count its follow-ups on one day and its calls on the next.
   */
  const now = new Date();

  /*
   * "Due today" is the IST day, the window the follow-up list's Today tab uses.
   *
   * It was `DATE(due_at) = CURDATE()`, which inside the UTC-pinned pool is the UTC date:
   * a follow-up due at 09:00 IST counted, one due at 05:00 IST was "yesterday's", and the
   * tile disagreed with the list it opens. Overdue and upcoming compare instants with
   * `NOW()` and were never affected.
   */
  const followUpParams: SqlParam[] = [];
  const dueToday = companyTodayCondition('due_at', followUpParams, now);
  followUpParams.push(userId);

  const followUpRow = await queryOne<
    RowDataPacket & { today: number; overdue: number; upcoming: number }
  >(
    `SELECT SUM(${dueToday}) AS today,
            SUM(due_at < NOW()) AS overdue,
            SUM(due_at > NOW()) AS upcoming
       FROM follow_ups
      WHERE assigned_to = ? AND state = 'pending'`,
    followUpParams,
  );

  /**
   * Today's calls are the IST day's, by `started_at` — the client's timestamp, so a call
   * logged from the offline queue counts on the day it happened, not the day it synced.
   * The bounds are the ones the call list's date filter uses, so the figure matches what
   * the telecaller sees in their own call list.
   */
  const callParams: SqlParam[] = [userId];
  const startedToday = companyTodayCondition('c.started_at', callParams, now);

  const callRow = await queryOne<
    RowDataPacket & {
      total: number;
      answered: number;
      missed: number;
      talk_time: number;
      incoming: number;
      incoming_missed: number;
    }
  >(
    /*
     * The incoming columns ride along on this query rather than getting one of their own.
     *
     * Same table, same row set, same day — a second query would scan
     * `idx_calls_user_started` twice to read two more numbers out of rows already in
     * hand. `outcome <> 'answered'` is the same test the Incoming screen uses to colour a
     * row missed, so the tile and the list cannot disagree about what missed means.
     */
    `SELECT COUNT(*) AS total,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome = 'missed') AS missed,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time,
            SUM(c.direction = 'incoming') AS incoming,
            SUM(c.direction = 'incoming' AND c.outcome <> 'answered') AS incoming_missed
       FROM calls c
      WHERE c.user_id = ? AND ${startedToday} AND ${companyLineSql('c')}`,
    callParams,
  );

  const pendingRow = await queryOne<
    RowDataPacket & { total: number; unread: number; incoming_unhandled: number }
  >(
    /*
     * `incoming_unhandled` is not a subset of `total`, and the overlap is the point.
     *
     * `total` — the callback queue — is every unanswered call in either direction. An
     * incoming call the telecaller ANSWERED but has not acted on is missing from it, and
     * that is exactly the call this feature exists to surface: the customer got through,
     * said something, and nobody has done anything since. So this counts unhandled
     * incoming calls whatever their outcome, and the two figures are shown as two tiles
     * rather than being added together.
     *
     * Both count the company line only, like the callback list they open: a missed call
     * on someone's personal SIM is not work the company is owed.
     */
    `SELECT
       (SELECT COUNT(*) FROM calls c
         WHERE c.user_id = ?
           AND c.followed_up = 0
           AND c.outcome IN (${UNANSWERED_SQL_LIST})
           AND ${companyLineSql('c')}) AS total,
       (SELECT COUNT(*) FROM calls c
         WHERE c.user_id = ?
           AND c.direction = 'incoming'
           AND c.followed_up = 0
           AND ${companyLineSql('c')}) AS incoming_unhandled,
       (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS unread`,
    [userId, userId, userId],
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
    incoming: {
      today: num(callRow?.incoming),
      missedToday: num(callRow?.incoming_missed),
      unhandled: num(pendingRow?.incoming_unhandled),
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
  /**
   * `calls` split by direction: dialled from the app, and received on the company SIM.
   *
   * Additive — `outgoingCalls + incomingCalls === calls` — so the existing tiles keep
   * their meaning and the screen can say "8 made · 4 received" under them.
   */
  outgoingCalls: number;
  incomingCalls: number;
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
  const callRange = rangeClause('c.started_at', range, callParams);

  const callRow = await queryOne<
    RowDataPacket & {
      total: number;
      outgoing: number;
      incoming: number;
      answered: number;
      missed: number;
      talk_time: number;
      contacted: number;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(c.direction = 'outgoing') AS outgoing,
            SUM(c.direction = 'incoming') AS incoming,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome IN (${UNANSWERED_SQL_LIST})) AS missed,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time,
            COUNT(DISTINCT CASE WHEN c.outcome = 'answered' THEN c.lead_id END) AS contacted
       FROM calls c
      WHERE c.user_id = ? AND ${companyLineSql('c')}${callRange}`,
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
    outgoingCalls: num(callRow?.outgoing),
    incomingCalls: num(callRow?.incoming),
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
    /**
     * Of `total`, how many the customer initiated, and how many of those nobody picked up.
     *
     * Reported inside `calls` rather than beside it because they are a subset of the same
     * figure — presenting them as a separate total invites a manager to add the two
     * together and double-count the period's activity.
     */
    incoming: number;
    incomingMissed: number;
  };
  followUps: {
    today: number;
    overdue: number;
    completed: number;
  };
  /**
   * Approved staff, and how many of them are enabled. Not bound by the range.
   *
   * Named `headcount`, not `employees`: the route sends the per-employee performance rows
   * as `employees`, and when this was called that too, spreading it into the response and
   * then setting the rows overwrote it — the "Active employees" tile rendered blank.
   */
  headcount: {
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
    /* `fresh` is "never contacted", for the reason given on the employee query above. */
    `SELECT COUNT(*) AS total,
            SUM(last_contacted_at IS NULL) AS fresh,
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
  const callRange = rangeClause('c.started_at', range, callParams);

  const callRow = await queryOne<
    RowDataPacket & {
      total: number;
      answered: number;
      missed: number;
      talk_time: number;
      incoming: number;
      incoming_missed: number;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome IN (${UNANSWERED_SQL_LIST})) AS missed,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time,
            SUM(c.direction = 'incoming') AS incoming,
            SUM(c.direction = 'incoming' AND c.outcome <> 'answered') AS incoming_missed
       FROM calls c
      WHERE ${companyLineSql('c')}${callRange}`,
    callParams,
  );

  /*
   * Live, not bound by the range: "due today" and "completed today" are about the IST day
   * the admin is looking at the screen on — the same windows as the follow-up list's
   * Today and Completed-today tabs these cards open, so a card and its list agree.
   */
  const now = new Date();
  const followUpParams: SqlParam[] = [];
  const dueToday = companyTodayCondition('due_at', followUpParams, now);
  const completedToday = companyTodayCondition('completed_at', followUpParams, now);

  const followUpRow = await queryOne<
    RowDataPacket & { today: number; overdue: number; completed: number }
  >(
    `SELECT SUM(state = 'pending' AND ${dueToday}) AS today,
            SUM(state = 'pending' AND due_at < NOW()) AS overdue,
            SUM(state = 'completed' AND ${completedToday}) AS completed
       FROM follow_ups`,
    followUpParams,
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
      incoming: num(callRow?.incoming),
      incomingMissed: num(callRow?.incoming_missed),
    },
    followUps: {
      today: num(followUpRow?.today),
      overdue: num(followUpRow?.overdue),
      completed: num(followUpRow?.completed),
    },
    headcount: {
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
  /**
   * `calls` by direction, and the incoming ones nobody answered — the same definitions as
   * the dashboard's Incoming tiles. `outgoing + incoming === calls`.
   */
  outgoing: number;
  incoming: number;
  incomingMissed: number;
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
  range: ReportRange,
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
 *
 * Takes a calendar range (every screen) or an exact instant window (the daily email),
 * so the dashboard, the Reports screen and the email share one definition of every
 * per-employee figure.
 */
export async function employeePerformance(range: ReportRange): Promise<EmployeePerformance[]> {
  /*
   * Every call aggregate — and the "has made calls" test that brings a non-telecaller
   * into the table — counts the company line only, like every other call figure.
   */
  const line = companyLineSql('c');

  const columns: AggregateColumn[] = [
    aggregate(
      'calls',
      (r) => `(SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'answered',
      (r) =>
        `(SELECT SUM(c.outcome = 'answered') FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'missed',
      (r) =>
        `(SELECT SUM(c.outcome IN (${UNANSWERED_SQL_LIST}))
            FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'outgoing',
      (r) =>
        `(SELECT SUM(c.direction = 'outgoing') FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'incoming',
      (r) =>
        `(SELECT SUM(c.direction = 'incoming') FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'incoming_missed',
      (r) =>
        `(SELECT SUM(c.direction = 'incoming' AND c.outcome <> 'answered')
            FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'talk_time',
      (r) =>
        `(SELECT COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0)
            FROM calls c WHERE c.user_id = u.id AND ${line}${r})`,
      'c.started_at',
      range,
    ),
    aggregate(
      'leads_contacted',
      (r) =>
        `(SELECT COUNT(DISTINCT c.lead_id) FROM calls c
           WHERE c.user_id = u.id AND c.outcome = 'answered' AND c.lead_id IS NOT NULL
             AND ${line}${r})`,
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
      outgoing: number;
      incoming: number;
      incoming_missed: number;
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
        AND (u.role = 'telecaller' OR EXISTS (SELECT 1 FROM calls c WHERE c.user_id = u.id AND ${line}))
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
      outgoing: num(row.outgoing),
      incoming: num(row.incoming),
      incomingMissed: num(row.incoming_missed),
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
 *
 * Periods are read on the IST clock (`localSql`), so a call at 01:00 IST belongs to the
 * day it was made on, as it does on the dashboard and in the lists. The period strings
 * keep their shapes, so the Reports screen reads them unchanged.
 */
/** The most periods one call-trend request returns: the newest ones, oldest first. */
const CALL_TREND_MAX_PERIODS = 400;

export async function callTrend(
  granularity: 'day' | 'week' | 'month',
  range: DateRange,
  userId?: number,
): Promise<{ points: CallTrendPoint[]; truncated: boolean }> {
  const format =
    granularity === 'day' ? "'%Y-%m-%d'" : granularity === 'week' ? "'%x-W%v'" : "'%Y-%m'";

  const params: SqlParam[] = [];
  let where = `WHERE ${companyLineSql('c')}`;

  if (userId) {
    where += ' AND c.user_id = ?';
    params.push(userId);
  }

  where += rangeClause('c.started_at', range, params);

  const rows = await query<
    RowDataPacket & {
      period: string;
      calls: number;
      answered: number;
      missed: number;
      talk_time: number;
    }
  >(
    `SELECT DATE_FORMAT(${localSql('c.started_at')}, ${format}) AS period,
            COUNT(*) AS calls,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome IN (${UNANSWERED_SQL_LIST})) AS missed,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time
       FROM calls c
       ${where}
      GROUP BY period
      ORDER BY period DESC
      LIMIT ${CALL_TREND_MAX_PERIODS + 1}`,
    params,
  );

  /*
   * The NEWEST periods when there are more than the cap — ascending order with a LIMIT
   * kept the oldest four hundred and silently dropped every recent day (one handset with
   * a reset clock stamping 1970 is enough to get there). The extra row only says whether
   * anything older was left out, so the screen can say so.
   */
  const truncated = rows.length > CALL_TREND_MAX_PERIODS;
  const points = rows
    .slice(0, CALL_TREND_MAX_PERIODS)
    .reverse()
    .map((row) => ({
      period: row.period,
      calls: num(row.calls),
      answered: num(row.answered),
      missed: num(row.missed),
      talkTimeSeconds: num(row.talk_time),
    }));

  return { points, truncated };
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
  range: ReportRange,
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
/* Dashboard analytics (the trend charts, spec: Admin Module 2)                */
/* -------------------------------------------------------------------------- */

/*
 * The grouped queries behind the dashboard charts. Each groups rows by `bucketSql` — the
 * IST hour, day, ISO week or month a row falls in — and the service zero-fills them
 * against `bucketFrames`, which produces exactly the same keys. `window` is the instants
 * the frames cover, so a row can only ever land in one of them.
 *
 * `LIMIT MAX_CHART_FRAMES` is a backstop, not a page: rows inside the window fall into at
 * most that many frames, so it never cuts a real result short.
 *
 * `userId` narrows every query to one employee: calls they made or took, leads assigned
 * to them, follow-ups they owe — the same columns the lists' employee filters use.
 */

export type CallBucketRow = {
  bucket: string;
  total: number;
  answered: number;
  notAnswered: number;
  outgoing: number;
  incoming: number;
  incomingNotAnswered: number;
  talkTimeSeconds: number;
};

/**
 * Calls per IST bucket, by outcome and by direction.
 *
 * The definitions are the Calls tiles' in `adminDashboard`, so the bars add up to the
 * tiles for the same range: not answered is the five unanswered outcomes, talk time
 * counts answered calls only, and only the company line counts.
 */
export async function callBuckets(
  window: InstantRange,
  granularity: Granularity,
  userId?: number,
): Promise<CallBucketRow[]> {
  const params: SqlParam[] = [window.start, window.end];
  let where = `WHERE c.started_at >= ? AND c.started_at < ? AND ${companyLineSql('c')}`;

  if (userId !== undefined) {
    where += ' AND c.user_id = ?';
    params.push(userId);
  }

  const rows = await query<
    RowDataPacket & {
      bucket: string;
      total: number;
      answered: number;
      not_answered: number;
      outgoing: number;
      incoming: number;
      incoming_not_answered: number;
      talk_time: number;
    }
  >(
    `SELECT ${bucketSql('c.started_at', granularity)} AS bucket,
            COUNT(*) AS total,
            SUM(c.outcome = 'answered') AS answered,
            SUM(c.outcome IN (${UNANSWERED_SQL_LIST})) AS not_answered,
            SUM(c.direction = 'outgoing') AS outgoing,
            SUM(c.direction = 'incoming') AS incoming,
            SUM(c.direction = 'incoming' AND c.outcome <> 'answered') AS incoming_not_answered,
            COALESCE(SUM(CASE WHEN c.outcome = 'answered' THEN c.duration_seconds ELSE 0 END), 0) AS talk_time
       FROM calls c
       ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ${MAX_CHART_FRAMES}`,
    params,
  );

  return rows.map((row) => ({
    bucket: String(row.bucket),
    total: num(row.total),
    answered: num(row.answered),
    notAnswered: num(row.not_answered),
    outgoing: num(row.outgoing),
    incoming: num(row.incoming),
    incomingNotAnswered: num(row.incoming_not_answered),
    talkTimeSeconds: num(row.talk_time),
  }));
}

export type CountBucketRow = { bucket: string; count: number };

/**
 * Non-archived leads created per IST bucket — the same set as the Leads tiles, which
 * count leads created in the range.
 */
export async function leadCreatedBuckets(
  window: InstantRange,
  granularity: Granularity,
  userId?: number,
): Promise<CountBucketRow[]> {
  const params: SqlParam[] = [window.start, window.end];
  let where = 'WHERE l.is_archived = 0 AND l.created_at >= ? AND l.created_at < ?';

  if (userId !== undefined) {
    where += ' AND l.assigned_to = ?';
    params.push(userId);
  }

  return countBuckets(bucketSql('l.created_at', granularity), where, params);
}

/**
 * Conversions per IST bucket, counted on the day the lead was marked converted —
 * whenever it was created. The leads list's conversion-date filter is the same
 * predicate, so a bucket opens exactly its rows.
 */
export async function leadConvertedBuckets(
  window: InstantRange,
  granularity: Granularity,
  userId?: number,
): Promise<CountBucketRow[]> {
  const params: SqlParam[] = [window.start, window.end];
  let where = `WHERE l.is_archived = 0 AND l.status = 'converted'
                 AND l.converted_at >= ? AND l.converted_at < ?`;

  if (userId !== undefined) {
    where += ' AND l.assigned_to = ?';
    params.push(userId);
  }

  return countBuckets(bucketSql('l.converted_at', granularity), where, params);
}

/** `bucketExpression` is a `bucketSql` result and `where` is built above — never input. */
async function countBuckets(
  bucketExpression: string,
  where: string,
  params: SqlParam[],
): Promise<CountBucketRow[]> {
  const rows = await query<RowDataPacket & { bucket: string; total: number }>(
    `SELECT ${bucketExpression} AS bucket, COUNT(*) AS total
       FROM leads l
       ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ${MAX_CHART_FRAMES}`,
    params,
  );

  return rows.map((row) => ({ bucket: String(row.bucket), count: num(row.total) }));
}

/**
 * The current status of the non-archived leads created in `range` — the same predicate
 * as the Leads tiles, so the counts add up to "Total leads" for the same range.
 *
 * Statuses with no leads are absent; the service puts all of them back, in order.
 */
export async function leadStatusCounts(
  range: DateRange,
  userId?: number,
): Promise<{ status: LeadStatus; count: number }[]> {
  const params: SqlParam[] = [];
  let where = `WHERE l.is_archived = 0${rangeClause('l.created_at', range, params)}`;

  if (userId !== undefined) {
    where += ' AND l.assigned_to = ?';
    params.push(userId);
  }

  const rows = await query<RowDataPacket & { status: LeadStatus; total: number }>(
    `SELECT l.status AS status, COUNT(*) AS total
       FROM leads l
       ${where}
      GROUP BY l.status`,
    params,
  );

  return rows.map((row) => ({ status: row.status, count: num(row.total) }));
}

/**
 * Follow-ups that fall DUE in the range, by what became of them.
 *
 * The parts always add up: every follow-up is completed, cancelled or pending, and a
 * pending one is overdue (due before now) or upcoming. Completed ones are on time when
 * they were done by the time they were due.
 */
export type FollowUpDueSummary = {
  total: number;
  completed: number;
  completedOnTime: number;
  completedLate: number;
  overdue: number;
  upcoming: number;
  cancelled: number;
};

/**
 * The follow-up chart's figures.
 *
 * `range` is the range exactly as requested, open ends included: with no `to`, follow-ups
 * due in the future count as upcoming, which is what "all time" means for work still to
 * do. Overdue is `due_at < NOW()` on the database clock, the same test as the follow-up
 * list's Overdue tab, so a slice opens its own rows.
 */
export async function followUpDueSummary(
  range: DateRange,
  userId?: number,
): Promise<FollowUpDueSummary> {
  const params: SqlParam[] = [];
  let where = `WHERE 1 = 1${rangeClause('f.due_at', range, params)}`;

  if (userId !== undefined) {
    where += ' AND f.assigned_to = ?';
    params.push(userId);
  }

  const row = await queryOne<
    RowDataPacket & {
      total: number;
      completed: number;
      on_time: number;
      pending: number;
      overdue: number;
      cancelled: number;
    }
  >(
    `SELECT COUNT(*) AS total,
            SUM(f.state = 'completed') AS completed,
            SUM(f.state = 'completed' AND f.completed_at <= f.due_at) AS on_time,
            SUM(f.state = 'pending') AS pending,
            SUM(f.state = 'pending' AND f.due_at < NOW()) AS overdue,
            SUM(f.state = 'cancelled') AS cancelled
       FROM follow_ups f
       ${where}`,
    params,
  );

  const completed = num(row?.completed);
  const onTime = num(row?.on_time);
  const pending = num(row?.pending);
  const overdue = num(row?.overdue);

  return {
    total: num(row?.total),
    completed,
    completedOnTime: onTime,
    completedLate: completed - onTime,
    overdue,
    upcoming: pending - overdue,
    cancelled: num(row?.cancelled),
  };
}

/**
 * The earliest company-line call or non-archived lead — where "all time" starts.
 *
 * Each side reads the first row of an index in order (`ORDER BY ... LIMIT 1`) and stops,
 * rather than `MIN()` over a filtered set, which the optimiser cannot answer from the
 * index once the company-line test is in the WHERE.
 */
export async function firstActivity(userId?: number): Promise<Date | null> {
  const params: SqlParam[] = [];
  let callWhere = `WHERE ${companyLineSql('c')}`;
  let leadWhere = 'WHERE l.is_archived = 0';

  if (userId !== undefined) {
    callWhere += ' AND c.user_id = ?';
    leadWhere += ' AND l.assigned_to = ?';
    params.push(userId, userId);
  }

  const row = await queryOne<RowDataPacket & { first_call: unknown; first_lead: unknown }>(
    `SELECT (SELECT c.started_at FROM calls c ${callWhere}
              ORDER BY c.started_at ASC LIMIT 1) AS first_call,
            (SELECT l.created_at FROM leads l ${leadWhere}
              ORDER BY l.created_at ASC LIMIT 1) AS first_lead`,
    params,
  );

  const instants = [instantOf(row?.first_call), instantOf(row?.first_lead)].filter(
    (value): value is Date => value !== null,
  );

  return instants.length > 0
    ? new Date(Math.min(...instants.map((value) => value.getTime())))
    : null;
}

/**
 * A DATETIME/TIMESTAMP read back from a subquery. The driver normally hands over a Date,
 * but a value it could not type arrives as text — read as UTC, like every stored time.
 */
function instantOf(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
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

/**
 * Overdue follow-ups per employee, for the admin alert and the dashboard warning.
 *
 * Overdue is measured against the database clock, unless `asOf` names the moment — for a
 * report generated about a time that is not now, which must not change when it is
 * regenerated later.
 */
export async function overdueByEmployee(
  minimumHours: number,
  asOf?: Date,
): Promise<OverdueGroup[]> {
  const hours = Math.min(Math.max(Math.trunc(minimumHours), 0), 24 * 90);
  const params: SqlParam[] = asOf ? [asOf] : [];
  const reference = asOf ? '?' : 'NOW()';

  const rows = await query<
    RowDataPacket & { user_id: number; name: string; overdue: number; oldest: Date }
  >(
    `SELECT f.assigned_to AS user_id, u.name, COUNT(*) AS overdue, MIN(f.due_at) AS oldest
       FROM follow_ups f
       JOIN telecaller_users u ON u.id = f.assigned_to
      WHERE f.state = 'pending'
        AND f.due_at < (${reference} - INTERVAL ${hours} HOUR)
      GROUP BY f.assigned_to, u.name
      ORDER BY overdue DESC`,
    params,
  );

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    overdue: num(row.overdue),
    oldestDueAt: new Date(row.oldest).toISOString(),
  }));
}
