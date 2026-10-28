import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import {
  execute,
  query,
  queryOne,
  withTransaction,
  type RowDataPacket,
} from '../../../db/pool';
import { badRequest, notFound, validationFailed } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { calendarForUsers, companyToday, isIsoDate } from '../calendar/calendar.service';
import { pageQuerySchema } from '../hr.schema';
import { WEEKDAYS, parseWeekdays, type Weekday } from '../settings/hrSettings';
import {
  COMPANY_UTC_OFFSET,
  REGULARISATION_STATUSES,
  assignmentSchema,
  shiftSchema,
  workLocationSchema,
  type Shift,
  type WorkLocation,
} from './attendance.schema';
import { dayFor, parseFlags, recomputeDayFor } from './attendance.service';
import { ensureDaysJudged, rejudgeShiftDays } from './dayJudge';
import { REGISTER_STATUS_FILTERS, exceptionsWhere, registerQuery } from './register.service';
import {
  approve as approveRegularisation,
  findById as findRegularisation,
  listQueue,
  pendingCount,
  reject as rejectRegularisation,
} from './regularisation.service';

/**
 * Attendance administration, mounted under `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR, exactly like the rest of the HR admin surface —
 * see the note at the top of `hrAdmin.routes.ts` for why that direction of access is
 * not a hole in the product separation.
 *
 * Kept in its own file rather than appended to `hrAdmin.routes.ts` because attendance
 * is a module with its own vocabulary; mounting both routers at the same prefix in
 * `app.ts` is what keeps the URL space tidy without putting four subjects in one file.
 */
export const hrAttendanceAdminRouter = Router();

hrAttendanceAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/** Minimum role plus CSRF for a cookie session. Same chain the other admin routers use. */
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

/* -------------------------------------------------------------------------- */
/* Work locations                                                              */
/* -------------------------------------------------------------------------- */

interface LocationRow extends RowDataPacket {
  id: number;
  name: string;
  address: string | null;
  latitude: string;
  longitude: string;
  radius_metres: number;
  is_active: number;
}

/**
 * Coordinates are cast to Number on the way out.
 *
 * The driver returns DECIMAL as a STRING, deliberately, so that a value too precise for
 * a float is not silently mangled. A latitude is well within float range, and shipping
 * it as a string would have every client doing its own parsing — one of which would
 * forget and concatenate.
 */
function toLocation(row: LocationRow): WorkLocation {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMetres: Number(row.radius_metres),
    isActive: row.is_active === 1,
  };
}

hrAttendanceAdminRouter.get(
  '/locations',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    const rows = await query<LocationRow>(
      `SELECT id, name, address, latitude, longitude, radius_metres, is_active
         FROM hr_work_locations ORDER BY is_active DESC, name ASC`,
    );
    response.json({ success: true, items: rows.map(toLocation) });
  }),
);

