import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { mobileSyncLimiter } from '../../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { notFound } from '../../../utils/httpError';
import { companyToday, holidaysBetween } from '../calendar/calendar.service';
import { listLeaveTypes, listRequests } from './leave.repository';
import {
  applySchema,
  myRequestsQuerySchema,
  previewQuerySchema,
  yearQuerySchema,
  type ApplyInput,
} from './leave.schema';
import {
  applyForLeave,
  balancesFor,
  cancelLeave,
  findLeaveRequest,
  previewLeave,
} from './leave.service';

/**
 * Leave and holidays for the employee — the HR app, Bearer-only through `requireHrActor`.
 *
 * Every route acts on the SIGNED-IN employee. There is no `userId` parameter anywhere in
 * this file, for the reason given in attendance.routes: the way to guarantee somebody
 * reads only their own leave is for the endpoint to have no way to name anybody else.
 * Deciding a colleague's leave is a team route (`/api/hr/team`), which checks the
 * reporting line itself.
 */
export const hrLeaveRouter = Router();

hrLeaveRouter.use(requireHrActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Leave request not found.');
  return result.data;
}

/** The year asked for, else the company's current year (not the server's). */
const yearOf = (year: number | undefined) => year ?? Number(companyToday().slice(0, 4));

/** Active types, for the apply form's picker. */
hrLeaveRouter.get(
  '/types',
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listLeaveTypes({ activeOnly: true }) });
  }),
);

/**
 * Balances for every active leave type. An untracked type is listed with
 * `tracked: false` and null `entitled` / `available` — the app shows no number for it.
 */
hrLeaveRouter.get(
  '/balances',
  validateQuery(yearQuerySchema),
  asyncHandler(async (request, response) => {
    const { year } = response.locals.query as z.infer<typeof yearQuerySchema>;
    const resolved = yearOf(year);
    response.json({ success: true, year: resolved, items: await balancesFor(request.hrActor!.id, resolved) });
  }),
);

/** What an application would cost and whether it would be accepted, without making it. */
hrLeaveRouter.get(
  '/preview',
  validateQuery(previewQuerySchema),
  asyncHandler(async (request, response) => {
    const input = response.locals.query as z.infer<typeof previewQuerySchema>;
    const preview = await previewLeave(request.hrActor!.id, {
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate ?? input.startDate,
      halfDay: input.halfDay,
    });
    response.json({ success: true, ...preview });
  }),
);

hrLeaveRouter.get(
  '/requests',
  validateQuery(myRequestsQuerySchema),
  asyncHandler(async (request, response) => {
    const { status, page, pageSize } = response.locals.query as z.infer<typeof myRequestsQuerySchema>;
    const result = await listRequests(
      { userId: request.hrActor!.id, status, order: 'newest' },
      { page, pageSize },
    );
    response.json({ success: true, ...result });
  }),
);

hrLeaveRouter.get(
  '/requests/:id',
  asyncHandler(async (request, response) => {
    const found = await findLeaveRequest(parseId(request.params.id));
    // Somebody else's request is "not found", not "forbidden": its existence is not
    // this employee's business either.
    if (!found || found.userId !== request.hrActor!.id) throw notFound('Leave request not found.');
    response.json({ success: true, request: found });
  }),
);

/**
 * Applies. 201 with the new request, or 200 with `deduplicated: true` when the client
 * key has been seen before — a retry of a submission that already went through.
 */
hrLeaveRouter.post(
  '/requests',
  mobileSyncLimiter,
  validateBody(applySchema),
  asyncHandler(async (request, response) => {
    const input = request.body as ApplyInput;
    const result = await applyForLeave(request.hrActor!.id, input);
    response.status(result.deduplicated ? 200 : 201).json({
      success: true,
      request: result.request,
      deduplicated: result.deduplicated,
    });
  }),
);

hrLeaveRouter.post(
  '/requests/:id/cancel',
  mobileSyncLimiter,
  asyncHandler(async (request, response) => {
    const cancelled = await cancelLeave(request.hrActor!.id, parseId(request.params.id));
    response.json({ success: true, request: cancelled });
  }),
);

/** A year of holidays, optional ones included and marked. Bounded by the calendar. */
hrLeaveRouter.get(
  '/holidays',
  validateQuery(yearQuerySchema),
  asyncHandler(async (_request, response) => {
    const { year } = response.locals.query as z.infer<typeof yearQuerySchema>;
    const resolved = yearOf(year);
    response.json({
      success: true,
      year: resolved,
      items: await holidaysBetween(`${resolved}-01-01`, `${resolved}-12-31`),
    });
  }),
);
