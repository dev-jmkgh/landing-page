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
};