hrAttendanceAdminRouter.post(
  '/locations',
  ...write(),
  validateBody(workLocationSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof workLocationSchema>;

    const existing = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM hr_work_locations WHERE name = ? LIMIT 1',
      [input.name],
    );
    if (existing) throw badRequest('A site with that name already exists.');

    const result = await execute(
      `INSERT INTO hr_work_locations (name, address, latitude, longitude, radius_metres, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.address ?? null,
        input.latitude,
        input.longitude,
        input.radiusMetres,
        input.isActive === false ? 0 : 1,
      ],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_location_created',
      entityType: 'hr_work_location',
      entityId: result.insertId,
      summary: `Created work location ${input.name}`,
      meta: { latitude: input.latitude, longitude: input.longitude, radius: input.radiusMetres },
      ipAddress: clientIp(request),
    });

    const row = await queryOne<LocationRow>(
      `SELECT id, name, address, latitude, longitude, radius_metres, is_active
         FROM hr_work_locations WHERE id = ?`,
      [result.insertId],
    );
    response.status(201).json({ success: true, location: toLocation(row!) });
  }),
);

hrAttendanceAdminRouter.patch(
  '/locations/:id',
  ...write(),
  validateBody(workLocationSchema.partial()),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as Partial<z.infer<typeof workLocationSchema>>;

    const current = await queryOne<LocationRow>(
      `SELECT id, name, address, latitude, longitude, radius_metres, is_active
         FROM hr_work_locations WHERE id = ?`,
      [id],
    );
    if (!current) throw notFound('Work location not found.');

    /*
     * Every field is COALESCEd against its current value, so a partial body changes
     * only what it names. The alternative — building the SET clause from present keys —
     * is where a typo silently nulls a coordinate.
     */
    await execute(
      `UPDATE hr_work_locations
          SET name = COALESCE(?, name),
              address = COALESCE(?, address),
              latitude = COALESCE(?, latitude),
              longitude = COALESCE(?, longitude),
              radius_metres = COALESCE(?, radius_metres),
              is_active = COALESCE(?, is_active)
        WHERE id = ?`,
      [
        input.name ?? null,
        input.address ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.radiusMetres ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        id,
      ],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_location_updated',
      entityType: 'hr_work_location',
      entityId: id,
      summary: `Updated work location ${current.name}`,
      ipAddress: clientIp(request),
    });

    const row = await queryOne<LocationRow>(
      `SELECT id, name, address, latitude, longitude, radius_metres, is_active
         FROM hr_work_locations WHERE id = ?`,
      [id],
    );
    response.json({ success: true, location: toLocation(row!) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Shifts                                                                      */
/* -------------------------------------------------------------------------- */

interface ShiftRow extends RowDataPacket {
  id: number;
  name: string;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  grace_minutes: number;
  half_day_minutes: number;
  absent_minutes: number;
  /** A MySQL SET, read as its comma list ('sat,sun'), or '' for no weekly off. */
  weekly_off_days: string | null;
  is_active: number;
}

function toShift(row: ShiftRow): Shift {
  return {
    id: row.id,
    name: row.name,
    startsAt: String(row.starts_at).slice(0, 5),
    endsAt: String(row.ends_at).slice(0, 5),
    breakMinutes: Number(row.break_minutes),
    graceMinutes: Number(row.grace_minutes),
    halfDayMinutes: Number(row.half_day_minutes),
    absentMinutes: Number(row.absent_minutes),
    isActive: row.is_active === 1,
    // Fallback [] rather than the company default: a shift row ALWAYS has the column
    // (NOT NULL, default 'sun'), so an empty value means the shift genuinely has none.
    // Re-ordered Sunday-first so the response does not depend on how MySQL lists a SET.
    weeklyOffDays: sortWeekdays(parseWeekdays(row.weekly_off_days ?? '', [])),
  };
}

function sortWeekdays(days: Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

const SHIFT_COLUMNS = `id, name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, absent_minutes, weekly_off_days, is_active`;

/**
 * The two thresholds must be in order: the half-day minimum (absent under) cannot exceed
 * the full-day minimum (half day under), or no day could ever be a half day and a day in
 * between would be judged by whichever rule SQL reached first. Equal is allowed — a shift
 * with no half days at all.
 */
function checkThresholds(fullDayMinutes: number, absentMinutes: number) {
  if (absentMinutes > fullDayMinutes) {
    throw validationFailed({
      absentMinutes: 'The half-day minimum must not be more than the full-day minimum.',
    });
  }
}

hrAttendanceAdminRouter.get(
  '/shifts',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    const rows = await query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM hr_shifts ORDER BY is_active DESC, starts_at ASC`,
    );
    response.json({ success: true, items: rows.map(toShift) });
  }),
);

hrAttendanceAdminRouter.post(
  '/shifts',
  ...write(),
  validateBody(shiftSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof shiftSchema>;
    checkThresholds(input.halfDayMinutes, input.absentMinutes ?? 0);

    const existing = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM hr_shifts WHERE name = ? LIMIT 1',
      [input.name],
    );
    if (existing) throw badRequest('A shift with that name already exists.');

    /*
     * Weekly offs default to Sunday when not given — the column's own default, written
     * explicitly so a shift's rest days never depend on a DDL default somebody may change.
     */
    const weeklyOffDays = input.weeklyOffDays ?? ['sun'];

    const result = await execute(
      `INSERT INTO hr_shifts
         (name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes,
          absent_minutes, weekly_off_days, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        `${input.startsAt}:00`,
        `${input.endsAt}:00`,
        input.breakMinutes,
        input.graceMinutes,
        input.halfDayMinutes,
        input.absentMinutes ?? 0,
        weeklyOffDays.join(','),
        input.isActive === false ? 0 : 1,
      ],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_shift_created',
      entityType: 'hr_shift',
      entityId: result.insertId,
      summary: `Created shift ${input.name} (${input.startsAt}–${input.endsAt})`,
      meta: { weeklyOffDays },
      ipAddress: clientIp(request),
    });

    const row = await queryOne<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM hr_shifts WHERE id = ?`, [
      result.insertId,
    ]);
    response.status(201).json({ success: true, shift: toShift(row!) });
  }),
);

