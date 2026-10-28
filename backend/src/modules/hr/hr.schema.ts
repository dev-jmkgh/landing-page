import { z } from 'zod';

/**
 * Shared vocabulary for the HR module.
 *
 * Deliberately NOT imported from `telecalling/shared.schema`. The two products have
 * separate account tables (see migration 017) and their role sets answer different
 * questions — "may this person assign leads?" versus "may this person approve leave?".
 * Importing one into the other would re-create, in TypeScript, exactly the coupling the
 * schema separation exists to remove: widening the telecalling enum would silently
 * change what an HR token is allowed to claim.
 */

/**
 * HR roles, lowest first.
 *
 * `employee` is the only role self-registration can produce. The other two are granted
 * by an administrator, never requested.
 */
export const HR_ROLES = ['employee', 'hr_manager', 'hr_admin'] as const;
export type HrRole = (typeof HR_ROLES)[number];

export const HR_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type HrApprovalStatus = (typeof HR_APPROVAL_STATUSES)[number];

export const DEVICE_PLATFORMS = ['android', 'ios', 'unknown'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** Employment facts HR records — migration 027. */
export const HR_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export type HrEmploymentType = (typeof HR_EMPLOYMENT_TYPES)[number];

export const HR_EMPLOYMENT_STATUSES = ['probation', 'active', 'notice_period', 'exited'] as const;
export type HrEmploymentStatus = (typeof HR_EMPLOYMENT_STATUSES)[number];

/** A calendar date as the API carries it: `YYYY-MM-DD`, never a timestamp. */
export const isoDateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * Page parameters for every HR list. Small default, hard ceiling — see the standing rule
 * that no list or history is ever fetched whole.
 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** The envelope every paginated HR endpoint returns, beside `success: true`. */
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/**
 * A phone number, or nothing, in every shape a client can express "nothing".
 *
 * Mirrors the rule the telecalling signup uses, and for the same reason: the form labels
 * the field optional and sends `phone.trim() || null` when it is blank, so a plain
 * `.optional()` — which in Zod means `string | undefined` and rejects `null` — refuses a
 * field the UI has just called optional.
 *
 * Copied rather than imported, so the HR module has no dependency on the telecalling
 * one. Four lines of duplication is the cheaper half of that trade.
 */
export const optionalPhoneField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || /^[0-9+\-\s()]{6,20}$/.test(value), {
    message: 'Enter a valid phone number.',
  });

/**
 * The 10-digit national number of an Indian mobile, or null if `value` is not one.
 *
 * Accepts what people type — `+91 98765 43210`, `919876543210`, `09876543210`,
 * `98765-43210` — and requires a mobile (`[6-9]` then nine digits). The same rule the
 * telecalling signup applies to the company SIM, copied rather than imported for the
 * reason given on `optionalPhoneField`.
 */
export function hrMobileKey(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * A required mobile number, stored canonical as `+91XXXXXXXXXX`.
 *
 * Required at self-registration so the person approving an account has a number to
 * reach the applicant on, and canonical so the duplicate check compares like with like.
 */
export const mobileNumberField = z
  .string({
    required_error: 'Enter your mobile number.',
    invalid_type_error: 'Enter your mobile number.',
  })
  .trim()
  .pipe(z.string().min(1, 'Enter your mobile number.'))
  .transform((value, context) => {
    const key = hrMobileKey(value);
    if (!key) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a 10-digit mobile number.' });
      return z.NEVER;
    }
    return `+91${key}`;
  });

/**
 * The employee record the HR app renders.
 *
 * `approvalStatus` and `isActive` are included because the app's launch check branches
 * on them — see the `/me` route, which is where a revoked account is actually caught.
 */
export type HrEmployeeProfile = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: HrRole;
  isActive: boolean;
  approvalStatus: HrApprovalStatus;
  rejectionReason: string | null;
  /**
   * When the applicant confirmed their address, or null if they never have.
   *
   * A timestamp rather than a boolean, because both readers want more than the flag: the
   * profile screen shows the employee WHEN they confirmed, and an administrator looking
   * at a stale pending row wants to know whether it has been sitting unverified for an
   * hour or a fortnight. Code that only needs the flag compares against null.
   */
  emailVerifiedAt: string | null;
  registeredAt: string | null;
  approvedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;

  /*
   * The employee record (migration 027). Every one may be null: an account created
   * before HR recorded these facts has none of them, and the app says "not recorded"
   * rather than substituting something adjacent.
   */
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationName: string | null;
  managerId: number | null;
  managerName: string | null;
  /** `YYYY-MM-DD`. The employment fact HR entered — not when the account was created. */
  joiningDate: string | null;
  exitDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  /**
   * Set when an administrator deleted the employee (migration 038). A deleted account is
   * kept for its history but is in no list, no pay period not yet approved, and cannot
   * sign in.
   */
  deletedAt: string | null;
  deletedByName: string | null;
};
