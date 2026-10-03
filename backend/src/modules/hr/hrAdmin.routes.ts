import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../middleware/actor';
import { asyncHandler } from '../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../middleware/validate';
import { badRequest, notFound } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import { recordAudit } from '../telecalling/activity/activity.repository';
import { HR_APPROVAL_STATUSES } from './hr.schema';
import {
  approveHrUser,
  findHrUser,
  listHrUsers,
  rejectHrUser,
  setHrUserActive,
} from './hr.repository';
import { revokeAllHrSessions } from './hrAuth.service';

/**
 * Administration of HR accounts, mounted at `/api/admin/hr`.
 *
 * WHO CAN REACH THIS, and why it is not a contradiction.
 *
 * The HR app cannot touch telecalling, and nothing in `/api/hr` can. But an
 * ADMINISTRATOR manages both products, and there is one admin portal and one set of
 * administrators — so this router authenticates with the existing admin identity
 * (`requireActor` + `requireRole('admin')`), exactly like the telecalling admin router.
 *
 * That is the right direction for the dependency. The separation migration 017
 * establishes is that neither PRODUCT can reach the other's accounts; it was never that
 * an administrator cannot administer both. An HR employee reaching this router is
 * impossible by construction: `requireActor` pins audience `jmk-mobile` on a Bearer
 * token and maps a cookie onto `telecaller_users`, and an HR token is neither.
 *
 * `recordAudit` is reused rather than reimplemented. `audit_logs` is a system-wide
 * trail keyed by a free-text `entity_type`, and an administrator's actions belong in
 * one place regardless of which product they touched — a second audit table would mean
 * "what did this admin do last week?" had two answers.
 */
export const hrAdminRouter = Router();

hrAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/** A state-changing admin route: minimum role, plus CSRF for a browser cookie session. */
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

const listQuerySchema = z.object({
  approval: z.enum(HR_APPROVAL_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * HR accounts, pending first.
 *
 * Supervisor-and-above may READ, so somebody can see that a registration is waiting and
 * chase an admin. Only an admin may DECIDE — see the write routes below. Same split as
 * the telecalling approvals queue, for the same reason: approving an account is not a
 * lesser act than creating one by hand.
 */
hrAdminRouter.get(
  '/registrations',
  requireRole('supervisor'),
  validateQuery(listQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof listQuerySchema>;
    const result = await listHrUsers(filters);
    response.json({ success: true, ...result });
  }),
);

/**
 * Just the pending count, for a badge.
 *
 * Separate from the list because the admin shell polls it, and pulling every pending
 * row to render a number is waste.
 */
hrAdminRouter.get(
  '/registrations/count',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    const result = await listHrUsers({ approval: 'pending', page: 1, pageSize: 1 });
    response.json({ success: true, pending: result.total });
  }),
);

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Approves an HR registration. ADMIN ONLY.
 *
 * The two refusals below are distinguished because they need different actions from the
 * administrator: a non-pending row means somebody already decided, while an unconfirmed
 * address means the applicant still has work to do and chasing the admin will not help.
 */
hrAdminRouter.post(
  '/registrations/:id/approve',
  ...write(),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const employee = await findHrUser(id);
    if (!employee) throw notFound('Registration not found.');

    if (employee.approvalStatus !== 'pending') {
      throw badRequest(
        employee.approvalStatus === 'approved'
          ? 'That registration has already been approved.'
          : 'That registration was rejected. Reopen it first if you want to approve it.',
      );
    }

    /*
     * An unconfirmed address cannot be approved.
     *
     * Checked here for the message, and enforced again in the UPDATE itself, which
     * carries `email_verified_at IS NOT NULL`. The duplication is deliberate: this
     * check is for the human, the one in SQL is the actual guarantee and closes the
     * window between reading and writing. Approving an unverified address would produce
     * an "approved" account whose owner may never have been able to read the mailbox —
     * defeating email verification with one click.
     */
    if (employee.emailVerifiedAt === null) {
      throw badRequest(
        `${employee.name} has not confirmed their email address yet. They need to enter the code sent to ${employee.email} before the account can be approved.`,
      );
    }

    const applied = await approveHrUser(id, request.actor!.id);

    // Lost a race with another administrator, or the address was unverified after all.
    if (!applied) throw badRequest('That registration could not be approved. Reload and retry.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_registration_approved',
      entityType: 'hr_user',
      entityId: id,
      summary: `Approved HR registration for ${employee.name} (${employee.employeeCode})`,
      ipAddress: clientIp(request),
    });

    logger.info('HR registration approved', { id, by: request.actor!.id });

    response.json({ success: true, employee: await findHrUser(id) });
  }),
);

const rejectSchema = z.object({
  /*
   * Optional, but it travels to the applicant verbatim on the pending screen, so it is
   * length-capped and trimmed. The column is VARCHAR(500).
   */
  reason: z
    .string()
    .trim()
    .max(500, 'Keep the reason to 500 characters or fewer.')
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/** Rejects an HR registration. ADMIN ONLY. */
hrAdminRouter.post(
  '/registrations/:id/reject',
  ...write(),
  validateBody(rejectSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { reason } = request.body as { reason: string | null };

    const employee = await findHrUser(id);
    if (!employee) throw notFound('Registration not found.');

    if (employee.approvalStatus !== 'pending') {
      throw badRequest('That registration has already been decided.');
    }

    const applied = await rejectHrUser(id, request.actor!.id, reason);
    if (!applied) throw badRequest('That registration could not be rejected. Reload and retry.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_registration_rejected',
      entityType: 'hr_user',
      entityId: id,
      summary: `Rejected HR registration for ${employee.name} (${employee.employeeCode})`,
      meta: reason ? { reason } : null,
      ipAddress: clientIp(request),
    });

    logger.info('HR registration rejected', { id, by: request.actor!.id });

    response.json({ success: true, employee: await findHrUser(id) });
  }),
);

const activeSchema = z.object({ active: z.boolean() });

/**
 * Switches an approved HR account off, or back on. ADMIN ONLY.
 *
 * Deactivating REVOKES EVERY DEVICE immediately. Without that the employee keeps
 * working until their refresh token expires — up to sixty days — because `is_active` is
 * only re-read when a session is minted or rotated. Access tokens already issued stay
 * valid for their remaining few minutes, which is why they are short.
 */
hrAdminRouter.post(
  '/users/:id/active',
  ...write(),
  validateBody(activeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { active } = request.body as z.infer<typeof activeSchema>;

    const employee = await findHrUser(id);
    if (!employee) throw notFound('Employee not found.');

    const applied = await setHrUserActive(id, active);
    if (!applied) {
      throw badRequest('Only an approved account can be switched on or off.');
    }

    if (!active) await revokeAllHrSessions(id);

    await recordAudit({
      actor: request.actor!,
      action: active ? 'hr_user_activated' : 'hr_user_deactivated',
      entityType: 'hr_user',
      entityId: id,
      summary: `${active ? 'Activated' : 'Deactivated'} HR account ${employee.employeeCode} (${employee.name})`,
      ipAddress: clientIp(request),
    });

    response.json({ success: true, employee: await findHrUser(id) });
  }),
);