hrAttendanceAdminRouter.patch(
  '/shifts/:id',
  ...write(),
  validateBody(shiftSchema.partial()),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as Partial<z.infer<typeof shiftSchema>>;

    const current = await queryOne<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM hr_shifts WHERE id = ?`,
      [id],
    );
    if (!current) throw notFound('Shift not found.');

    // Either threshold may be sent alone; the pair is checked as it will be stored.
    const fullDay = input.halfDayMinutes ?? Number(current.half_day_minutes);
    const absentUnder = input.absentMinutes ?? Number(current.absent_minutes);
    checkThresholds(fullDay, absentUnder);
    const thresholdsChanged =
      fullDay !== Number(current.half_day_minutes) || absentUnder !== Number(current.absent_minutes);

    /*
     * `weekly_off_days` follows the same COALESCE rule, and an EMPTY list still writes:
     * '' is not NULL, so "no weekly off" replaces the old value rather than being taken
     * for "leave it alone".
     */
    await execute(
      `UPDATE hr_shifts
          SET name = COALESCE(?, name),
              starts_at = COALESCE(?, starts_at),
              ends_at = COALESCE(?, ends_at),
              break_minutes = COALESCE(?, break_minutes),
              grace_minutes = COALESCE(?, grace_minutes),
              half_day_minutes = COALESCE(?, half_day_minutes),
              absent_minutes = COALESCE(?, absent_minutes),
              weekly_off_days = COALESCE(?, weekly_off_days),
              is_active = COALESCE(?, is_active)
        WHERE id = ?`,
      [
        input.name ?? null,
        input.startsAt ? `${input.startsAt}:00` : null,
        input.endsAt ? `${input.endsAt}:00` : null,
        input.breakMinutes ?? null,
        input.graceMinutes ?? null,
        input.halfDayMinutes ?? null,
        input.absentMinutes ?? null,
        input.weeklyOffDays === undefined ? null : input.weeklyOffDays.join(','),
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        id,
      ],
    );

    // New thresholds reach the finished days already worked on this shift, not only new ones.
    const rejudged = thresholdsChanged ? await rejudgeShiftDays(id) : 0;

    const meta: Record<string, unknown> = {};
    if (input.weeklyOffDays !== undefined) {
      meta.weeklyOffDays = {
        before: sortWeekdays(parseWeekdays(current.weekly_off_days ?? '', [])),
        after: input.weeklyOffDays,
      };
    }
    if (thresholdsChanged) {
      meta.thresholds = {
        before: { fullDayMinutes: Number(current.half_day_minutes), absentMinutes: Number(current.absent_minutes) },
        after: { fullDayMinutes: fullDay, absentMinutes: absentUnder },
      };
      meta.rejudgedDays = rejudged;
    }

    await recordAudit({
      actor: request.actor!,
      action: 'hr_shift_updated',
      entityType: 'hr_shift',
      entityId: id,
      summary: thresholdsChanged
        ? `Updated shift ${current.name}; ${rejudged} finished day${rejudged === 1 ? '' : 's'} re-judged`
        : `Updated shift ${current.name}`,
      meta: Object.keys(meta).length ? meta : null,
      ipAddress: clientIp(request),
    });

    const row = await queryOne<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM hr_shifts WHERE id = ?`, [
      id,
    ]);
    response.json({ success: true, shift: toShift(row!), rejudged });
  }),
);

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assigns an employee a site, a shift and a way of working.
 *
 * An office worker with no site cannot check in at all — the service refuses with
 * `no_site_assigned` rather than waving them through — so this endpoint rejects that
 * combination up front, where the administrator can see it, instead of leaving the
 * employee to discover it at 09:00.
 */
