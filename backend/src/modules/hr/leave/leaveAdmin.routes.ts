import { Router } from 'express';
import { z } from 'zod';
import { requireActor, requireCsrfForCookieSession, requireRole } from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { queryOne, type RowDataPacket } from '../../../db/pool';
import { badRequest, conflict, notFound } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { companyToday, holidaysBetween } from '../calendar/calendar.service';
import {
  countPendingRequests,
  countRequestsForType,
  deleteAllocation,
  deleteHoliday,
  findHoliday,
  findHolidayOn,
  findLeaveType,
  insertHoliday,
  insertLeaveType,
  leaveTypeClashes,
  listLeaveTypes,
  listRequests,
  updateHoliday,
  updateLeaveType,
  upsertAllocation,
  allocationsFor,
} from './leave.repository';
import {
  adminRequestsQuerySchema,
  allocationQuerySchema,
  allocationSchema,
  createLeaveTypeSchema,
  decisionSchema,
  holidaySchema,
  updateHolidaySchema,
  updateLeaveTypeSchema,
  yearQuerySchema,
  type AllocationInput,
  type CreateLeaveTypeInput,
  type DecisionInput,
  type UpdateLeaveTypeInput,
} from './leave.schema';
import { balancesWithAllocationsFor, decideLeave, findLeaveRequest, humanDate } from './leave.service';

/**
 * Leave types, allocations, requests and holidays — admin portal, mounted at `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR (see the note at the top of `hrAdmin.routes.ts`).
 * Reads are `requireRole('supervisor')`; writes are `requireRole('admin')` plus
 * `requireCsrfForCookieSession`, and every write is audited with `recordAudit`.
 */
export const hrLeaveAdminRouter = Router();

hrLeaveAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/** Minimum role plus CSRF for a cookie session. Same chain the other admin routers use. */
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

const currentYear = () => Number(companyToday().slice(0, 4));

async function findEmployee(userId: number) {
  return queryOne<RowDataPacket & { id: number; name: string; employee_code: string; deleted_at: Date | null }>(
    'SELECT id, name, employee_code, deleted_at FROM hr_users WHERE id = ? LIMIT 1',
    [userId],
  );
}

const NO_QUOTA_FOR_ARRANGEMENTS =
  'Only leave types carry an annual quota. Work from home and field work are never counted against a balance.';

/*
 * Compensatory leave has no quota or allocation to set: its balance is the weekly offs
 * and holidays the employee worked in full, read from attendance (see compOff.service).
 */
const COMP_OFF_NOT_ALLOCATED =
  'Compensatory leave has no quota. It is earned by working a full day on a weekly off or holiday.';

/* -------------------------------------------------------------------------- */
/* Leave types                                                                 */
/* -------------------------------------------------------------------------- */

/** Every type, inactive ones included, so a retired type can be found and re-enabled. */
hrLeaveAdminRouter.get(
  '/leave-types',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listLeaveTypes() });
  }),
);

hrLeaveAdminRouter.post(
  '/leave-types',
  ...write(),
  validateBody(createLeaveTypeSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as CreateLeaveTypeInput;

    if (input.kind !== 'leave' && input.annualQuota !== null) {
      throw badRequest(NO_QUOTA_FOR_ARRANGEMENTS, { annualQuota: NO_QUOTA_FOR_ARRANGEMENTS });
    }

    const clash = await leaveTypeClashes(input.name, input.code, null);
    if (clash.name || clash.code) {
      const errors: Record<string, string> = {};
      if (clash.name) errors.name = 'A leave type with that name already exists.';
      if (clash.code) errors.code = 'A leave type with that code already exists.';
      throw badRequest(errors.name ?? errors.code ?? 'That leave type already exists.', errors);
    }

    const id = await insertLeaveType(input);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_leave_type_created',
      entityType: 'hr_leave_type',
      entityId: id,
      summary: `Created leave type ${input.name} (${input.code})`,
      meta: { kind: input.kind, isPaid: input.isPaid, annualQuota: input.annualQuota },
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, leaveType: await findLeaveType(id) });
  }),
);

/**
 * Edits a type. `annualQuota: null` makes it untracked; `isActive: false` retires it
 * (requests against it keep it in the table — see the RESTRICT key in migration 028).
 *
 * `kind` is frozen once any request uses the type: turning approved annual leave into
 * "work from home" after the fact would silently change payroll for every day booked
 * under it, and the attendance override for every past day.
 */
