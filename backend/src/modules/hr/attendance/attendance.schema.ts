import { z } from 'zod';

/**
 * Attendance vocabulary, and the one piece of arithmetic the whole module rests on.
 */

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The company's clock, as a fixed UTC offset.
 *
 * THIS MATTERS MORE THAN IT LOOKS. `db/pool.ts` pins every connection's session time
 * zone to UTC, so inside MySQL `NOW()` and `CURDATE()` are UTC — which is correct for
 * every other module and WRONG for a working day.
 *
 * India is UTC+5:30, so the UTC date rolls over at 05:30 local. Using `CURDATE()` for
 * `work_date` would file every punch made before half past five in the morning against
 * the previous day: an early shift's attendance would land on the wrong date, two
 * consecutive early starts would collide on the unique key, and the second would be
 * rejected as "already checked in today".
 *
 * A fixed offset rather than the zone name `Asia/Kolkata`, for two reasons: India has
 * never observed daylight saving, so there is nothing a named zone would capture that
 * this does not; and `CONVERT_TZ` with a NAMED zone silently returns NULL unless the
 * MySQL timezone tables have been loaded, which they are not on a default install. A
 * NULL work_date would fail loudly on the NOT NULL column — but only in production, on
 * the first punch.
 */
export const COMPANY_UTC_OFFSET = '+05:30';

/** `NOW()` expressed in the company's local wall clock. */
export const LOCAL_NOW = `CONVERT_TZ(NOW(), '+00:00', '${COMPANY_UTC_OFFSET}')`;