hrAttendanceAdminRouter.patch(
  '/users/:id/assignment',
  ...write(),
  validateBody(assignmentSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as z.infer<typeof assignmentSchema>;

    // A deleted employee has nothing left to assign: they cannot sign in to use it.
    const employee = await queryOne<RowDataPacket & { name: string; employee_code: string }>(
      'SELECT name, employee_code FROM hr_users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [id],
    );
    if (!employee) throw notFound('Employee not found.');

    if (input.workMode === 'office' && !input.workLocationId) {
      throw badRequest(
        'An office worker needs a work location, otherwise they cannot check in. Pick a site, or set them to remote or field.',
      );
    }

    if (input.workLocationId) {
      const site = await queryOne<RowDataPacket & { id: number }>(
        'SELECT id FROM hr_work_locations WHERE id = ? LIMIT 1',
        [input.workLocationId],
      );
      if (!site) throw badRequest('That work location does not exist.');
    }

    if (input.shiftId) {
      const shift = await queryOne<RowDataPacket & { id: number }>(
        'SELECT id FROM hr_shifts WHERE id = ? LIMIT 1',
        [input.shiftId],
      );
      if (!shift) throw badRequest('That shift does not exist.');
    }

    await execute(
      `UPDATE hr_users SET work_location_id = ?, shift_id = ?, work_mode = ? WHERE id = ?`,
      [input.workLocationId ?? null, input.shiftId ?? null, input.workMode, id],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_assignment_updated',
      entityType: 'hr_user',
      entityId: id,
      summary: `Set ${employee.name} (${employee.employee_code}) to ${input.workMode}`,
      meta: { workLocationId: input.workLocationId, shiftId: input.shiftId },
      ipAddress: clientIp(request),
    });

    response.json({ success: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Attendance register                                                         */
/* -------------------------------------------------------------------------- */

/** A query-string value where '' means "not filtering" (a form's "All" option). */
const blankAsUndefined = (value: unknown) => (value === '' ? undefined : value);
const optionalQueryId = z.preprocess(blankAsUndefined, z.coerce.number().int().positive().optional());
const optionalQueryDate = z.preprocess(
  blankAsUndefined,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(isIsoDate, 'That is not a real date.').optional(),
);

const registerQuerySchema = pageQuerySchema.extend({
  /** Defaults to the company's today. */
  date: optionalQueryDate,
  userId: optionalQueryId,
  q: z.preprocess(blankAsUndefined, z.string().trim().max(120).optional()),
  departmentId: optionalQueryId,
  /** The employee's ASSIGNED site — not where a punch happened to be made. */
  locationId: optionalQueryId,
  status: z.preprocess(blankAsUndefined, z.enum(REGISTER_STATUS_FILTERS).optional()),
});

interface RegisterRow extends RowDataPacket {
  user_id: number;
  name: string;
  employee_code: string;
  work_mode: string;
  department_name: string | null;
  designation_name: string | null;
  work_date: string | null;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  worked_minutes: number | null;
  break_minutes: number | null;
  late_minutes: number | null;
  status: string | null;
  source: string | null;
  missing_punch: number | null;
  flagged: number | null;
  location_name: string | null;
  check_in_distance_metres: number | null;
  session_count: number | null;
  open_count: number | null;
}

/**
 * The day's register: every approved, active employee, present or not — a page at a time.
 *
 * A LEFT JOIN from `hr_users`, not a SELECT from `hr_attendance`. Listing only the
 * attendance rows would answer "who came in" while silently omitting the question the
 * register exists to answer, which is who did not.
 *
 * TODAY IS IN PROGRESS. Read for today, `dayStatus` says where each person is — checked
 * in, checked out, or yet to check in — rather than a verdict: nobody is absent, half day
 * or late-and-done until the day is over and the nightly pass has judged it
 * (`dayJudge.ts`). Leave, holidays and weekly offs still take precedence. A past date
 * shows its verdict; a future one stays `upcoming`.
 */
hrAttendanceAdminRouter.get(
  '/attendance',
  requireRole('supervisor'),
  validateQuery(registerQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof registerQuerySchema>;

    const date = filters.date ?? companyToday();

    // The status filter reads the stored verdicts, so days that ended get theirs first.
    await ensureDaysJudged();
    const { from, params } = await registerQuery({
      date,
      userId: filters.userId,
      q: filters.q,
      departmentId: filters.departmentId,
      locationId: filters.locationId,
      status: filters.status,
    });

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total ${from}`,
      params,
    );
    const total = Number(countRow?.total ?? 0);

    // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
    const rows = await query<RegisterRow>(
      `SELECT u.id AS user_id, u.name, u.employee_code, u.work_mode,
              d.name AS department_name, g.name AS designation_name,
              DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
              a.checked_in_at, a.checked_out_at, a.worked_minutes, a.break_minutes,
              a.late_minutes, a.status, a.source, a.missing_punch, a.flagged,
              l.name AS location_name, a.check_in_distance_metres,
              (SELECT COUNT(*) FROM hr_attendance_sessions ss
                WHERE ss.attendance_id = a.id AND ss.ended_at IS NOT NULL) AS session_count,
              (SELECT COUNT(*) FROM hr_attendance_sessions ss
                WHERE ss.attendance_id = a.id AND ss.ended_at IS NULL)     AS open_count
         ${from}
        ORDER BY (a.checked_in_at IS NULL), u.name ASC, u.id ASC
        LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
      params,
    );

    // The calendar for exactly this page's people — one batch, five queries.
    const calendars = await calendarForUsers(
      rows.map((row) => row.user_id),
      date,
      date,
    );

    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

    response.json({
      success: true,
      date,
      items: rows.map((row) => {
        const day = calendars.get(row.user_id)?.[0] ?? null;
        return {
          userId: row.user_id,
          name: row.name,
          employeeCode: row.employee_code,
          workMode: row.work_mode,
          departmentName: row.department_name,
          designationName: row.designation_name,
          workDate: row.work_date,
          checkedInAt: iso(row.checked_in_at),
          checkedOutAt: iso(row.checked_out_at),
          workedMinutes: row.worked_minutes,
          breakMinutes: row.break_minutes,
          lateMinutes: row.late_minutes,
          // No attendance row at all means absent, and the register says so rather than
          // leaving a blank the reader has to interpret. `dayStatus` is the refined
          // answer that knows about leave, holidays and weekly offs.
          status: row.status ?? 'absent',
          dayStatus: day?.status ?? null,
          source: row.source,
          missingPunch: Number(row.missing_punch ?? 0) === 1,
          flagged: Number(row.flagged ?? 0) === 1,
          /** Approved leave (or work-from-home / field work) covering the date. */
          leaveTypeName: day?.leave?.typeName ?? null,
          locationName: row.location_name,
          distanceMetres: row.check_in_distance_metres,
          completedSessions: Number(row.session_count ?? 0),
          /* True while they are mid-session — the register's "in right now" column. */
          currentlyIn: Number(row.open_count ?? 0) > 0,
        };
      }),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Admin day correction                                                        */
/* -------------------------------------------------------------------------- */

const wallClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

/**
 * A corrected day: the sessions it should have had, as company wall-clock times on that
 * date, plus why. Ordering rules are checked here so each message lands on the session
 * that broke them.
 */
const correctionSchema = z
  .object({
    sessions: z
      .array(
        z.object({
          startAt: wallClock,
          /* Null only for a session still running — today's last one. */
          endAt: z
            .union([wallClock, z.null()])
            .optional()
            .transform((value) => value ?? null),
        }),
      )
      .min(1, 'Give at least one session.')
      .max(10, 'A day can hold at most 10 sessions.'),
    reason: z
      .string({ required_error: 'Say why this day is being corrected.' })
      .trim()
      .min(5, 'Say why this day is being corrected.')
      .max(500, 'Keep it to 500 characters or fewer.'),
  })
  .superRefine((value, context) => {
    const ordered = value.sessions
      .map((session, index) => ({ ...session, index }))
      .sort((left, right) => left.startAt.localeCompare(right.startAt));

    ordered.forEach((session, position) => {
      if (session.endAt !== null && session.endAt <= session.startAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', session.index, 'endAt'],
          message: 'The check-out must be after the check-in.',
        });
      }
      if (session.endAt === null && position < ordered.length - 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', session.index, 'endAt'],
          message: 'Only the last session of the day can still be running.',
        });
      }
      const previous = ordered[position - 1];
      if (previous && (previous.endAt === null || session.startAt < previous.endAt)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', session.index, 'startAt'],
          message: 'Sessions cannot overlap.',
        });
      }
    });
  });