hrLeaveAdminRouter.patch(
  '/leave-types/:id',
  ...write(),
  validateBody(updateLeaveTypeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as UpdateLeaveTypeInput;

    const current = await findLeaveType(id);
    if (!current) throw notFound('Leave type not found.');

    /*
     * Compensatory leave's rules are what make it work: always leave, one whole day, and
     * no quota (its balance is the days worked). Its name, code, paid flag, order and
     * whether it is offered at all are HR's to change.
     */
    if (current.isCompOff) {
      if (input.kind !== undefined && input.kind !== 'leave') {
        throw badRequest('Compensatory leave is always leave.', { kind: 'Compensatory leave is always leave.' });
      }
      if (input.annualQuota !== undefined && input.annualQuota !== null) {
        throw badRequest(COMP_OFF_NOT_ALLOCATED, { annualQuota: COMP_OFF_NOT_ALLOCATED });
      }
      if (input.allowHalfDay === true) {
        const message = 'Compensatory leave is taken as a whole day, one for each full day worked.';
        throw badRequest(message, { allowHalfDay: message });
      }
    }

    if (input.kind !== undefined && input.kind !== current.kind && (await countRequestsForType(id)) > 0) {
      const message = 'The kind of a leave type cannot change once requests have been made against it.';
      throw badRequest(message, { kind: message });
    }

    const kind = input.kind ?? current.kind;
    const quota = input.annualQuota !== undefined ? input.annualQuota : current.annualQuota;
    if (kind !== 'leave' && quota !== null) {
      throw badRequest(NO_QUOTA_FOR_ARRANGEMENTS, { annualQuota: NO_QUOTA_FOR_ARRANGEMENTS });
    }

    const clash = await leaveTypeClashes(input.name, input.code, id);
    if (clash.name || clash.code) {
      const errors: Record<string, string> = {};
      if (clash.name) errors.name = 'A leave type with that name already exists.';
      if (clash.code) errors.code = 'A leave type with that code already exists.';
      throw badRequest(errors.name ?? errors.code ?? 'That leave type already exists.', errors);
    }

    await updateLeaveType(id, input);
    const updated = (await findLeaveType(id))!;

    // Before/after of the fields that actually changed — the trail a quota change needs.
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(input) as Array<keyof typeof input>) {
      const before = current[key as keyof typeof current];
      const after = updated[key as keyof typeof updated];
      if (before !== after) changed[key] = { from: before, to: after };
    }

    await recordAudit({
      actor: request.actor!,
      action: 'hr_leave_type_updated',
      entityType: 'hr_leave_type',
      entityId: id,
      summary: `Updated leave type ${current.name} (${current.code})`,
      meta: { changed },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, leaveType: updated });
  }),
);

/* -------------------------------------------------------------------------- */
/* Allocations                                                                 */
/* -------------------------------------------------------------------------- */

/** One employee's balances for a year, each with the override behind it, if any. */
hrLeaveAdminRouter.get(
  '/leave-allocations',
  requireRole('supervisor'),
  validateQuery(allocationQuerySchema),
  asyncHandler(async (_request, response) => {
    const { userId, year } = response.locals.query as z.infer<typeof allocationQuerySchema>;
    const employee = await findEmployee(userId);
    if (!employee) throw notFound('Employee not found.');

    const resolved = year ?? currentYear();
    response.json({
      success: true,
      userId,
      year: resolved,
      items: await balancesWithAllocationsFor(userId, resolved),
    });
  }),
);

/**
 * Sets one person's entitlement for one type and year — a pro-rated joiner, a carried
 * balance. `days: null` removes the override, so the type's quota applies again.
 */
hrLeaveAdminRouter.put(
  '/leave-allocations',
  ...write(),
  validateBody(allocationSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as AllocationInput;

    const employee = await findEmployee(input.userId);
    if (!employee) throw notFound('Employee not found.');
    if (employee.deleted_at) {
      throw conflict(`${employee.name} has been deleted, so their leave can no longer be changed.`, 'employee_deleted');
    }

    const type = await findLeaveType(input.leaveTypeId);
    if (!type) throw notFound('Leave type not found.');
    if (type.kind !== 'leave') {
      throw badRequest(NO_QUOTA_FOR_ARRANGEMENTS, { leaveTypeId: NO_QUOTA_FOR_ARRANGEMENTS });
    }
    if (type.isCompOff) {
      throw badRequest(COMP_OFF_NOT_ALLOCATED, { leaveTypeId: COMP_OFF_NOT_ALLOCATED });
    }

    const before = (await allocationsFor(input.userId, input.year)).get(type.id) ?? null;

    if (input.days === null) {
      await deleteAllocation(input.userId, type.id, input.year);
    } else {
      await upsertAllocation({
        userId: input.userId,
        leaveTypeId: type.id,
        year: input.year,
        days: input.days,
        note: input.note,
        updatedBy: request.actor!.id,
      });
    }

    await recordAudit({
      actor: request.actor!,
      action: input.days === null ? 'hr_leave_allocation_removed' : 'hr_leave_allocation_set',
      entityType: 'hr_leave_allocation',
      entityId: input.userId,
      summary:
        input.days === null
          ? `Removed ${type.name} ${input.year} override for ${employee.name} (${employee.employee_code})`
          : `Set ${type.name} ${input.year} to ${input.days} days for ${employee.name} (${employee.employee_code})`,
      meta: {
        userId: input.userId,
        leaveTypeId: type.id,
        year: input.year,
        before: before ? { days: before.days, note: before.note } : null,
        after: input.days === null ? null : { days: input.days, note: input.note },
      },
      ipAddress: clientIp(request),
    });

    const [balance] = await balancesWithAllocationsFor(input.userId, input.year, [type]);
    response.json({ success: true, balance });
  }),
);

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** The queue: pending first and oldest first within them, decided ones after. */
hrLeaveAdminRouter.get(
  '/leave-requests',
  requireRole('supervisor'),
  validateQuery(adminRequestsQuerySchema),
  asyncHandler(async (_request, response) => {
    const { page, pageSize, ...filters } = response.locals.query as z.infer<typeof adminRequestsQuerySchema>;
    const result = await listRequests({ ...filters, order: 'queue' }, { page, pageSize });
    response.json({ success: true, ...result });
  }),
);