/** Today's date in the company's local wall clock. */
export const LOCAL_TODAY = `DATE(${LOCAL_NOW})`;

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const WORK_MODES = ['office', 'remote', 'field'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'half_day',
  'absent',
  'on_leave',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const REGULARISATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RegularisationStatus = (typeof REGULARISATION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Geography                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Distance between two coordinates, in metres.
 *
 * The haversine formula, computed in Node rather than in SQL. The alternative —
 * `ST_Distance_Sphere` — is only available on MySQL 5.7.6+ and would push a decision
 * that has to be auditable into a query plan; this way the number is computed once,
 * logged, and written into the attendance row as evidence.
 *
 * Haversine assumes a sphere, which is wrong by up to about 0.5% against the real
 * ellipsoid. At a 150m geofence that is under a metre — far inside a handset's own GPS
 * error, and not worth Vincenty's iteration.
 */
export function distanceMetres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;

  const dLat = toRad(to.latitude - from.latitude);
  const dLng = toRad(to.longitude - from.longitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLng / 2) ** 2;

  return Math.round(EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* -------------------------------------------------------------------------- */
/* Request schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A coordinate reading from the handset.
 *
 * Optional as a whole, because a remote or field worker may have declined location
 * permission and must still be able to record a day's work. Where the geofence DOES
 * apply, the service refuses a punch that arrives without one — that decision lives in
 * the service, not here, so the refusal can explain itself.
 */
export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /**
   * The handset's own error estimate, in metres.
   *
   * Used to forgive a bad fix rather than to tighten one: a punch 200m outside a
   * geofence with a reported accuracy of 500m is an uncertain reading, not a person in
   * the wrong place, and refusing it would strand somebody standing in their own office.
   */
  accuracyMetres: z.number().min(0).max(100_000).optional(),
});

export const punchSchema = z.object({
  coordinate: coordinateSchema.optional(),
  /**
   * What the handset believed the time was, ISO-8601.
   *
   * Recorded, never trusted — see migration 018. It exists so a dispute can be shown a
   * device clock that was hours out, and so a queued offline punch can be identified as
   * one. The punch itself is stamped with the server's clock.
   */
  deviceTime: z.string().datetime({ offset: true }).optional(),
  /**
   * Idempotency key, generated by the client once per punch attempt and reused across
   * retries.
   *
   * The unique key on (user_id, work_date) already makes a duplicate check-in
   * impossible, so this is not what protects the data — it is what lets a retry be
   * answered with the SAME success rather than with "you are already checked in", which
   * on a flaky connection is indistinguishable from a bug.
   */
  idempotencyKey: z.string().trim().min(8).max(64).optional(),
});

export const historyQuerySchema = z.object({
  /** Inclusive, `YYYY-MM-DD`. Defaults to the start of the current month. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional(),
});

export const regularisationSchema = z
  .object({
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
    /** Local wall-clock times on `workDate`, `HH:MM`. */
    checkInAt: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Use HH:MM.')
      .nullish(),
    checkOutAt: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Use HH:MM.')
      .nullish(),
    reason: z
      .string({ required_error: 'Say why this needs correcting.' })
      .trim()
      .min(5, 'Say why this needs correcting.')
      .max(500, 'Keep it to 500 characters or fewer.'),
  })
  /*
   * A request that asks for nothing cannot be approved into anything. Caught here
   * rather than in the service so the message names the fields rather than describing
   * an internal state.
   */
  .refine((value) => Boolean(value.checkInAt) || Boolean(value.checkOutAt), {
    message: 'Give a check-in time, a check-out time, or both.',
    path: ['checkInAt'],
  });

/* -------------------------------------------------------------------------- */
/* Admin schemas                                                               */
/* -------------------------------------------------------------------------- */

export const workLocationSchema = z.object({
  name: z.string().trim().min(2, 'Name the site.').max(120),
  address: z.string().trim().max(400).nullish(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  /*
   * Floored at 25m deliberately. A consumer GPS fix is routinely 20–50m out, so a
   * tighter radius does not catch anybody cheating — it refuses honest people standing
   * inside the building, every morning, and HR carries the support cost.
   */
  radiusMetres: z.coerce.number().int().min(25, 'Use at least 25 metres.').max(10_000),
  isActive: z.boolean().optional(),
});

export const shiftSchema = z.object({
  name: z.string().trim().min(2, 'Name the shift.').max(120),
  startsAt: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  endsAt: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  breakMinutes: z.coerce.number().int().min(0).max(480),
  graceMinutes: z.coerce.number().int().min(0).max(240),
  halfDayMinutes: z.coerce.number().int().min(0).max(1440),
  isActive: z.boolean().optional(),
});

export const assignmentSchema = z.object({
  workLocationId: z.coerce.number().int().positive().nullish(),
  shiftId: z.coerce.number().int().positive().nullish(),
  workMode: z.enum(WORK_MODES),
});

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type WorkLocation = {
  id: number;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMetres: number;
  isActive: boolean;
};

export type Shift = {
  id: number;
  name: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  graceMinutes: number;
  halfDayMinutes: number;
  isActive: boolean;
};

/** One check-in / check-out pair. A day has as many as the employee worked. */
export type AttendanceSession = {
  id: number;
  startedAt: string;
  /** Null while this session is the one currently running. */
  endedAt: string | null;
  /** Null while open — "still working" is not "worked nothing". */
  minutes: number | null;
  source: 'app' | 'regularisation' | 'admin';
};

/**
 * A day, rolled up from its sessions.
 *
 * The roll-up columns are stored rather than derived on read, because almost
 * everything reads days — the register, the history list, the monthly summary — and
 * recomputing from sessions would turn each of those into a join and a group-by.
 */
export type AttendanceDay = {
  id: number | null;
  workDate: string;
  /** The FIRST check-in of the day. */
  checkedInAt: string | null;
  /** The LAST check-out, or null while a session is still open. */
  checkedOutAt: string | null;
  /** Sum of completed sessions. Null while nothing has closed yet. */
  workedMinutes: number | null;
  /** The gaps BETWEEN sessions, derived. Zero while a session is open. */
  breakMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  status: AttendanceStatus;
  workMode: WorkMode;
  shiftStartsAt: string | null;
  shiftEndsAt: string | null;
  source: 'app' | 'regularisation' | 'admin';
  note: string | null;
  /** How many sessions have CLOSED today. */
  completedSessions: number;
  /** Set while a session is running — this is the app's "checked in" state. */
  openSessionStartedAt: string | null;
  sessions: AttendanceSession[];
};

export type Regularisation = {
  id: number;
  userId: number;
  employeeName?: string;
  employeeCode?: string;
  workDate: string;
  requestedCheckInAt: string | null;
  requestedCheckOutAt: string | null;
  reason: string;
  status: RegularisationStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
};
