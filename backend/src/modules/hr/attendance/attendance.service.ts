import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { logger } from '../../../utils/logger';
import { notifyHr } from '../notifications/hrNotifications.repository';
import {
  LOCAL_NOW,
  LOCAL_TODAY,
  PUNCH_FLAGS,
  distanceMetres,
  type AttendanceDay,
  type AttendanceSession,
  type AttendanceStatus,
  type PunchFlag,
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
  /**
   * Set when an APPROVED work-from-home or field-work request covers today. The day's
   * punches are then not fenced, and the day is recorded with that work mode — the
   * request is the permission to be somewhere other than the office.
   */
  dayOverride: 'wfh' | 'field' | null;
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

  if (!row) {
    return { workMode: 'office', location: null, shift: null, geofenced: false, dayOverride: null };
  }

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

  /*
   * An approved wfh / field-work request for today lifts the fence for the day.
   *
   * Read here, in the one function every punch and the /today screen go through, so
   * the app's "you may check in from anywhere today" and the server's acceptance of the
   * punch cannot disagree.
   */
  const override = await queryOne<RowDataPacket & { kind: 'wfh' | 'field' }>(
    `SELECT t.kind
       FROM hr_leave_requests r
       JOIN hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.user_id = ? AND r.status = 'approved' AND t.kind IN ('wfh','field')
        AND ${LOCAL_TODAY} BETWEEN r.start_date AND r.end_date
      ORDER BY r.id DESC
      LIMIT 1`,
    [userId],
  );
  const dayOverride = override?.kind ?? null;

  if (dayOverride) {
    return {
      workMode: dayOverride === 'wfh' ? 'remote' : 'field',
      location,
      shift,
      geofenced: false,
      dayOverride,
    };
  }

  return {
    workMode: row.work_mode,
    location,
    shift,
    geofenced: row.work_mode === 'office' && location !== null && location.isActive,
    dayOverride: null,
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
  /*
   * An office worker with no site is a configuration gap, and it is REFUSED here.
   *
   * An earlier revision only tested `geofenced`, which is false without a site — so the
   * refusal below was unreachable and an unassigned office worker could check in from
   * anywhere; only the app's own button state stood in the way. An approved wfh or
   * field-work day is the exception: that request is the permission to be elsewhere.
   */
  if (assignment.workMode === 'office' && !assignment.dayOverride && !assignment.location) {
    return { ok: false, reason: 'no_site_assigned' };
  }

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
  missing_punch: number;
  flagged: number;
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
         a.source, a.note, a.missing_punch, a.flagged,
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
    missingPunch: Number(row.missing_punch) === 1,
    flagged: Number(row.flagged) === 1,
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
  auto_closed: number;
  in_flags: string;
  out_flags: string;
}

/** A MySQL SET arrives as a comma list; keep only values this code knows. */
export function parseFlags(...values: Array<string | null | undefined>): PunchFlag[] {
  const found = new Set<PunchFlag>();
  for (const value of values) {
    for (const part of (value ?? '').split(',')) {
      if ((PUNCH_FLAGS as readonly string[]).includes(part)) found.add(part as PunchFlag);
    }
  }
  return [...found];
}

function toSession(row: SessionRow): AttendanceSession {
  return {
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: iso(row.ended_at),
    minutes: row.minutes === null ? null : Number(row.minutes),
    source: row.source,
    autoClosed: Number(row.auto_closed) === 1,
    flags: parseFlags(row.in_flags, row.out_flags),
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
    `SELECT id, attendance_id, started_at, ended_at, minutes, source,
            auto_closed, in_flags, out_flags
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

/**
 * The day the attendance screen is about.
 *
 * Normally today's row. But a session that is still OPEN belongs to the day it started
 * on — a night shift that began at 22:00 yesterday is still yesterday's day at 02:00 —
 * and the screen must show that one, or it would offer "Check in" to somebody who is
 * mid-shift. Stale sessions are closed before punches (see `closeStaleSessions`), so an
 * open session from yesterday here is a genuinely running one.
 */
export async function todayFor(userId: number): Promise<AttendanceDay | null> {
  const row = await queryOne<AttendanceRow>(
    `${DAY_SELECT}
      WHERE a.user_id = ?
        AND (a.work_date = ${LOCAL_TODAY}
             OR a.id = (SELECT s.attendance_id FROM hr_attendance_sessions s
                         WHERE s.user_id = ? AND s.ended_at IS NULL LIMIT 1))
      ORDER BY (SELECT COUNT(*) FROM hr_attendance_sessions o
                 WHERE o.attendance_id = a.id AND o.ended_at IS NULL) DESC,
               a.work_date DESC
      LIMIT 1`,
    [userId, userId],
  );
  if (!row) return null;

  const sessions = await sessionsFor([row.id]);
  return toDay(row, sessions.get(row.id) ?? []);
}

/** One employee's day by date, or null when nothing was recorded. */
export async function dayFor(userId: number, workDate: string): Promise<AttendanceDay | null> {
  const row = await queryOne<AttendanceRow>(
    `${DAY_SELECT} WHERE a.user_id = ? AND a.work_date = ? LIMIT 1`,
    [userId, workDate],
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
            a.missing_punch = EXISTS (
              SELECT 1 FROM hr_attendance_sessions s
               WHERE s.attendance_id = a.id AND s.auto_closed = 1),
            a.flagged = EXISTS (
              SELECT 1 FROM hr_attendance_sessions s
               WHERE s.attendance_id = a.id AND (s.in_flags <> '' OR s.out_flags <> '')),
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
  mocked?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Suspicious punches                                                          */
/* -------------------------------------------------------------------------- */

/** A handset clock further than this from the server's is worth a second look. */
const CLOCK_SKEW_LIMIT_MS = 10 * 60_000;

/**
 * A fix coarser than this cannot meaningfully place somebody inside a 150m fence.
 * Above `Balanced` accuracy's usual ~100m, so ordinary indoor fixes are not flagged.
 */
const LOW_ACCURACY_LIMIT_M = 200;

/**
 * What looks wrong about a punch. Flags are evidence for an administrator, never a
 * reason to refuse — see migration 028.
 */
export function punchFlags(input: PunchInput, now: Date = new Date()): PunchFlag[] {
  const flags: PunchFlag[] = [];
  if (input.mocked === true) flags.push('mock_location');
  if (input.deviceTime) {
    const deviceAt = Date.parse(input.deviceTime);
    if (!Number.isNaN(deviceAt) && Math.abs(deviceAt - now.getTime()) > CLOCK_SKEW_LIMIT_MS) {
      flags.push('clock_skew');
    }
  }
  if (
    input.coordinate?.accuracyMetres !== undefined &&
    input.coordinate.accuracyMetres > LOW_ACCURACY_LIMIT_M
  ) {
    flags.push('low_accuracy');
  }
  return flags;
}

/**
 * A new flagged punch reopens the day for review: an administrator who cleared the
 * morning's flag has not seen the evening's.
 */
async function reopenFlagReview(userId: number, workDate: string): Promise<void> {
  await execute(
    `UPDATE hr_attendance
        SET flag_reviewed_at = NULL, flag_reviewed_by = NULL, flag_reviewer_name = NULL,
            flag_review_note = NULL
      WHERE user_id = ? AND work_date = ?`,
    [userId, workDate],
  );
}

/* -------------------------------------------------------------------------- */
/* Missing punches                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How long a session may stay open before it is treated as a forgotten check-out.
 *
 * Long enough for a night shift that crosses midnight (22:00 to 06:00 is eight hours),
 * short enough that yesterday's forgotten session never blocks this morning.
 */
export const MAX_OPEN_SESSION_HOURS = 16;

/**
 * Closes sessions nobody checked out of.
 *
 * WITHOUT THIS, ONE FORGOTTEN CHECK-OUT LOCKED SOMEBODY OUT FOR GOOD: only one open
 * session per person can exist (migration 019), so yesterday's open session made every
 * later check-in a no-op, and checking out today would have credited a day-long session.
 *
 * A stale session is closed at its OWN START — zero minutes — and marked `auto_closed`.
 * Not at the shift end: that would credit hours nobody recorded. The day is flagged as
 * a missing punch, the employee is told, and a regularisation puts the real times back.
 *
 * Stale means: on a day before today, AND open longer than MAX_OPEN_SESSION_HOURS.
 * Called before every punch for that employee, and for everyone by the scheduler.
 */
export async function closeStaleSessions(userId: number | null): Promise<number> {
  const stale = await query<RowDataPacket & { id: number; user_id: number; work_date: string }>(
    `SELECT s.id, s.user_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date
       FROM hr_attendance_sessions s
       JOIN hr_attendance a ON a.id = s.attendance_id
      WHERE s.ended_at IS NULL
        AND a.work_date < ${LOCAL_TODAY}
        AND s.started_at < NOW() - INTERVAL ${MAX_OPEN_SESSION_HOURS} HOUR
        ${userId === null ? '' : 'AND s.user_id = ?'}
      LIMIT 500`,
    userId === null ? [] : [userId],
  );

  let closed = 0;
  const days = new Map<string, { userId: number; workDate: string }>();

  for (const session of stale) {
    const result = await execute(
      `UPDATE hr_attendance_sessions
          SET ended_at = started_at, minutes = 0, auto_closed = 1
        WHERE id = ? AND ended_at IS NULL`,
      [session.id],
    );
    if (result.affectedRows === 0) continue;
    closed += 1;
    days.set(`${session.user_id}:${session.work_date}`, {
      userId: session.user_id,
      workDate: session.work_date,
    });
  }

  for (const { userId: owner, workDate } of days.values()) {
    await recomputeDayFor(owner, workDate);
    await notifyHr({
      userIds: [owner],
      kind: 'missing_punch',
      title: 'Missing check-out',
      body: `You did not check out on ${workDate}. Request a correction so the day shows your real hours.`,
      entityType: 'attendance_day',
      dedupeKey: `missing_punch:${workDate}`,
    });
  }

  if (closed > 0) logger.info('Closed stale HR sessions', { closed, userId });
  return closed;
}

/**
 * The most recent day, within the correction window, that still has a missing punch
 * and no correction waiting — the one the app should prompt about.
 */
export async function missingPunchFor(userId: number): Promise<{ workDate: string } | null> {
  const row = await queryOne<RowDataPacket & { work_date: string }>(
    `SELECT DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date
       FROM hr_attendance a
      WHERE a.user_id = ? AND a.missing_punch = 1
        AND a.work_date >= DATE_SUB(${LOCAL_TODAY}, INTERVAL 30 DAY)
        AND NOT EXISTS (
          SELECT 1 FROM hr_regularisations r
           WHERE r.user_id = a.user_id AND r.work_date = a.work_date AND r.status = 'pending')
      ORDER BY a.work_date DESC
      LIMIT 1`,
    [userId],
  );
  return row ? { workDate: row.work_date } : null;
}

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
  // Yesterday's forgotten check-out must not block today — see closeStaleSessions.
  await closeStaleSessions(userId);

  const assignment = await assignmentFor(userId);
  const verdict = judgeLocation(assignment, input.coordinate);

  if (!verdict.ok) return { ok: false, verdict };

  const open = await openSessionFor(userId);
  if (open) {
    return {
      ok: true,
      day: (await dayFor(userId, open.work_date)) ?? (await todayFor(userId))!,
      alreadyCheckedIn: true,
    };
  }

  const flags = punchFlags(input);

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
          in_lat, in_lng, in_distance_metres, in_accuracy_metres, in_location_id, source,
          in_flags)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, 'app', ?)`,
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
        flags.join(','),
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

  if (flags.length > 0) await reopenFlagReview(userId, day!.work_date);
  await recomputeDayFor(userId, day!.work_date);

  logger.info('HR check-in', { userId, geofenced: assignment.geofenced, flags });
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
  /*
   * A session left open from a previous day is a missing punch, not something to close
   * now: checking out at 09:00 today would credit a day-long session. It is closed as a
   * missing punch and the employee is told they are not checked in.
   */
  await closeStaleSessions(userId);

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

  const flags = punchFlags(input);

  await execute(
    `UPDATE hr_attendance_sessions
        SET ended_at = NOW(),
            minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW())),
            out_device_at = ?,
            out_lat = ?, out_lng = ?,
            out_distance_metres = ?, out_accuracy_metres = ?,
            out_flags = ?
      WHERE id = ? AND ended_at IS NULL`,
    [
      input.deviceTime ? new Date(input.deviceTime) : null,
      input.coordinate?.latitude ?? null,
      input.coordinate?.longitude ?? null,
      verdict.distanceMetres,
      input.coordinate?.accuracyMetres === undefined
        ? null
        : Math.round(input.coordinate.accuracyMetres),
      flags.join(','),
      open.id,
    ],
  );

  if (flags.length > 0) await reopenFlagReview(userId, open.work_date);
  await recomputeDayFor(userId, open.work_date);

  const day = await dayFor(userId, open.work_date);
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
