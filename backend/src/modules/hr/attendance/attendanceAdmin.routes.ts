import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import {
  LOCAL_TODAY,
  REGULARISATION_STATUSES,
  assignmentSchema,
  shiftSchema,
  workLocationSchema,
  type Shift,
  type WorkLocation,
} from './attendance.schema';
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
    isActive: row.is_active === 1,
  };
}

const SHIFT_COLUMNS = `id, name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, is_active`;

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

    const existing = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM hr_shifts WHERE name = ? LIMIT 1',
      [input.name],
    );
    if (existing) throw badRequest('A shift with that name already exists.');

    const result = await execute(
      `INSERT INTO hr_shifts
         (name, starts_at, ends_at, break_minutes, grace_minutes, half_day_minutes, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        `${input.startsAt}:00`,
        `${input.endsAt}:00`,
        input.breakMinutes,
        input.graceMinutes,
        input.halfDayMinutes,
        input.isActive === false ? 0 : 1,
      ],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_shift_created',
      entityType: 'hr_shift',
      entityId: result.insertId,
      summary: `Created shift ${input.name} (${input.startsAt}–${input.endsAt})`,
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

    await execute(
      `UPDATE hr_shifts
          SET name = COALESCE(?, name),
              starts_at = COALESCE(?, starts_at),
              ends_at = COALESCE(?, ends_at),
              break_minutes = COALESCE(?, break_minutes),
              grace_minutes = COALESCE(?, grace_minutes),
              half_day_minutes = COALESCE(?, half_day_minutes),
              is_active = COALESCE(?, is_active)
        WHERE id = ?`,
      [
        input.name ?? null,
        input.startsAt ? `${input.startsAt}:00` : null,
        input.endsAt ? `${input.endsAt}:00` : null,
        input.breakMinutes ?? null,
        input.graceMinutes ?? null,
        input.halfDayMinutes ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        id,
      ],
    );

    await recordAudit({
      actor: request.actor!,
      action: 'hr_shift_updated',
      entityType: 'hr_shift',
      entityId: id,
      summary: `Updated shift ${current.name}`,
      ipAddress: clientIp(request),
    });

    const row = await queryOne<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM hr_shifts WHERE id = ?`, [
      id,
    ]);
    response.json({ success: true, shift: toShift(row!) });
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

    const employee = await queryOne<RowDataPacket & { name: string; employee_code: string }>(
      'SELECT name, employee_code FROM hr_users WHERE id = ? LIMIT 1',
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

const registerQuerySchema = z.object({
  /** Defaults to the company's today, resolved in SQL. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  userId: z.coerce.number().int().positive().optional(),
});

interface RegisterRow extends RowDataPacket {
  user_id: number;
  name: string;
  employee_code: string;
  work_mode: string;
  work_date: string | null;
  checked_in_at: Date | string | null;
  checked_out_at: Date | string | null;
  worked_minutes: number | null;
  break_minutes: number | null;
  late_minutes: number | null;
  status: string | null;
  source: string | null;
  location_name: string | null;
  check_in_distance_metres: number | null;
  session_count: number | null;
  open_count: number | null;
}

/**
 * The day's register: every approved employee, present or not.
 *
 * A LEFT JOIN from `hr_users`, not a SELECT from `hr_attendance`. Listing only the
 * attendance rows would answer "who came in" while silently omitting the question the
 * register exists to answer, which is who did not.
 */
hrAttendanceAdminRouter.get(
  '/attendance',
  requireRole('supervisor'),
  validateQuery(registerQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof registerQuerySchema>;

    const rows = await query<RegisterRow>(
      `SELECT u.id AS user_id, u.name, u.employee_code, u.work_mode,
              DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
              a.checked_in_at, a.checked_out_at, a.worked_minutes, a.break_minutes,
              a.late_minutes, a.status, a.source,
              l.name AS location_name, a.check_in_distance_metres,
              (SELECT COUNT(*) FROM hr_attendance_sessions ss
                WHERE ss.attendance_id = a.id AND ss.ended_at IS NOT NULL) AS session_count,
              (SELECT COUNT(*) FROM hr_attendance_sessions ss
                WHERE ss.attendance_id = a.id AND ss.ended_at IS NULL)     AS open_count
         FROM hr_users u
         LEFT JOIN hr_attendance a
                ON a.user_id = u.id
               AND a.work_date = COALESCE(?, ${LOCAL_TODAY})
         LEFT JOIN hr_work_locations l ON l.id = a.check_in_location_id
        WHERE u.approval_status = 'approved' AND u.is_active = 1
          ${filters.userId ? 'AND u.id = ?' : ''}
        ORDER BY (a.checked_in_at IS NULL), u.name ASC`,
      filters.userId ? [filters.date ?? null, filters.userId] : [filters.date ?? null],
    );

    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

    response.json({
      success: true,
      date: filters.date ?? null,
      items: rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        employeeCode: row.employee_code,
        workMode: row.work_mode,
        workDate: row.work_date,
        checkedInAt: iso(row.checked_in_at),
        checkedOutAt: iso(row.checked_out_at),
        workedMinutes: row.worked_minutes,
        breakMinutes: row.break_minutes,
        lateMinutes: row.late_minutes,
        // No attendance row at all means absent, and the register says so rather than
        // leaving a blank the reader has to interpret.
        status: row.status ?? 'absent',
        source: row.source,
        locationName: row.location_name,
        distanceMetres: row.check_in_distance_metres,
        completedSessions: Number(row.session_count ?? 0),
        /* True while they are mid-session — the register's "in right now" column. */
        currentlyIn: Number(row.open_count ?? 0) > 0,
      })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Regularisation queue                                                        */
/* -------------------------------------------------------------------------- */

const queueQuerySchema = z.object({
  status: z.enum([...REGULARISATION_STATUSES, 'all']).default('pending'),
});

hrAttendanceAdminRouter.get(
  '/regularisations',
  requireRole('supervisor'),
  validateQuery(queueQuerySchema),
  asyncHandler(async (_request, response) => {
    const { status } = response.locals.query as z.infer<typeof queueQuerySchema>;
    response.json({ success: true, items: await listQueue(status) });
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
  note: z.string().trim().max(500).optional().transform((v) => (v && v.length > 0 ? v : null)),
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

    const result = await approveRegularisation(id, request.actor!.id, note);
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

    const result = await rejectRegularisation(id, request.actor!.id, note);
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