/** Just the pending count, for the nav badge. Registered before `/:id`. */
hrLeaveAdminRouter.get(
  '/leave-requests/count',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, pending: await countPendingRequests() });
  }),
);

hrLeaveAdminRouter.get(
  '/leave-requests/:id',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const found = await findLeaveRequest(parseId(request.params.id));
    if (!found) throw notFound('Leave request not found.');
    response.json({ success: true, request: found });
  }),
);

for (const decision of ['approve', 'reject'] as const) {
  hrLeaveAdminRouter.post(
    `/leave-requests/:id/${decision}`,
    ...write(),
    validateBody(decisionSchema),
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id);
      const { note } = request.body as DecisionInput;

      const decided = await decideLeave(
        id,
        decision,
        { type: 'admin', id: request.actor!.id, name: request.actor!.name },
        note,
      );

      await recordAudit({
        actor: request.actor!,
        action: decision === 'approve' ? 'hr_leave_approved' : 'hr_leave_rejected',
        entityType: 'hr_leave_request',
        entityId: id,
        summary: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${decided.leaveType.name} for ${
          decided.employeeName
        } (${decided.startDate}${decided.endDate !== decided.startDate ? ` to ${decided.endDate}` : ''})`,
        meta: { days: decided.days, note },
        ipAddress: clientIp(request),
      });

      response.json({ success: true, request: decided });
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Holidays                                                                    */
/* -------------------------------------------------------------------------- */

hrLeaveAdminRouter.get(
  '/holidays',
  requireRole('supervisor'),
  validateQuery(yearQuerySchema),
  asyncHandler(async (_request, response) => {
    const { year } = response.locals.query as z.infer<typeof yearQuerySchema>;
    const resolved = year ?? currentYear();
    response.json({
      success: true,
      year: resolved,
      items: await holidaysBetween(`${resolved}-01-01`, `${resolved}-12-31`),
    });
  }),
);

function duplicateDate(date: string) {
  const message = `There is already a holiday on ${humanDate(date)}.`;
  return badRequest(message, { date: message });
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/**
 * Adding a holiday reclassifies that date on every calendar at once (it is derived —
 * see calendar.service), but does NOT change the day count of a leave request already
 * raised across it: that count is a snapshot of what was asked for and approved.
 */
hrLeaveAdminRouter.post(
  '/holidays',
  ...write(),
  validateBody(holidaySchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof holidaySchema>;

    if (await findHolidayOn(input.date, null)) throw duplicateDate(input.date);

    let id: number;
    try {
      id = await insertHoliday(input);
    } catch (error) {
      // Two administrators adding the same date at once: the unique key decides.
      if (isDuplicateKey(error)) throw duplicateDate(input.date);
      throw error;
    }

    await recordAudit({
      actor: request.actor!,
      action: 'hr_holiday_created',
      entityType: 'hr_holiday',
      entityId: id,
      summary: `Added holiday ${input.name} on ${input.date}${input.isOptional ? ' (optional)' : ''}`,
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, holiday: await findHoliday(id) });
  }),
);

hrLeaveAdminRouter.patch(
  '/holidays/:id',
  ...write(),
  validateBody(updateHolidaySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as z.infer<typeof updateHolidaySchema>;

    const current = await findHoliday(id);
    if (!current) throw notFound('Holiday not found.');

    if (input.date && (await findHolidayOn(input.date, id))) throw duplicateDate(input.date);

    try {
      await updateHoliday(id, input);
    } catch (error) {
      if (isDuplicateKey(error) && input.date) throw duplicateDate(input.date);
      throw error;
    }
    const updated = (await findHoliday(id))!;

    await recordAudit({
      actor: request.actor!,
      action: 'hr_holiday_updated',
      entityType: 'hr_holiday',
      entityId: id,
      summary: `Updated holiday ${current.name} (${current.date})`,
      meta: { before: current, after: updated },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, holiday: updated });
  }),
);

hrLeaveAdminRouter.delete(
  '/holidays/:id',
  ...write(),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const current = await findHoliday(id);
    if (!current) throw notFound('Holiday not found.');

    await deleteHoliday(id);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_holiday_deleted',
      entityType: 'hr_holiday',
      entityId: id,
      summary: `Removed holiday ${current.name} (${current.date})`,
      meta: { holiday: current },
      ipAddress: clientIp(request),
    });

    response.json({ success: true });
  }),
);
