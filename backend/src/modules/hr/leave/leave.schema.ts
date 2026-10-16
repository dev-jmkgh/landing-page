import { z } from 'zod';
import { isoDateField, pageQuerySchema } from '../hr.schema';
import type { HalfDay, LeaveKind } from '../calendar/calendar.service';

/**
 * Leave vocabulary, request schemas and the records the API returns.
 *
 * Pure: no database, no config. The service and both routers import from here, and so
 * may a script, without dragging the pool in behind it.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const LEAVE_KINDS = ['leave', 'wfh', 'field'] as const satisfies readonly LeaveKind[];
export const HALF_DAYS = ['none', 'first_half', 'second_half'] as const satisfies readonly HalfDay[];
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/**
 * The rules an application is held to. Exported so the copy that explains a refusal
 * and the check that makes it read the same number.
 */
export const LEAVE_RULES = {
  /** Longest single request, in calendar days. Anything longer is a conversation with HR. */
  maxSpanDays: 60,
  /** How far back a request may start — the same window as an attendance correction. */
  maxBackdateDays: 30,
  /** How far ahead a request may start. */
  maxAheadDays: 365,
} as const;

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type LeaveType = {
  id: number;
  name: string;
  code: string;
  kind: LeaveKind;
  isPaid: boolean;
  /** Days a year. Null means UNTRACKED: no balance exists, and none is shown. */
  annualQuota: number | null;
  allowHalfDay: boolean;
  isActive: boolean;
  sortOrder: number;
};

/**
 * One employee's standing for one leave type in one calendar year.
 *
 * `entitled` and `available` are null — never 0 — when the type is untracked: "you have
 * no balance" and "you have used it all" are different statements, and only one of
 * them is true of a type HR has not set an entitlement for. `used` and `pending` are
 * always real counts, because the requests behind them exist either way.
 */
export type LeaveBalance = {
  leaveType: LeaveType;
  year: number;
  tracked: boolean;
  entitled: number | null;
  used: number;
  pending: number;
  available: number | null;
};

/** The admin view adds the per-person override behind `entitled`, if there is one. */
export type LeaveBalanceWithAllocation = LeaveBalance & {
  allocation: { days: number; note: string | null; updatedAt: string | null } | null;
};

export type LeaveRequest = {
  id: number;
  userId: number;
  employeeName: string;
  employeeCode: string;
  leaveType: { id: number; name: string; code: string; kind: LeaveKind; isPaid: boolean };
  startDate: string;
  endDate: string;
  halfDay: HalfDay;
  /** Working days the request costs, fixed when it was raised. */
  days: number;
  reason: string;
  status: LeaveStatus;
  /** 'admin' (the admin portal) or 'manager' (a team manager in the app), once decided. */
  reviewerType: 'admin' | 'manager' | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** Whether the EMPLOYEE may still withdraw it: pending, or approved and not yet begun. */
  canCancel: boolean;
};

export type Holiday = { id: number; date: string; name: string; isOptional: boolean };

/* -------------------------------------------------------------------------- */
/* Field helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A real calendar date. The shared `isoDateField` checks the shape only, and
 * `2026-02-30` has the right shape — it would reach SQL and come back as NULL or as
 * March, depending on the server's mode.
 */
export const calendarDateField = isoDateField.refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a real date.');

/** Leave is counted in whole and half days, never anything finer. */
const halfStepDays = (message: string) =>
  z
    .number({ invalid_type_error: message })
    .min(0, message)
    .max(365, message)
    .refine((value) => Number.isInteger(value * 2), 'Use whole or half days.');

const yearField = z.coerce.number().int().min(2000).max(2100);

/** An optional note on a decision. Blank means none. */
export const decisionSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500, 'Keep the note to 500 characters or fewer.')
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

/* -------------------------------------------------------------------------- */
/* Employee schemas                                                            */
/* -------------------------------------------------------------------------- */

export const applySchema = z.object({
  leaveTypeId: z.coerce.number({ invalid_type_error: 'Choose a leave type.' }).int().positive('Choose a leave type.'),
  startDate: calendarDateField,
  endDate: calendarDateField,
  halfDay: z.enum(HALF_DAYS).default('none'),
  reason: z
    .string({ required_error: 'Say briefly why you need this.' })
    .trim()
    .min(3, 'Say briefly why you need this.')
    .max(500, 'Keep the reason to 500 characters or fewer.'),
  /*
   * Generated by the app once per submission and reused on every retry, so a request
   * sent twice over a flaky connection is one request.
   */
  clientKey: z.string().trim().min(8).max(64),
});
export type ApplyInput = z.infer<typeof applySchema>;

