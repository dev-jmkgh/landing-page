import { Router } from 'express';
import { asyncHandler } from '../../../middleware/errorHandler';
import { requireHrActor } from '../../../middleware/hrActor';
import { employeeDashboard } from './dashboard.service';

/**
 * The employee's dashboard summary — the HR app, Bearer-only through `requireHrActor`.
 *
 * One composed response for the home screen rather than seven calls, because the phone
 * opens this screen first and on the worst connection of the day. Every part acts on
 * the SIGNED-IN employee; the `team` part is present only for a team manager and counts
 * only their own team (see `team/teamScope.ts`).
 */
export const hrDashboardRouter = Router();

hrDashboardRouter.use(requireHrActor);

hrDashboardRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    response.json({ success: true, ...(await employeeDashboard(request.hrActor!)) });
  }),
);
