import { z } from 'zod';
import { calendarQuerySchema, WORK_MODES } from '../attendance/attendance.schema';
import { daysBetween, isIsoDate } from '../calendar/calendar.service';
import {
  HR_APPROVAL_STATUSES,
  HR_EMPLOYMENT_STATUSES,
  HR_EMPLOYMENT_TYPES,
  HR_ROLES,
  optionalPhoneField,
  pageQuerySchema,
} from '../hr.schema';
import { hrSignupSchema } from '../hrAuth.routes';
import { COMP_OFF_VALIDITY, WEEKDAYS } from '../settings/hrSettings';

/**
 * Request schemas and records for employee records and the organisation lists
 * (departments, designations) — the admin portal's `/api/admin/hr` people surface.
 */

/* -------------------------------------------------------------------------- */
/* Field helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A query-string value where an empty string means "not filtering".
 *
 * A filter form posts `departmentId=` for "All departments". Without this, the coerce
 * turns '' into 0 and the positive-int rule refuses a request the UI considers blank.
 */
const blankAsUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalQueryId = z.preprocess(blankAsUndefined, z.coerce.number().int().positive().optional());

/** A real calendar date — `2026-02-30` passes the shape regex but is not a day. */
export const calendarDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine(isIsoDate, 'That is not a real date.');

/** Name rule for an organisation list entry: collapsed whitespace, 2–120 characters. */
const listName = z
  .string({ required_error: 'Enter a name.' })
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(2, 'Enter a name.').max(120, 'Keep it to 120 characters or fewer.'));

/**
 * An optional free-text field on a PATCH: absent leaves it alone, null or blank clears it.
 *
 * Not `optionalPhoneField`-style, because that one turns ABSENT into null too — right
 * for a create form, and on a partial update it would silently wipe every field the
 * administrator did not touch.
 */
function clearableText(max: number, label: string) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .refine((value) => value === undefined || value === null || value.length <= max, {
      message: `Keep the ${label} to ${max} characters or fewer.`,
    });
}

/** A phone on a PATCH: absent leaves it, null/blank clears it, anything else must look like a phone. */
const clearablePhone = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = (value ?? '').trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === undefined || value === null || /^[0-9+\-\s()]{6,20}$/.test(value), {
    message: 'Enter a valid phone number.',
  });

const clearableId = z.union([z.coerce.number().int().positive(), z.null()]).optional();
const clearableDate = z.union([calendarDateField, z.null()]).optional();

/* -------------------------------------------------------------------------- */
/* Departments and designations                                                */
/* -------------------------------------------------------------------------- */

/**
 * A department's short code, e.g. FIN — upper-cased so "fin" and "FIN" are not two
 * spellings of one code in an export. Blank means none.
 */
const departmentCode = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = (value ?? '').trim().toUpperCase();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === undefined || value === null || /^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(value), {
    message: 'Use up to 24 letters, digits, dashes or underscores.',
  });

export const departmentCreateSchema = z.object({
  name: listName,
  code: departmentCode,
});

export const departmentPatchSchema = z
  .object({
    name: listName.optional(),
    code: departmentCode,
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to change.',
    path: ['form'],
  });

export const designationCreateSchema = z.object({ name: listName });

