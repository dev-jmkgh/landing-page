import { Router, type Request } from 'express';
import { z } from 'zod';
import { queryOne, type RowDataPacket } from '../../../db/pool';
import { requireHrActor, requireHrRole } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { mobileSyncLimiter } from '../../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { badRequest, forbidden, notFound } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { REGULARISATION_STATUSES } from '../attendance/attendance.schema';
import {
  approve as approveRegularisation,
  findById as findRegularisation,
  reject as rejectRegularisation,
  type Reviewer,
} from '../attendance/regularisation.service';
import { pageQuerySchema } from '../hr.schema';
import { recordHrAppAudit } from '../hrAudit';
import { listRequests } from '../leave/leave.repository';
import {
  decisionSchema,
  teamLeaveQuerySchema,
  teamMembersQuerySchema,
  type DecisionInput,
} from '../leave/leave.schema';
import { decideLeave, findLeaveRequestRow } from '../leave/leave.service';
import { assertCanDecide, listTeamMembers, listTeamRegularisations, teamApprovalCounts } from './team.service';
import { teamScopeFor } from './teamScope';

/**
 * A team manager's view of their direct reports — the HR app, Bearer-only through
 * `requireHrActor`, and `hr_manager` or above for every route.
 *
 * The team is the manager's direct reports, or every other employee for an hr_admin —
 * see `teamScope.ts`. A manager never decides their own requests (403), and a request
 * from outside their team does not exist as far as they can tell (404).
 *
 * Decisions are written with reviewer type 'manager', audited with `recordHrAppAudit`
 * (the admin `recordAudit` needs an admin-portal actor), and the employee is notified by
 * the shared decision code.
 */
export const hrTeamRouter = Router();

hrTeamRouter.use(requireHrActor, requireHrRole('hr_manager'));

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Request not found.');
  return result.data;
}

function reviewerFor(request: Request): Reviewer {
  return { type: 'manager', id: request.hrActor!.id, name: request.hrActor!.name };
}

/** The manager with their employee code, so the audit label names them unambiguously. */
async function auditActor(request: Request) {
  const row = await queryOne<RowDataPacket & { employee_code: string }>(
    'SELECT employee_code FROM hr_users WHERE id = ? LIMIT 1',
    [request.hrActor!.id],
  );
  return { ...request.hrActor!, employeeCode: row?.employee_code };
}

/* -------------------------------------------------------------------------- */
/* Members and counts                                                          */
/* -------------------------------------------------------------------------- */

hrTeamRouter.get(
  '/members',
  validateQuery(teamMembersQuerySchema),
  asyncHandler(async (request, response) => {
    const { q, page, pageSize } = response.locals.query as z.infer<typeof teamMembersQuerySchema>;
    const result = await listTeamMembers(teamScopeFor(request.hrActor!), { q, page, pageSize });
    response.json({ success: true, ...result });
  }),
);

hrTeamRouter.get(
  '/approvals/count',
  asyncHandler(async (request, response) => {
    response.json({ success: true, ...(await teamApprovalCounts(request.hrActor!)) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Leave                                                                       */
/* -------------------------------------------------------------------------- */

hrTeamRouter.get(
  '/leave-requests',
  validateQuery(teamLeaveQuerySchema),
  asyncHandler(async (request, response) => {
    const { status, page, pageSize } = response.locals.query as z.infer<typeof teamLeaveQuerySchema>;
    const result = await listRequests(
      { status, team: teamScopeFor(request.hrActor!), order: 'queue' },
      { page, pageSize },
    );
    response.json({ success: true, ...result });
  }),
);

for (const decision of ['approve', 'reject'] as const) {
  hrTeamRouter.post(
    `/leave-requests/:id/${decision}`,
    mobileSyncLimiter,
    validateBody(decisionSchema),
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id);
      const { note } = request.body as DecisionInput;

      const row = await findLeaveRequestRow(id);
      if (!row) throw notFound('Request not found.');
      await assertCanDecide(teamScopeFor(request.hrActor!), row.user_id);
      // Compensatory leave is an HR decision: an HR administrator here, or the admin portal.
      if (Number(row.type_is_comp_off) === 1 && request.hrActor!.role !== 'hr_admin') {
        throw forbidden('Compensatory leave is decided by HR, not by the team manager.');
      }

      const decided = await decideLeave(id, decision, reviewerFor(request), note);

      await recordHrAppAudit({
        actor: await auditActor(request),
        action: decision === 'approve' ? 'hr_leave_approved' : 'hr_leave_rejected',
        entityType: 'hr_leave_request',
        entityId: id,
        summary: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${decided.leaveType.name} for ${
          decided.employeeName
        } (${decided.startDate}${decided.endDate !== decided.startDate ? ` to ${decided.endDate}` : ''})`,
        meta: { days: decided.days, note, employeeId: decided.userId },
        ipAddress: clientIp(request),
      });

      response.json({ success: true, request: decided });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Attendance corrections                                                      */
/* -------------------------------------------------------------------------- */

const teamRegularisationQuerySchema = pageQuerySchema.extend({
  status: z.enum([...REGULARISATION_STATUSES, 'all']).default('pending'),
});

hrTeamRouter.get(
  '/regularisations',
  validateQuery(teamRegularisationQuerySchema),
  asyncHandler(async (request, response) => {
    const { status, page, pageSize } = response.locals.query as z.infer<typeof teamRegularisationQuerySchema>;
    const result = await listTeamRegularisations(teamScopeFor(request.hrActor!), status, { page, pageSize });
    response.json({ success: true, ...result });
  }),
);

for (const decision of ['approve', 'reject'] as const) {
  hrTeamRouter.post(
    `/regularisations/:id/${decision}`,
    mobileSyncLimiter,
    validateBody(decisionSchema),
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id);
      const { note } = request.body as DecisionInput;

      const existing = await findRegularisation(id);
      if (!existing) throw notFound('Request not found.');
      await assertCanDecide(teamScopeFor(request.hrActor!), existing.userId);

      // The same approve/reject the admin queue uses: it writes the corrected session,
      // recomputes the day and notifies the employee.
      const result =
        decision === 'approve'
          ? await approveRegularisation(id, reviewerFor(request), note)
          : await rejectRegularisation(id, reviewerFor(request), note);
      if (!result.ok) throw badRequest('That request has already been decided.');

      await recordHrAppAudit({
        actor: await auditActor(request),
        action: decision === 'approve' ? 'hr_regularisation_approved' : 'hr_regularisation_rejected',
        entityType: 'hr_regularisation',
        entityId: id,
        summary: `${decision === 'approve' ? 'Approved' : 'Rejected'} attendance correction for ${
          existing.employeeName ?? 'an employee'
        } on ${existing.workDate}`,
        meta: { note, employeeId: existing.userId },
        ipAddress: clientIp(request),
      });

      response.json({ success: true, request: await findRegularisation(id) });
    }),
  );
}