/**
 * A company wall-clock time on a date, as the UTC instant it names.
 *
 * Built from the fixed offset, so it is the same conversion regularisation does with
 * `CONVERT_TZ(..., '+05:30', '+00:00')` in SQL — done here because the route has to
 * compare the instants with "now" before writing anything. The Date binds through the
 * UTC-pinned pool as the UTC wall clock, like every other DATETIME in the module.
 */
function companyInstant(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00${COMPANY_UTC_OFFSET}`);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/** A session as the audit trail records it: compact, and in the shape the API returns. */
function auditSessions(day: Awaited<ReturnType<typeof dayFor>>) {
  return (day?.sessions ?? []).map((session) => ({
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    minutes: session.minutes,
    source: session.source,
  }));
}

/**
 * Corrects one employee's day directly. ADMIN ONLY.
 *
 * The day's sessions are REPLACED, not edited: a correction is the administrator stating
 * what the day was, and leaving any original session alongside the corrected ones would
 * double-count it. Every session written is `source = 'admin'` and the day is marked
 * `source = 'admin'` with the reason as its note, so a corrected day stays
 * distinguishable from a punched one forever; the audit row keeps the sessions it
 * replaced.
 *
 * Lateness is re-derived from the corrected first check-in against the day's shift
 * snapshot — otherwise a day corrected to 09:00 would keep the "late" a 10:30 punch
 * earned. The totals are re-derived from the sessions by `recomputeDayFor`, the same
 * roll-up every punch goes through.
 */
hrAttendanceAdminRouter.put(
  '/attendance/:userId/:date',
  ...write(),
  validateBody(correctionSchema),
  asyncHandler(async (request, response) => {
    const userId = parseId(request.params.userId);
    const date = String(request.params.date ?? '');
    if (!isIsoDate(date)) {
      throw badRequest('Use a date in the form YYYY-MM-DD.', { date: 'Use YYYY-MM-DD.' });
    }
    const input = request.body as z.infer<typeof correctionSchema>;

    const employee = await queryOne<
      RowDataPacket & { id: number; name: string; employee_code: string; approval_status: string }
    >('SELECT id, name, employee_code, approval_status FROM hr_users WHERE id = ? LIMIT 1', [userId]);
    if (!employee) throw notFound('Employee not found.');
    if (employee.approval_status !== 'approved') {
      throw badRequest('Only an approved employee has attendance to correct.');
    }

    const today = companyToday();
    if (date > today) {
      throw badRequest('You cannot correct a day that has not happened yet.', {
        date: 'You cannot correct a day that has not happened yet.',
      });
    }

    const sessions = input.sessions
      .map((session) => ({
        localStart: session.startAt,
        startAt: companyInstant(date, session.startAt),
        endAt: session.endAt ? companyInstant(date, session.endAt) : null,
      }))
      .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());

    /*
     * A running session on a past day is a forgotten check-out by definition — the
     * stale-session sweep would close it as a missing punch at once. Ask for the time.
     */
    if (date < today && sessions.some((session) => session.endAt === null)) {
      throw badRequest('A past day cannot have a session still running. Give the check-out time.', {
        sessions: 'A past day cannot have a session still running. Give the check-out time.',
      });
    }
    const now = Date.now();
    if (
      sessions.some(
        (session) => session.startAt.getTime() > now || (session.endAt !== null && session.endAt.getTime() > now),
      )
    ) {
      throw badRequest('A correction cannot record a time that has not happened yet.', {
        sessions: 'A correction cannot record a time that has not happened yet.',
      });
    }

    const before = await dayFor(userId, date);

    let attendanceId: number;
    try {
      attendanceId = await withTransaction(async (connection) => {
        /*
         * Upsert the day. A new day snapshots the employee's CURRENT shift and work mode,
         * as a first check-in would; an existing day keeps the snapshot it was punched
         * against.
         */
        await connection.execute(
          `INSERT INTO hr_attendance
             (user_id, work_date, shift_id, shift_starts_at, shift_ends_at, work_mode,
              source, status, note)
           SELECT u.id, ?, u.shift_id, s.starts_at, s.ends_at, u.work_mode, 'admin', 'present', ?
             FROM hr_users u
             LEFT JOIN hr_shifts s ON s.id = u.shift_id
            WHERE u.id = ?
           ON DUPLICATE KEY UPDATE source = 'admin', note = VALUES(note)`,
          [date, input.reason, userId],
        );

        const [dayRows] = await connection.execute<(RowDataPacket & { id: number })[]>(
          'SELECT id FROM hr_attendance WHERE user_id = ? AND work_date = ? FOR UPDATE',
          [userId, date],
        );
        const dayId = Number(dayRows[0]?.id);

        await connection.execute('DELETE FROM hr_attendance_sessions WHERE attendance_id = ?', [dayId]);

        for (const session of sessions) {
          await connection.execute(
            `INSERT INTO hr_attendance_sessions
               (attendance_id, user_id, started_at, ended_at, minutes, source)
             VALUES (?, ?, ?, ?, ?, 'admin')`,
            [
              dayId,
              userId,
              session.startAt,
              session.endAt,
              session.endAt === null
                ? null
                : Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000),
            ],
          );
        }

        // Lateness against the day's snapshot, from the corrected first check-in (local).
        await connection.execute(
          `UPDATE hr_attendance a
             LEFT JOIN hr_shifts sh ON sh.id = a.shift_id
              SET a.late_minutes = CASE
                    WHEN a.shift_starts_at IS NULL THEN 0
                    ELSE GREATEST(0, TIMESTAMPDIFF(
                           MINUTE,
                           ADDTIME(CAST(CONCAT(a.work_date, ' ', a.shift_starts_at) AS DATETIME),
                                   SEC_TO_TIME(COALESCE(sh.grace_minutes, 0) * 60)),
                           CAST(? AS DATETIME)))
                  END
            WHERE a.id = ?`,
          [`${date} ${sessions[0]!.localStart}:00`, dayId],
        );
        await connection.execute(
          `UPDATE hr_attendance
              SET status = CASE WHEN late_minutes > 0 THEN 'late' ELSE 'present' END
            WHERE id = ?`,
          [dayId],
        );

        return dayId;
      });
    } catch (error) {
      /*
       * Only an OPEN session can collide (one open session per person, migration 019):
       * the employee has one running on a different day, which this day's correction
       * cannot replace.
       */
      if (isDuplicateKey(error)) {
        throw badRequest(
          `${employee.name} has a session still running on another day. Correct that day first.`,
        );
      }
      throw error;
    }

    // The roll-up (totals, missing punch, flags, half day) from the sessions just written.
    await recomputeDayFor(userId, date);
    const after = await dayFor(userId, date);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_attendance_corrected',
      entityType: 'hr_attendance',
      entityId: attendanceId,
      summary: `Corrected attendance for ${employee.name} (${employee.employee_code}) on ${date}`,
      meta: {
        userId,
        workDate: date,
        reason: input.reason,
        before: { workedMinutes: before?.workedMinutes ?? null, status: before?.status ?? null, sessions: auditSessions(before) },
        after: { workedMinutes: after?.workedMinutes ?? null, status: after?.status ?? null, sessions: auditSessions(after) },
      },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, day: after });
  }),
);

/* -------------------------------------------------------------------------- */
/* Exceptions: missing punches and flagged punches                             */
/* -------------------------------------------------------------------------- */

const exceptionsQuerySchema = pageQuerySchema.extend({
  /** Absent: either kind. */
  type: z.preprocess(blankAsUndefined, z.enum(['missing_punch', 'flagged']).optional()),
  /** Absent: both. */
  reviewed: z.preprocess(blankAsUndefined, z.enum(['true', 'false']).optional()),
  from: optionalQueryDate,
  to: optionalQueryDate,
  userId: optionalQueryId,
});

interface ExceptionRow extends RowDataPacket {
  id: number;
  user_id: number;
  employee_name: string;
  employee_code: string;
  work_date: string;
  status: string;
  work_mode: string;
  source: string;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  worked_minutes: number | null;
  missing_punch: number;
  flagged: number;
  flag_reviewed_by: number | null;
  flag_reviewer_name: string | null;
  flag_reviewed_at: Date | string | null;
  flag_review_note: string | null;
}

interface ExceptionSessionRow extends RowDataPacket {
  id: number;
  attendance_id: number;
  started_at: Date | string;
  ended_at: Date | string | null;
  minutes: number | null;
  source: string;
  auto_closed: number;
  in_flags: string;
  out_flags: string;
  in_device_at: Date | string | null;
  out_device_at: Date | string | null;
  in_lat: string | null;
  in_lng: string | null;
  out_lat: string | null;
  out_lng: string | null;
  in_distance_metres: number | null;
  out_distance_metres: number | null;
  in_accuracy_metres: number | null;
  out_accuracy_metres: number | null;
}

const EXCEPTION_SELECT = `
  SELECT a.id, a.user_id, u.name AS employee_name, u.employee_code,
         DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
         a.status, a.work_mode, a.source, a.checked_in_at, a.checked_out_at, a.worked_minutes,
         a.missing_punch, a.flagged, a.flag_reviewed_by, a.flag_reviewer_name, a.flag_reviewed_at, a.flag_review_note
    FROM hr_attendance a
    JOIN hr_users u ON u.id = a.user_id
`;

/**
 * Exception days with their sessions — the evidence a reviewer needs on one screen:
 * what each punch was flagged for, how far from the site and how accurate the fix was,
 * and what the handset's own clock said. One sessions query for the whole page.
 */
async function toExceptions(rows: ExceptionRow[]) {
  const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
  const coordinate = (v: string | null) => (v === null ? null : Number(v));
  const metres = (v: number | null) => (v === null ? null : Number(v));

  const ids = rows.map((row) => Number(row.id));
  const sessions =
    ids.length === 0
      ? []
      : await query<ExceptionSessionRow>(
          // Ids from rows just read: integers by construction.
          `SELECT id, attendance_id, started_at, ended_at, minutes, source, auto_closed,
                  in_flags, out_flags, in_device_at, out_device_at,
                  in_lat, in_lng, out_lat, out_lng,
                  in_distance_metres, out_distance_metres, in_accuracy_metres, out_accuracy_metres
             FROM hr_attendance_sessions
            WHERE attendance_id IN (${ids.join(',')})
            ORDER BY started_at ASC, id ASC`,
        );

  return rows.map((row) => ({
    attendanceId: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    workDate: row.work_date,
    status: row.status,
    workMode: row.work_mode,
    source: row.source,
    checkedInAt: iso(row.checked_in_at),
    checkedOutAt: iso(row.checked_out_at),
    workedMinutes: row.worked_minutes === null ? null : Number(row.worked_minutes),
    missingPunch: Number(row.missing_punch) === 1,
    flagged: Number(row.flagged) === 1,
    reviewed: row.flag_reviewed_at !== null,
    /*
     * Who reviewed is an admin-portal account id. The name is not stored on the day (the
     * HR module never reads the telecalling account tables); the audit row for the
     * review carries it.
     */
    review: row.flag_reviewed_at
      ? {
          reviewedAt: iso(row.flag_reviewed_at),
          reviewedBy: row.flag_reviewed_by,
          reviewerName: row.flag_reviewer_name,
          note: row.flag_review_note,
        }
      : null,
    sessions: sessions
      .filter((session) => Number(session.attendance_id) === Number(row.id))
      .map((session) => ({
        id: session.id,
        startedAt: iso(session.started_at),
        endedAt: iso(session.ended_at),
        minutes: session.minutes === null ? null : Number(session.minutes),
        source: session.source,
        autoClosed: Number(session.auto_closed) === 1,
        inFlags: parseFlags(session.in_flags),
        outFlags: parseFlags(session.out_flags),
        inDeviceAt: iso(session.in_device_at),
        outDeviceAt: iso(session.out_device_at),
        inLatitude: coordinate(session.in_lat),
        inLongitude: coordinate(session.in_lng),
        outLatitude: coordinate(session.out_lat),
        outLongitude: coordinate(session.out_lng),
        inDistanceMetres: metres(session.in_distance_metres),
        outDistanceMetres: metres(session.out_distance_metres),
        inAccuracyMetres: metres(session.in_accuracy_metres),
        outAccuracyMetres: metres(session.out_accuracy_metres),
      })),
  }));
}

/*
 * Declared here rather than reusing `decisionSchema` below: routes register at module
 * load, top to bottom, and a `const` further down is not initialised yet at this point.
 */
const reviewNoteSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500, 'Keep the note to 500 characters or fewer.')
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/** The review queue, newest day first. */
hrAttendanceAdminRouter.get(
  '/attendance/exceptions',
  requireRole('supervisor'),
  validateQuery(exceptionsQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof exceptionsQuerySchema>;
    const { where, params } = exceptionsWhere(filters);

    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM hr_attendance a ${where}`,
      params,
    );

    const rows = await query<ExceptionRow>(
      `${EXCEPTION_SELECT}
        ${where}
        ORDER BY a.work_date DESC, a.id DESC
        LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
      params,
    );

    response.json({
      success: true,
      items: await toExceptions(rows),
      total: Number(countRow?.total ?? 0),
      page: filters.page,
      pageSize: filters.pageSize,
    });
  }),
);

/**
 * Marks an exception day reviewed. ADMIN ONLY.
 *
 * Guarded in the UPDATE (`flag_reviewed_at IS NULL`), so two reviewers cannot both
 * record a review; the second is told it was already done. A NEW flagged punch on the
 * same day clears the review again (`reopenFlagReview` in the attendance service), since
 * the reviewer has not seen it.
 */
hrAttendanceAdminRouter.post(
  '/attendance/exceptions/:attendanceId/review',
  ...write(),
  validateBody(reviewNoteSchema),
  asyncHandler(async (request, response) => {
    const attendanceId = parseId(request.params.attendanceId);
    const { note } = request.body as { note: string | null };

    const [row] = await query<ExceptionRow>(`${EXCEPTION_SELECT} WHERE a.id = ? LIMIT 1`, [attendanceId]);
    if (!row) throw notFound('Attendance day not found.');
    if (Number(row.missing_punch) !== 1 && Number(row.flagged) !== 1) {
      throw badRequest('Nothing on that day needs review.');
    }

    const result = await execute(
      `UPDATE hr_attendance
          SET flag_reviewed_by = ?, flag_reviewer_name = ?, flag_reviewed_at = NOW(),
              flag_review_note = ?
        WHERE id = ? AND flag_reviewed_at IS NULL AND (flagged = 1 OR missing_punch = 1)`,
      [request.actor!.id, request.actor!.name.slice(0, 120), note, attendanceId],
    );
    if (result.affectedRows === 0) throw badRequest('That day has already been reviewed.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_attendance_exception_reviewed',
      entityType: 'hr_attendance',
      entityId: attendanceId,
      summary: `Reviewed attendance exception for ${row.employee_name} (${row.employee_code}) on ${row.work_date}`,
      meta: {
        userId: row.user_id,
        workDate: row.work_date,
        missingPunch: Number(row.missing_punch) === 1,
        flagged: Number(row.flagged) === 1,
        note,
      },
      ipAddress: clientIp(request),
    });

    const [updated] = await query<ExceptionRow>(`${EXCEPTION_SELECT} WHERE a.id = ? LIMIT 1`, [attendanceId]);
    const [exception] = await toExceptions(updated ? [updated] : []);
    response.json({ success: true, exception: exception ?? null });
  }),
);

/* -------------------------------------------------------------------------- */
/* Regularisation queue                                                        */
/* -------------------------------------------------------------------------- */

const queueQuerySchema = z.object({
  status: z.enum([...REGULARISATION_STATUSES, 'all']).default('pending'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

hrAttendanceAdminRouter.get(
  '/regularisations',
  requireRole('supervisor'),
  validateQuery(queueQuerySchema),
  asyncHandler(async (_request, response) => {
    const { status, page, pageSize } = response.locals.query as z.infer<typeof queueQuerySchema>;
    response.json({ success: true, ...(await listQueue(status, { page, pageSize })) });
  }),
);

hrAttendanceAdminRouter.get(
  '/regularisations/count',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, pending: await pendingCount() });
  }),
);

const decisionSchema = z.object({
  // `null` too: the admin website sends `{ note: null }` for "no note", and refusing it as
  // invalid made every Approve (and every Reject without a reason) fail.
  note: z.string().trim().max(500).nullish().transform((v) => (v && v.length > 0 ? v : null)),
});

hrAttendanceAdminRouter.post(
  '/regularisations/:id/approve',
  ...write(),
  validateBody(decisionSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { note } = request.body as { note: string | null };

    const existing = await findRegularisation(id);
    if (!existing) throw notFound('Request not found.');

    const result = await approveRegularisation(
      id,
      { type: 'admin', id: request.actor!.id, name: request.actor!.name },
      note,
    );
    if (!result.ok) throw badRequest('That request has already been decided.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_regularisation_approved',
      entityType: 'hr_regularisation',
      entityId: id,
      summary: `Approved attendance correction for ${existing.employeeName} on ${existing.workDate}`,
      ipAddress: clientIp(request),
    });

    response.json({ success: true, request: await findRegularisation(id) });
  }),
);

hrAttendanceAdminRouter.post(
  '/regularisations/:id/reject',
  ...write(),
  validateBody(decisionSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { note } = request.body as { note: string | null };

    const existing = await findRegularisation(id);
    if (!existing) throw notFound('Request not found.');

    const result = await rejectRegularisation(
      id,
      { type: 'admin', id: request.actor!.id, name: request.actor!.name },
      note,
    );
    if (!result.ok) throw badRequest('That request has already been decided.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_regularisation_rejected',
      entityType: 'hr_regularisation',
      entityId: id,
      summary: `Rejected attendance correction for ${existing.employeeName} on ${existing.workDate}`,
      meta: note ? { note } : null,
      ipAddress: clientIp(request),
    });

    response.json({ success: true, request: await findRegularisation(id) });
  }),
);