export const designationPatchSchema = z
  .object({
    name: listName.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.isActive !== undefined, {
    message: 'Nothing to change.',
    path: ['form'],
  });

export type Department = {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  /** Active, approved employees in it — the same headcount the dashboard reports. */
  employeeCount: number;
};

export type Designation = {
  id: number;
  name: string;
  isActive: boolean;
  employeeCount: number;
};

/* -------------------------------------------------------------------------- */
/* Employees                                                                   */
/* -------------------------------------------------------------------------- */

export const directoryQuerySchema = pageQuerySchema.extend({
  q: z.preprocess(blankAsUndefined, z.string().trim().max(120).optional()),
  departmentId: optionalQueryId,
  designationId: optionalQueryId,
  managerId: optionalQueryId,
  workMode: z.preprocess(blankAsUndefined, z.enum(WORK_MODES).optional()),
  employmentStatus: z.preprocess(blankAsUndefined, z.enum(HR_EMPLOYMENT_STATUSES).optional()),
  active: z.preprocess(
    blankAsUndefined,
    z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  ),
  approval: z.preprocess(blankAsUndefined, z.enum(HR_APPROVAL_STATUSES).optional()),
});

/**
 * Creating an employee directly. The administrator vouches for the person, so the
 * account is approved, active and email-verified at once — see the route.
 *
 * Name, email and password reuse the SIGNUP rules verbatim (imported, not copied), so an
 * account made here can never hold a password the app's own signup would refuse.
 */
export const employeeCreateSchema = z.object({
  name: hrSignupSchema.shape.name,
  email: hrSignupSchema.shape.email,
  phone: optionalPhoneField,
  password: hrSignupSchema.shape.password,
  role: z.enum(HR_ROLES).default('employee'),
  departmentId: z.coerce.number().int().positive().nullish(),
  designationId: z.coerce.number().int().positive().nullish(),
  managerId: z.coerce.number().int().positive().nullish(),
  joiningDate: calendarDateField.nullish(),
  employmentType: z.enum(HR_EMPLOYMENT_TYPES).default('full_time'),
  employmentStatus: z.enum(HR_EMPLOYMENT_STATUSES).default('active'),
});
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

/**
 * Editing an employee record. Every field is optional; `null` clears a nullable one.
 * Email and password are deliberately absent — an address is the sign-in identity and a
 * password is the employee's own.
 */
export const employeePatchSchema = z
  .object({
    name: hrSignupSchema.shape.name.optional(),
    phone: clearablePhone,
    role: z.enum(HR_ROLES).optional(),
    departmentId: clearableId,
    designationId: clearableId,
    managerId: clearableId,
    joiningDate: clearableDate,
    exitDate: clearableDate,
    employmentType: z.enum(HR_EMPLOYMENT_TYPES).optional(),
    employmentStatus: z.enum(HR_EMPLOYMENT_STATUSES).optional(),
    dateOfBirth: clearableDate,
    address: clearableText(400, 'address'),
    emergencyContactName: clearableText(120, 'contact name'),
    emergencyContactPhone: clearablePhone,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to change.',
    path: ['form'],
  });
export type EmployeePatchInput = z.infer<typeof employeePatchSchema>;

/**
 * An administrator setting a new password for an employee who lost theirs. The same rules
 * as signing up and as adding an employee: one set of password rules for the HR app.
 */
export const employeePasswordSchema = z.object({ password: hrSignupSchema.shape.password });
export type EmployeePasswordInput = z.infer<typeof employeePasswordSchema>;

export const employeeAttendanceQuerySchema = pageQuerySchema.extend({
  from: z.preprocess(blankAsUndefined, calendarDateField.optional()),
  to: z.preprocess(blankAsUndefined, calendarDateField.optional()),
});

export const employeeCalendarQuerySchema = calendarQuerySchema;

/**
 * The attendance view's days: a whole month (the calendar), or a range of up to 31 days
 * (the week the table and punch views page through). A range needs both ends; with
 * neither, it is the current month.
 */
export const attendanceDaysQuerySchema = z
  .object({
    month: calendarQuerySchema.shape.month,
    from: z.preprocess(blankAsUndefined, calendarDateField.optional()),
    to: z.preprocess(blankAsUndefined, calendarDateField.optional()),
  })
  .superRefine((value, context) => {
    if ((value.from === undefined) !== (value.to === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.from === undefined ? 'from' : 'to'],
        message: 'Give both the start and the end of the range.',
      });
      return;
    }
    if (value.from === undefined || value.to === undefined) return;
    if (value.from > value.to) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The end must be on or after the start.' });
    } else if (daysBetween(value.from, value.to) > 30) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'A range can cover at most 31 days.' });
    }
  });

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const settingsPatchSchema = z
  .object({
    attendanceTrackedFrom: z.union([calendarDateField, z.null()]).optional(),
    /* An empty list is a real policy (no weekly off), so it is not refused. */
    defaultWeeklyOff: z
      .array(z.enum(WEEKDAYS, { message: 'Use sun, mon, tue, wed, thu, fri or sat.' }))
      .max(7)
      .optional(),
    /*
     * The day a pay period starts on. 28 at most, so every month has it. Changing it
     * affects pay periods created afterwards; existing ones keep the dates they were
     * created with.
     */
    payrollCycleStartDay: z.coerce
      .number()
      .int('Use a whole day of the month.')
      .min(1, 'Use a day from 1 to 28.')
      .max(28, 'Use a day from 1 to 28.')
      .optional(),
    /* Compensatory leave: days after the worked weekly off or holiday to take it by. */
    compOffValidityDays: z.coerce
      .number()
      .int('Use a whole number of days.')
      .min(COMP_OFF_VALIDITY.min, `Use ${COMP_OFF_VALIDITY.min} to ${COMP_OFF_VALIDITY.max} days.`)
      .max(COMP_OFF_VALIDITY.max, `Use ${COMP_OFF_VALIDITY.min} to ${COMP_OFF_VALIDITY.max} days.`)
      .optional(),
  })
  .refine(
    (value) =>
      value.attendanceTrackedFrom !== undefined ||
      value.defaultWeeklyOff !== undefined ||
      value.payrollCycleStartDay !== undefined ||
      value.compOffValidityDays !== undefined,
    { message: 'Nothing to change.', path: ['form'] },
  );
