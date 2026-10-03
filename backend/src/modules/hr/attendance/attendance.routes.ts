import { Router } from 'express';
import { z } from 'zod';
import type { RowDataPacket } from '../../../db/pool';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { mobileSyncLimiter } from '../../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { HttpError, badRequest } from '../../../utils/httpError';
import {
  LOCAL_TODAY,
  historyQuerySchema,
  punchSchema,
  regularisationSchema,
} from './attendance.schema';
import {
  assignmentFor,
  checkIn,
  checkOut,
  historyFor,
  summaryFor,
  todayFor,
  type GeoVerdict,
} from './attendance.service';
import {
  MAX_BACKDATE_DAYS,
  listForUser,
  raise,
} from './regularisation.service';

/**
 * Attendance for the HR app, mounted at `/api/hr/attendance`.
 *
 * Every route is Bearer-only through `requireHrActor`, and every one acts on the
 * SIGNED-IN employee. There is deliberately no `userId` parameter anywhere in this
 * file: an employee reads and writes their own attendance and nobody else's, and the
 * way to guarantee that is for the endpoint to have no way to express another person.
 * Administrators use `/api/admin/hr/*`, which authenticates differently.
 */
export const hrAttendanceRouter = Router();

hrAttendanceRouter.use(requireHrActor);

/**
 * Turns a geofence refusal into a response the app can act on.
 *
 * The distance is included for `too_far` on purpose. "You are not at the office" with
 * no number is impossible to act on and reads as a bug when somebody IS at the office;
 * "you are 480m away, the site allows 150m" tells them whether to walk closer or call
 * HR about a wrong pin.
 */
function geoError(verdict: Exclude<GeoVerdict, { ok: true }>): HttpError {
  switch (verdict.reason) {
    case 'location_required':
      return new HttpError(
        422,
        'Turn on location to check in from your workplace.',
        { code: 'location_required' },
      );

    case 'no_site_assigned':
      return new HttpError(
        409,
        'You have not been assigned a workplace yet. Please contact HR.',
        { code: 'no_site_assigned' },
      );

    case 'too_far':
      return new HttpError(
        422,
        `You are about ${verdict.distanceMetres}m from ${verdict.siteName}, which allows ${verdict.allowed}m. Move closer and try again.`,
        /*
          * The distance is in the MESSAGE rather than in a structured field, because
          * HttpError's options carry only `code`. The app shows the message verbatim,
          * so the number still reaches the person who needs it.
          */
        { code: 'outside_geofence' },
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Today                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything the attendance screen needs in one call.
 *
 * The assignment travels with the day because the screen cannot render without it: it
 * decides whether to ask for location permission at all, and what to say when there is
 * no site assigned. Two calls would mean a frame where the app knows it is checked out
 * but not whether it may check in.
 */
hrAttendanceRouter.get(
  '/today',
  asyncHandler(async (request, response) => {
    const userId = request.hrActor!.id;
    const [day, assignment] = await Promise.all([todayFor(userId), assignmentFor(userId)]);

    response.json({
      success: true,
      day,
      assignment: {
        workMode: assignment.workMode,
        geofenced: assignment.geofenced,
        location: assignment.location
          ? {
              id: assignment.location.id,
              name: assignment.location.name,
              latitude: assignment.location.latitude,
              longitude: assignment.location.longitude,
              radiusMetres: assignment.location.radiusMetres,
            }
          : null,
        shift: assignment.shift
          ? {
              id: assignment.shift.id,
              name: assignment.shift.name,
              startsAt: assignment.shift.startsAt,
              endsAt: assignment.shift.endsAt,
            }
          : null,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Punches                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * `mobileSyncLimiter` rather than a tighter one. These are ordinary app actions, not
 * credential checks — the thing worth bounding is a retry loop, and the unique key on
 * the day already makes a duplicate punch impossible.
 */
hrAttendanceRouter.post(
  '/check-in',
  mobileSyncLimiter,
  validateBody(punchSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof punchSchema>;

    const result = await checkIn(request.hrActor!.id, {
      coordinate: input.coordinate,
      deviceTime: input.deviceTime,
    });

    if (!result.ok) throw geoError(result.verdict);

    response.status(result.alreadyCheckedIn ? 200 : 201).json({
      success: true,
      day: result.day,
      alreadyCheckedIn: result.alreadyCheckedIn,
    });
  }),
);

hrAttendanceRouter.post(
  '/check-out',
  mobileSyncLimiter,
  validateBody(punchSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof punchSchema>;

    const result = await checkOut(request.hrActor!.id, {
      coordinate: input.coordinate,
      deviceTime: input.deviceTime,
    });

    if (!result.ok) {
      if ('verdict' in result) throw geoError(result.verdict);

      throw new HttpError(409, 'You are not checked in.', { code: 'not_checked_in' });
    }

    response.json({
      success: true,
      day: result.day,
      alreadyCheckedOut: result.alreadyCheckedOut,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

hrAttendanceRouter.get(
  '/history',
  validateQuery(historyQuerySchema),
  asyncHandler(async (request, response) => {
    const { from, to } = response.locals.query as z.infer<typeof historyQuerySchema>;
    const userId = request.hrActor!.id;

    /*
     * Defaults to the current month, computed from the COMPANY's date rather than the
     * server's. `new Date()` here would roll the month over five and a half hours early
     * on the first of each month, and the employee would open the screen to an empty
     * list on a day they had already worked.
     */
    const bounds = await resolveRange(from, to);

    const [days, summary] = await Promise.all([
      historyFor(userId, bounds.from, bounds.to),
      summaryFor(userId, bounds.from, bounds.to),
    ]);

    response.json({ success: true, from: bounds.from, to: bounds.to, days, summary });
  }),
);

/**
 * Resolves a date range against the company's calendar.
 *
 * Done in SQL for the timezone reason above, and clamped so a hand-crafted request
 * cannot ask for ten years of rows in one page.
 */
async function resolveRange(
  from: string | undefined,
  to: string | undefined,
): Promise<{ from: string; to: string }> {
  const { queryOne } = await import('../../../db/pool');

  interface RangeRow extends RowDataPacket {
    f: string;
    t: string;
  }

  const row = await queryOne<RangeRow>(
    `SELECT DATE_FORMAT(COALESCE(?, DATE_FORMAT(${LOCAL_TODAY}, '%Y-%m-01')), '%Y-%m-%d') AS f,
            DATE_FORMAT(COALESCE(?, ${LOCAL_TODAY}), '%Y-%m-%d') AS t`,
    [from ?? null, to ?? null],
  );

  return { from: String(row?.f), to: String(row?.t) };
}

/* -------------------------------------------------------------------------- */
/* Regularisation                                                              */
/* -------------------------------------------------------------------------- */

hrAttendanceRouter.get(
  '/regularisations',
  asyncHandler(async (request, response) => {
    response.json({ success: true, items: await listForUser(request.hrActor!.id) });
  }),
);

hrAttendanceRouter.post(
  '/regularisations',
  mobileSyncLimiter,
  validateBody(regularisationSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof regularisationSchema>;

    const result = await raise(request.hrActor!.id, {
      workDate: input.workDate,
      checkInAt: input.checkInAt ?? null,
      checkOutAt: input.checkOutAt ?? null,
      reason: input.reason,
    });

    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        future_date: 'You cannot correct a day that has not happened yet.',
        too_old: `Corrections can only go back ${MAX_BACKDATE_DAYS} days. Please contact HR for anything older.`,
        already_open: 'You already have a request waiting for that day.',
      };
      throw badRequest(messages[result.reason]);
    }

    response.status(201).json({ success: true, request: result.request });
  }),
);