/** The same fields as an application, minus what only a submission needs. */
export const previewQuerySchema = z.object({
  leaveTypeId: z.coerce.number().int().positive(),
  startDate: calendarDateField,
  /** Defaults to the start date: a one-day request. */
  endDate: calendarDateField.optional(),
  halfDay: z.enum(HALF_DAYS).default('none'),
});

export const yearQuerySchema = z.object({ year: yearField.optional() });

export const myRequestsQuerySchema = pageQuerySchema.extend({
  status: z.enum([...LEAVE_STATUSES, 'all']).default('all'),
});

/* -------------------------------------------------------------------------- */
/* Team schemas                                                                */
/* -------------------------------------------------------------------------- */

export const teamMembersQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});

export const teamLeaveQuerySchema = pageQuerySchema.extend({
  status: z.enum([...LEAVE_STATUSES, 'all']).default('pending'),
});

/* -------------------------------------------------------------------------- */
/* Admin schemas                                                               */
/* -------------------------------------------------------------------------- */

const leaveTypeFields = {
  name: z.string().trim().min(2, 'Name the leave type.').max(80, 'Keep the name to 80 characters or fewer.'),
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,16}$/, 'Use 2 to 16 letters or digits, e.g. CL.')),
  kind: z.enum(LEAVE_KINDS),
  isPaid: z.boolean(),
  annualQuota: halfStepDays('Use a number of days from 0 to 365.').nullable(),
  allowHalfDay: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean(),
};

export const createLeaveTypeSchema = z.object({
  name: leaveTypeFields.name,
  code: leaveTypeFields.code,
  kind: leaveTypeFields.kind.default('leave'),
  isPaid: leaveTypeFields.isPaid.default(true),
  /* Omitted means untracked — the honest default for a type with no policy yet. */
  annualQuota: leaveTypeFields.annualQuota.default(null),
  allowHalfDay: leaveTypeFields.allowHalfDay.default(true),
  sortOrder: leaveTypeFields.sortOrder.default(0),
});
export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;

/** Every field optional; `annualQuota: null` makes the type untracked. */
export const updateLeaveTypeSchema = z
  .object({
    name: leaveTypeFields.name.optional(),
    code: leaveTypeFields.code.optional(),
    kind: leaveTypeFields.kind.optional(),
    isPaid: leaveTypeFields.isPaid.optional(),
    annualQuota: leaveTypeFields.annualQuota.optional(),
    allowHalfDay: leaveTypeFields.allowHalfDay.optional(),
    sortOrder: leaveTypeFields.sortOrder.optional(),
    isActive: leaveTypeFields.isActive.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one field.',
    path: ['form'],
  });
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export const allocationQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
  year: yearField.optional(),
});

export const allocationSchema = z.object({
  userId: z.coerce.number().int().positive(),
  leaveTypeId: z.coerce.number().int().positive(),
  year: yearField,
  /** Null removes the override, so the type's annual quota applies again. */
  days: halfStepDays('Use a number of days from 0 to 365.').nullable(),
  note: z
    .string()
    .trim()
    .max(255, 'Keep the note to 255 characters or fewer.')
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});
export type AllocationInput = z.infer<typeof allocationSchema>;

export const adminRequestsQuerySchema = pageQuerySchema.extend({
  status: z.enum([...LEAVE_STATUSES, 'all']).default('all'),
  userId: z.coerce.number().int().positive().optional(),
  leaveTypeId: z.coerce.number().int().positive().optional(),
  /** Requests overlapping [from, to]. */
  from: calendarDateField.optional(),
  to: calendarDateField.optional(),
  q: z.string().trim().max(120).optional(),
});
export type AdminRequestsQuery = z.infer<typeof adminRequestsQuerySchema>;

export const holidaySchema = z.object({
  date: calendarDateField,
  name: z.string().trim().min(2, 'Name the holiday.').max(120, 'Keep the name to 120 characters or fewer.'),
  isOptional: z.boolean().default(false),
});

export const updateHolidaySchema = z
  .object({
    date: calendarDateField.optional(),
    name: z.string().trim().min(2, 'Name the holiday.').max(120).optional(),
    isOptional: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one field.',
    path: ['form'],
  });
