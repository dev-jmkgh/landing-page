import { z } from 'zod';
import { normaliseLine } from '../../../utils/text';
import { deactivationHandoverSchema } from '../followups/followUp.schema';
import {
  AVAILABILITY_STATES,
  companyPhoneField,
  EMPLOYEE_ROLES,
  optionalCompanyPhoneField,
  optionalLine,
  optionalPhoneField,
  paginationSchema,
} from '../shared.schema';

/**
 * Request contracts for employee management (spec: Admin Module 3) and the mobile
 * profile screen (Mobile Module 1).
 */

const nameField = z
  .string({ required_error: 'Enter the employee name.' })
  .transform(normaliseLine)
  .pipe(z.string().min(2, 'Enter the full name.').max(120, 'Name must be 120 characters or fewer.'));

const emailField = z
  .string({ required_error: 'Enter an email address.' })
  .transform((value) => normaliseLine(value).toLowerCase())
  .pipe(z.string().max(190, 'Email address is too long.').email('Enter a valid email address.'));

/**
 * Minimum password length.
 *
 * Twelve characters, not eight. These accounts hold customer contact details for an
 * entire lead list, they are shared out by an administrator rather than chosen in
 * private, and there is no second factor. Length is the only defence actually available
 * here, so it is not the place to match the usual default.
 */
const passwordField = z
  .string({ required_error: 'Set a password.' })
  .min(12, 'Use at least 12 characters.')
  .max(200, 'Password must be 200 characters or fewer.');

/**
 * Employee code.
 *
 * Optional on create: the service generates the next `TC-####` when it is omitted, so
 * an admin adding staff quickly does not have to track the sequence by hand.
 */
const employeeCodeField = z
  .string()
  .transform((value) => normaliseLine(value).toUpperCase())
  .pipe(
    z
      .string()
      .min(2, 'Employee code is too short.')
      .max(24, 'Employee code must be 24 characters or fewer.')
      .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and hyphens only.'),
  )
  .optional();

/**
 * Create.
 *
 * `companyPhone` is the company SIM number (canonical `+91XXXXXXXXXX`), REQUIRED for a
 * telecaller: incoming calls count only when they arrive on it, so a telecaller without
 * one would have no incoming calls recorded at all — a gap nobody would notice until a
 * report came up short. Other roles may have one. `phone` stays the optional personal
 * number.
 */
export const createEmployeeSchema = z
  .object({
    name: nameField,
    email: emailField,
    phone: optionalPhoneField,
    companyPhone: optionalCompanyPhoneField.optional(),
    password: passwordField,
    role: z.enum(EMPLOYEE_ROLES).default('telecaller'),
    employeeCode: employeeCodeField,
  })
  .superRefine((value, context) => {
    if (value.role === 'telecaller' && !value.companyPhone) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companyPhone'],
        message: 'Enter the company SIM number for this telecaller.',
      });
    }
  });

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * Update.
 *
 * Password is absent on purpose — changing someone else's password revokes every one of
 * their devices, so it is a separate, explicitly named endpoint rather than a field that
 * can be sent by accident alongside a phone-number correction.
 *
 * `phone` and `companyPhone` are wrapped in `.optional()` so an absent key means
 * "unchanged". Bare, `phone` turned a missing key into null, and every partial update —
 * deactivating someone, changing a role — silently erased the stored number. An explicit
 * null (or `''`) still clears either.
 */
export const updateEmployeeSchema = z
  .object({
    name: nameField.optional(),
    email: emailField.optional(),
    phone: optionalPhoneField.optional(),
    companyPhone: optionalCompanyPhoneField.optional(),
    role: z.enum(EMPLOYEE_ROLES).optional(),
    employeeCode: employeeCodeField,
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update.',
  });

export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/**
 * Deactivate, optionally moving every pending follow-up first — one transaction, so
 * nothing can be booked onto the employee between the move and the switch-off.
 */
export const deactivateEmployeeSchema = z.object({
  handover: deactivationHandoverSchema.optional(),
  /** Why, for the audit log. */
  reason: optionalLine(255),
});

export type DeactivateEmployeeInput = z.infer<typeof deactivateEmployeeSchema>;

/**
 * Approve a registration. The company number is needed only when the applicant has none
 * on record — registrations from older app builds — and then saved with the approval.
 */
export const approveRegistrationSchema = z
  .object({
    companyPhone: companyPhoneField.optional(),
  })
  .default({});

export type ApproveRegistrationInput = z.infer<typeof approveRegistrationSchema>;

/**
 * What an employee's phone reports about the company SIM (`PUT /mobile/profile/company-sim`).
 *
 * A state, not an event: the phone re-sends it until it lands, so it carries no
 * idempotency key — the service writes (and audits) only a change. `confirmedFor` is the
 * 10-digit company number the phone made its choice against, so a choice made before an
 * administrator changed the number is refused rather than stored against the new one.
 * Nothing identifying the SIM card itself is sent or kept.
 */
export const companySimReportSchema = z
  .object({
    status: z.enum(['confirmed', 'declined']),
    /** How the phone identified the SIM. Required for a confirmation. */
    method: z.enum(['number', 'confirmed']).nullable().optional(),
    confirmedFor: z.string().regex(/^\d{10}$/, 'Expected the 10-digit company number.'),
    /** 0-based slot of the chosen SIM. */
    slot: z.coerce.number().int().min(0).max(7).nullable().optional(),
    label: optionalLine(60),
    simCount: z.coerce.number().int().min(0).max(8),
    deviceName: optionalLine(120),
  })
  .refine((value) => value.status !== 'confirmed' || Boolean(value.method), {
    path: ['method'],
    message: 'Say how the company SIM was identified.',
  });

export type CompanySimReportInput = z.infer<typeof companySimReportSchema>;

export const resetPasswordSchema = z.object({
  password: passwordField,
});

/**
 * Self-service password change from the mobile app.
 *
 * Requires the current password even though the caller is already authenticated: an
 * unlocked, unattended handset is the realistic threat, and a password change is the one
 * action that would let someone keep access after the phone is returned.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(200),
  newPassword: passwordField,
});

export const availabilitySchema = z.object({
  availability: z.enum(AVAILABILITY_STATES),
});

export const employeeListQuerySchema = paginationSchema.extend({
  role: z.enum(EMPLOYEE_ROLES).optional(),
  /**
   * Tri-state. Absent means "everyone", which is what the management screen wants;
   * `true` is what an assignment picker wants. A boolean defaulting to true would
   * quietly hide deactivated staff from the screen whose job is to reactivate them.
   */
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /**
   * Filter by approval state, so the management screen can isolate the queue.
   *
   * Distinct from `active`: a pending and a deactivated employee are both inactive, and
   * an admin looking for registrations to approve must not have to wade through
   * ex-employees to find them.
   */
  approval: z.enum(['pending', 'approved', 'rejected']).optional(),
  /**
   * `missing`: working telecallers with no company number, or whose phone has not
   * confirmed the company SIM — the people to chase so their incoming calls are recorded.
   */
  companySim: z.enum(['missing']).optional(),
  q: z.string().trim().max(120).optional(),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

/** Reason shown to the applicant on their next sign-in attempt. */
export const rejectRegistrationSchema = z.object({
  // `nullish`, not `optional`: the admin sends `reason: null` for "reject without one",
  // which the form invites, and `optional` refused that with a 422 nothing could fix.
  reason: z
    .string()
    .trim()
    .max(255, 'Keep the reason under 255 characters.')
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});
