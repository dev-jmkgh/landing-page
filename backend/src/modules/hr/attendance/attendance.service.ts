import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { logger } from '../../../utils/logger';
import {
  LOCAL_NOW,
  LOCAL_TODAY,
  distanceMetres,
  type AttendanceDay,
  type AttendanceSession,
  type AttendanceStatus,
  type Shift,
  type WorkLocation,
  type WorkMode,
} from './attendance.schema';

/**
 * Attendance: sessions, the geofence, and the arithmetic.
 *
 * A DAY IS MANY SESSIONS. `09:00 in · 13:00 out · 14:00 in · 18:00 out` is two
 * sessions, and each is stored in its own row. `hr_attendance` remains as the day
 * roll-up — first in, last out, total worked, total gap — recomputed on every punch so
 * the register and the monthly summary stay single-table reads.
 *
 * THE RULES THIS MODULE ENFORCES:
 *
 *   1. The server stamps the time. `NOW()` in SQL, never a value from the body.
 *   2. The server decides the geofence. The handset sends coordinates; the distance
 *      and the verdict are computed here.
 *   3. One open session per person, enforced by a unique index on a generated column
 *      (migration 019) — not by a read-then-write, which loses the race against a
 *      double tap or a replayed offline punch.
 */

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

interface AssignmentRow extends RowDataPacket {
  work_mode: WorkMode;
  location_id: number | null;
  location_name: string | null;
  location_lat: string | null;
  location_lng: string | null;
  location_radius: number | null;
  location_active: number | null;
  shift_id: number | null;
  shift_name: string | null;
  shift_starts_at: string | null;
  shift_ends_at: string | null;
  shift_break_minutes: number | null;
  shift_grace_minutes: number | null;
  shift_half_day_minutes: number | null;
}

export type Assignment = {
  workMode: WorkMode;
  location: WorkLocation | null;
  shift: Shift | null;
  /** True when a punch must be inside the geofence to be accepted. */
  geofenced: boolean;
};

/**
 * What this employee is assigned to work.
 *
 * `geofenced` is derived here once rather than re-tested at each call site. It is true
 * only for an office worker WITH an active assigned site: remote and field workers are
 * never fenced, and an office worker with no site is a configuration gap the check-in
 * path reports rather than silently waving through.
 */
export async function assignmentFor(userId: number): Promise<Assignment> {
  const row = await queryOne<AssignmentRow>(
    `SELECT u.work_mode,
            l.id AS location_id, l.name AS location_name,
            l.latitude AS location_lat, l.longitude AS location_lng,
            l.radius_metres AS location_radius, l.is_active AS location_active,
            s.id AS shift_id, s.name AS shift_name,
            s.starts_at AS shift_starts_at, s.ends_at AS shift_ends_at,
            s.break_minutes AS shift_break_minutes,
            s.grace_minutes AS shift_grace_minutes,
            s.half_day_minutes AS shift_half_day_minutes
       FROM hr_users u
       LEFT JOIN hr_work_locations l ON l.id = u.work_location_id
       LEFT JOIN hr_shifts s         ON s.id = u.shift_id
      WHERE u.id = ?
      LIMIT 1`,
    [userId],
  );

  if (!row) return { workMode: 'office', location: null, shift: null, geofenced: false };

  const location: WorkLocation | null =
    row.location_id !== null
      ? {
          id: row.location_id,
          name: row.location_name ?? '',
          address: null,
          latitude: Number(row.location_lat),
          longitude: Number(row.location_lng),
          radiusMetres: Number(row.location_radius ?? 0),
          isActive: row.location_active === 1,
        }
      : null;

  const shift: Shift | null =
    row.shift_id !== null
      ? {
          id: row.shift_id,
          name: row.shift_name ?? '',
          startsAt: String(row.shift_starts_at),
          endsAt: String(row.shift_ends_at),
          breakMinutes: Number(row.shift_break_minutes ?? 0),
          graceMinutes: Number(row.shift_grace_minutes ?? 0),
          halfDayMinutes: Number(row.shift_half_day_minutes ?? 0),
          isActive: true,
        }
      : null;

  return {
    workMode: row.work_mode,
    location,
    shift,
    geofenced: row.work_mode === 'office' && location !== null && location.isActive,
  };
}

