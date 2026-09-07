import { z } from 'zod';
import { normaliseLine } from '../../../utils/text';
import {
  AVAILABILITY_STATES,
  EMPLOYEE_ROLES,
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

export const createEmployeeSchema = z.object({
  name: nameField,
  email: emailField,
  phone: optionalPhoneField,
  password: passwordField,
  role: z.enum(EMPLOYEE_ROLES).default('telecaller'),
  employeeCode: employeeCodeField,
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * Update.
 *
 * Password is absent on purpose — changing someone else's password revokes every one of
 * their devices, so it is a separate, explicitly named endpoint rather than a field that
 * can be sent by accident alongside a phone-number correction.
 */
export const updateEmployeeSchema = z
  .object({
    name: nameField.optional(),
    email: emailField.optional(),
    phone: optionalPhoneField,
    role: z.enum(EMPLOYEE_ROLES).optional(),
    employeeCode: employeeCodeField,
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update.',
  });

export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

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
  q: z.string().trim().max(120).optional(),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;