/* -------------------------------------------------------------------------- */
/* The geofence decision                                                       */
/* -------------------------------------------------------------------------- */

export type GeoVerdict =
  | { ok: true; distanceMetres: number | null; locationId: number | null }
  | { ok: false; reason: 'location_required' }
  | { ok: false; reason: 'no_site_assigned' }
  | { ok: false; reason: 'too_far'; distanceMetres: number; allowed: number; siteName: string };

/**
 * The accuracy allowance.
 *
 * A handset reports a position AND its own confidence in it. A reading 200m outside a
 * fence with a 500m accuracy radius means "I am somewhere in a 500m circle", not "I am
 * 200m away" — refusing it strands somebody standing in their own office behind thick
 * walls, which is how a geofence becomes a thing employees work around.
 *
 * Capped, because a cell-tower-only fix can report tens of kilometres and would make
 * the fence meaningless.
 */
const MAX_ACCURACY_ALLOWANCE_M = 250;

export function judgeLocation(
  assignment: Assignment,
  coordinate: { latitude: number; longitude: number; accuracyMetres?: number } | undefined,
): GeoVerdict {
  // Not fenced: record whatever arrived, decide nothing.
  if (!assignment.geofenced) {
    return { ok: true, distanceMetres: null, locationId: assignment.location?.id ?? null };
  }

  if (!assignment.location) return { ok: false, reason: 'no_site_assigned' };
  if (!coordinate) return { ok: false, reason: 'location_required' };

  const distance = distanceMetres(coordinate, assignment.location);

  const allowance = Math.min(
    Math.round(coordinate.accuracyMetres ?? 0),
    MAX_ACCURACY_ALLOWANCE_M,
  );
  const allowed = assignment.location.radiusMetres + allowance;

  if (distance > allowed) {
    return {
      ok: false,
      reason: 'too_far',
      distanceMetres: distance,
      allowed: assignment.location.radiusMetres,
      siteName: assignment.location.name,
    };
  }

  return { ok: true, distanceMetres: distance, locationId: assignment.location.id };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

interface AttendanceRow extends RowDataPacket {
  id: number;
  work_date: string;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  worked_minutes: number | null;
  break_minutes: number;
  late_minutes: number;
  early_minutes: number;
  status: AttendanceStatus;
  work_mode: WorkMode;
  shift_starts_at: string | null;
  shift_ends_at: string | null;
  source: 'app' | 'regularisation' | 'admin';
  note: string | null;
  session_count: number;
  open_session_started_at: Date | string | null;
}

/**
 * `work_date` is formatted in SQL rather than read as a Date.
 *
 * The driver reads DATETIME as UTC (see db/pool.ts), and a bare DATE becomes midnight
 * UTC — which in any zone west of UTC renders as the previous day. Formatting it here
 * keeps a calendar date a calendar date all the way to the client.
 */
const DAY_SELECT = `
  SELECT a.id,
         DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
         a.checked_in_at, a.checked_out_at,
         a.worked_minutes, a.break_minutes, a.late_minutes, a.early_minutes,
         a.status, a.work_mode,
         TIME_FORMAT(a.shift_starts_at, '%H:%i') AS shift_starts_at,
         TIME_FORMAT(a.shift_ends_at, '%H:%i')   AS shift_ends_at,
         a.source, a.note,
         (SELECT COUNT(*) FROM hr_attendance_sessions s
           WHERE s.attendance_id = a.id AND s.ended_at IS NOT NULL) AS session_count,
         (SELECT s.started_at FROM hr_attendance_sessions s
           WHERE s.attendance_id = a.id AND s.ended_at IS NULL
           ORDER BY s.id DESC LIMIT 1) AS open_session_started_at
    FROM hr_attendance a
`;

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

function toDay(row: AttendanceRow, sessions: AttendanceSession[] = []): AttendanceDay {
  return {
    id: row.id,
    workDate: String(row.work_date),
    checkedInAt: iso(row.checked_in_at),
    checkedOutAt: iso(row.checked_out_at),
    workedMinutes: row.worked_minutes === null ? null : Number(row.worked_minutes),
    breakMinutes: Number(row.break_minutes),
    lateMinutes: Number(row.late_minutes),
    earlyMinutes: Number(row.early_minutes),
    status: row.status,
    workMode: row.work_mode,
    shiftStartsAt: row.shift_starts_at,
    shiftEndsAt: row.shift_ends_at,
    source: row.source,
    note: row.note,
    completedSessions: Number(row.session_count),
    openSessionStartedAt: iso(row.open_session_started_at),
    sessions,
  };
}

interface SessionRow extends RowDataPacket {
  id: number;
  attendance_id: number;
  started_at: Date | string;
  ended_at: Date | string | null;
  minutes: number | null;
  source: 'app' | 'regularisation' | 'admin';
}

function toSession(row: SessionRow): AttendanceSession {
  return {
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: iso(row.ended_at),
    minutes: row.minutes === null ? null : Number(row.minutes),
    source: row.source,
  };
}

async function sessionsFor(attendanceIds: number[]): Promise<Map<number, AttendanceSession[]>> {
  const byDay = new Map<number, AttendanceSession[]>();
  if (attendanceIds.length === 0) return byDay;

  /*
   * One query for every day in the range, grouped in memory — not one query per day.
   * A month of history is up to 31 days, and 31 round trips to render one list is the
   * classic N+1 that makes a screen feel broken on a slow connection.
   *
   * The ids are interpolated rather than bound: they come from rows this process just
   * read, so they are integers by construction, and a variable-length `IN (?)` cannot
   * be expressed with placeholders.
   */
  const rows = await query<SessionRow>(
    `SELECT id, attendance_id, started_at, ended_at, minutes, source
       FROM hr_attendance_sessions
      WHERE attendance_id IN (${attendanceIds.map((id) => Number(id)).join(',')})
      ORDER BY started_at ASC`,
  );

  for (const row of rows) {
    const list = byDay.get(row.attendance_id) ?? [];
    list.push(toSession(row));
    byDay.set(row.attendance_id, list);
  }

  return byDay;
}

export async function todayFor(userId: number): Promise<AttendanceDay | null> {
  const row = await queryOne<AttendanceRow>(
    `${DAY_SELECT} WHERE a.user_id = ? AND a.work_date = ${LOCAL_TODAY} LIMIT 1`,
    [userId],
  );
  if (!row) return null;

  const sessions = await sessionsFor([row.id]);
  return toDay(row, sessions.get(row.id) ?? []);
}

export async function historyFor(
  userId: number,
  from: string,
  to: string,
): Promise<AttendanceDay[]> {
  const rows = await query<AttendanceRow>(
    `${DAY_SELECT}
      WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date DESC`,
    [userId, from, to],
  );

  const sessions = await sessionsFor(rows.map((row) => row.id));
  return rows.map((row) => toDay(row, sessions.get(row.id) ?? []));
}

/* -------------------------------------------------------------------------- */
/* The day roll-up                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Recomputes a day from its sessions.
 *
 * Called after every punch. Everything here is DERIVED — nothing accumulates, so a
 * correction or a deleted session cannot leave a stale total behind.
 *
 *   checked_in_at   first session start
 *   checked_out_at  last session end, NULL while any session is open
 *   worked_minutes  sum of completed sessions
 *   break_minutes   the span from first in to last out, less time actually worked —
 *                   in other words the gaps BETWEEN sessions. Null while a session is
 *                   open, because the span has no end yet.
 */
export async function recomputeDayFor(userId: number, workDate: string): Promise<void> {
  await execute(
    `UPDATE hr_attendance a
        SET a.checked_in_at = (
              SELECT MIN(s.started_at) FROM hr_attendance_sessions s
               WHERE s.attendance_id = a.id),
            a.checked_out_at = (
              SELECT CASE WHEN COUNT(CASE WHEN s.ended_at IS NULL THEN 1 END) > 0
                          THEN NULL ELSE MAX(s.ended_at) END
                FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
            a.worked_minutes = (
              SELECT SUM(s.minutes) FROM hr_attendance_sessions s
               WHERE s.attendance_id = a.id AND s.ended_at IS NOT NULL),
            a.break_minutes = COALESCE((
              SELECT GREATEST(0,
                       TIMESTAMPDIFF(MINUTE, MIN(s.started_at), MAX(s.ended_at))
                       - COALESCE(SUM(s.minutes), 0))
                FROM hr_attendance_sessions s
               WHERE s.attendance_id = a.id
                 AND s.ended_at IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM hr_attendance_sessions o
                                  WHERE o.attendance_id = a.id AND o.ended_at IS NULL)
            ), 0),
            a.early_minutes = CASE
              WHEN a.shift_ends_at IS NULL THEN 0
              ELSE COALESCE((
                SELECT GREATEST(0, TIMESTAMPDIFF(
                         MINUTE,
                         CONVERT_TZ(MAX(s.ended_at), '+00:00', '+05:30'),
                         CAST(CONCAT(a.work_date, ' ', a.shift_ends_at) AS DATETIME)))
                  FROM hr_attendance_sessions s
                 WHERE s.attendance_id = a.id AND s.ended_at IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM hr_attendance_sessions o
                                    WHERE o.attendance_id = a.id AND o.ended_at IS NULL)
              ), 0)
            END
      WHERE a.user_id = ? AND a.work_date = ?`,
    [userId, workDate],
  );

  /*
   * Status, decided after the totals are known.
   *
   * Half day only ever downgrades from 'present': a day already marked 'late' keeps
   * that, because being late is the more useful fact about it and the hours are on the
   * row regardless. Only applied once the day is CLOSED — a half-day flag on somebody
   * two hours into their shift would be wrong and alarming.
   */
  await execute(
    `UPDATE hr_attendance a
       JOIN hr_shifts s ON s.id = a.shift_id
        SET a.status = 'half_day'
      WHERE a.user_id = ? AND a.work_date = ?
        AND a.status = 'present'
        AND a.checked_out_at IS NOT NULL
        AND a.worked_minutes IS NOT NULL
        AND a.worked_minutes < s.half_day_minutes`,
    [userId, workDate],
  );
}

/* -------------------------------------------------------------------------- */
/* Check in                                                                    */
/* -------------------------------------------------------------------------- */

export type PunchInput = {
  coordinate?: { latitude: number; longitude: number; accuracyMetres?: number };
  deviceTime?: string;
};

export type CheckInResult =
  | { ok: true; day: AttendanceDay; alreadyCheckedIn: boolean }
  | { ok: false; verdict: Exclude<GeoVerdict, { ok: true }> };

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * Opens a session.
 *
 * The day row is created on the FIRST check-in and reused by every later one, which is
 * where lateness is computed and the shift snapshotted. Snapshotting matters: a rota
 * edited in March must not make somebody retrospectively late in January.
 *
 * An employee who is already checked in is answered with their current day and a flag
 * rather than an error. That caller may be a retry of a request that actually
 * succeeded — a flaky connection, a double tap — and a failure would have them believe
 * the punch did not register.
 */
export async function checkIn(userId: number, input: PunchInput): Promise<CheckInResult> {
  const assignment = await assignmentFor(userId);
  const verdict = judgeLocation(assignment, input.coordinate);

  if (!verdict.ok) return { ok: false, verdict };

  const open = await openSessionFor(userId);
  if (open) {
    return { ok: true, day: (await todayFor(userId))!, alreadyCheckedIn: true };
  }

  const shift = assignment.shift;

  /*
   * Create the day if this is the first punch of it.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE id = id` is a deliberate no-op on the second
   * and later sessions: the row already holds the first check-in's lateness and shift
   * snapshot, and neither must be recomputed from a 14:00 punch.
   */
  await execute(
    `INSERT INTO hr_attendance
       (user_id, work_date, shift_id, shift_starts_at, shift_ends_at, work_mode,
        source, status, late_minutes)
     VALUES (?, ${LOCAL_TODAY}, ?, ?, ?, ?, 'app', 'present',
             CASE WHEN ? IS NULL THEN 0
                  ELSE GREATEST(0, TIMESTAMPDIFF(
                    MINUTE,
                    ADDTIME(CAST(CONCAT(${LOCAL_TODAY}, ' ', ?) AS DATETIME), SEC_TO_TIME(? * 60)),
                    ${LOCAL_NOW}
                  ))
             END)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      userId,
      shift?.id ?? null,
      shift?.startsAt ?? null,
      shift?.endsAt ?? null,
      assignment.workMode,
      shift?.startsAt ?? null,
      shift?.startsAt ?? null,
      shift?.graceMinutes ?? 0,
    ],
  );

  const day = await queryOne<RowDataPacket & { id: number; work_date: string }>(
    `SELECT id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date FROM hr_attendance
      WHERE user_id = ? AND work_date = ${LOCAL_TODAY} LIMIT 1`,
    [userId],
  );

  try {
    await execute(
      `INSERT INTO hr_attendance_sessions
         (attendance_id, user_id, started_at, in_device_at,
          in_lat, in_lng, in_distance_metres, in_accuracy_metres, in_location_id, source)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, 'app')`,
      [
        day!.id,
        userId,
        input.deviceTime ? new Date(input.deviceTime) : null,
        input.coordinate?.latitude ?? null,
        input.coordinate?.longitude ?? null,
        verdict.distanceMetres,
        input.coordinate?.accuracyMetres === undefined
          ? null
          : Math.round(input.coordinate.accuracyMetres),
        verdict.locationId,
      ],
    );
  } catch (error) {
    /*
     * Lost the race for the one open session — two punches arrived together. The
     * winner's session is the real one, so report success against the day as it now
     * stands rather than failing a request the employee has no way to interpret.
     */
    if (isDuplicateKey(error)) {
      return { ok: true, day: (await todayFor(userId))!, alreadyCheckedIn: true };
    }
    throw error;
  }

  await execute(
    `UPDATE hr_attendance SET status = 'late'
      WHERE user_id = ? AND work_date = ? AND late_minutes > 0 AND status = 'present'`,
    [userId, day!.work_date],
  );

  await recomputeDayFor(userId, day!.work_date);

  logger.info('HR check-in', { userId, geofenced: assignment.geofenced });
  return { ok: true, day: (await todayFor(userId))!, alreadyCheckedIn: false };
}

/* -------------------------------------------------------------------------- */
/* Check out                                                                   */
/* -------------------------------------------------------------------------- */

export type CheckOutResult =
  | { ok: true; day: AttendanceDay; alreadyCheckedOut: boolean }
  | { ok: false; reason: 'not_checked_in' }
  | { ok: false; verdict: Exclude<GeoVerdict, { ok: true }> };

interface OpenSessionRow extends RowDataPacket {
  id: number;
  attendance_id: number;
  work_date: string;
}

async function openSessionFor(userId: number): Promise<OpenSessionRow | null> {
  return queryOne<OpenSessionRow>(
    `SELECT s.id, s.attendance_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date
       FROM hr_attendance_sessions s
       JOIN hr_attendance a ON a.id = s.attendance_id
      WHERE s.user_id = ? AND s.ended_at IS NULL
      LIMIT 1`,
    [userId],
  );
}

/**
 * Closes the open session.
 *
 * The geofence is checked on the way out as well. Skipping it leaves the obvious hole:
 * check in at the office, drive home, check out at six.
 */
export async function checkOut(userId: number, input: PunchInput): Promise<CheckOutResult> {
  const open = await openSessionFor(userId);

  if (!open) {
    /*
     * Nothing open. If the day already has sessions this is a retry of a check-out
     * that worked, so it is reported as success — the same reasoning as a repeated
     * check-in. With no sessions at all, they genuinely never checked in.
     */
    const today = await todayFor(userId);
    if (today && today.completedSessions > 0) {
      return { ok: true, day: today, alreadyCheckedOut: true };
    }
    return { ok: false, reason: 'not_checked_in' };
  }

  const assignment = await assignmentFor(userId);
  const verdict = judgeLocation(assignment, input.coordinate);
  if (!verdict.ok) return { ok: false, verdict };

  await execute(
    `UPDATE hr_attendance_sessions
        SET ended_at = NOW(),
            minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW())),
            out_device_at = ?,
            out_lat = ?, out_lng = ?,
            out_distance_metres = ?, out_accuracy_metres = ?
      WHERE id = ? AND ended_at IS NULL`,
    [
      input.deviceTime ? new Date(input.deviceTime) : null,
      input.coordinate?.latitude ?? null,
      input.coordinate?.longitude ?? null,
      verdict.distanceMetres,
      input.coordinate?.accuracyMetres === undefined
        ? null
        : Math.round(input.coordinate.accuracyMetres),
      open.id,
    ],
  );

  await recomputeDayFor(userId, open.work_date);

  const day = await todayFor(userId);
  logger.info('HR check-out', { userId, workedMinutes: day?.workedMinutes });

  return { ok: true, day: day!, alreadyCheckedOut: false };
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

export type AttendanceSummary = {
  daysPresent: number;
  daysLate: number;
  daysHalf: number;
  totalWorkedMinutes: number;
  averageWorkedMinutes: number;
  totalSessions: number;
};

export async function summaryFor(
  userId: number,
  from: string,
  to: string,
): Promise<AttendanceSummary> {
  const row = await queryOne<
    RowDataPacket & {
      days_present: number;
      days_late: number;
      days_half: number;
      total_worked: number | null;
      counted_days: number;
      total_sessions: number | null;
    }
  >(
    `SELECT
       SUM(a.status IN ('present','late','half_day')) AS days_present,
       SUM(a.status = 'late')                          AS days_late,
       SUM(a.status = 'half_day')                      AS days_half,
       SUM(a.worked_minutes)                           AS total_worked,
       SUM(a.worked_minutes IS NOT NULL)               AS counted_days,
       (SELECT COUNT(*) FROM hr_attendance_sessions s
         JOIN hr_attendance d ON d.id = s.attendance_id
        WHERE d.user_id = ? AND d.work_date BETWEEN ? AND ?
          AND s.ended_at IS NOT NULL)                  AS total_sessions
     FROM hr_attendance a
     WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ?`,
    [userId, from, to, userId, from, to],
  );

  const total = Number(row?.total_worked ?? 0);
  // Averaged over days that actually produced hours, not over every row — a day still
  // in progress would otherwise drag the average down by however early in it we are.
  const counted = Number(row?.counted_days ?? 0);

  return {
    daysPresent: Number(row?.days_present ?? 0),
    daysLate: Number(row?.days_late ?? 0),
    daysHalf: Number(row?.days_half ?? 0),
    totalWorkedMinutes: total,
    averageWorkedMinutes: counted > 0 ? Math.round(total / counted) : 0,
    totalSessions: Number(row?.total_sessions ?? 0),
  };
}
