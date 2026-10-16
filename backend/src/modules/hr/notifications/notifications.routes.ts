import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { pageQuerySchema } from '../hr.schema';
import {
  countUnreadHrNotifications,
  listHrNotifications,
  markAllHrNotificationsRead,
  markHrNotificationsRead,
} from './hrNotifications.repository';

/**
 * The employee's HR inbox, mounted at `/api/hr/notifications`.
 *
 * Only ever the signed-in employee's own notifications: there is no user parameter, and
 * every query is scoped by the token's id.
 */
export const hrNotificationsRouter = Router();

hrNotificationsRouter.use(requireHrActor);

const listQuerySchema = pageQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

hrNotificationsRouter.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof listQuerySchema>;
    const userId = request.hrActor!.id;
    const [page, unread] = await Promise.all([
      listHrNotifications(userId, filters),
      countUnreadHrNotifications(userId),
    ]);
    response.json({ success: true, ...page, unread });
  }),
);

/** Just the number, for a badge. Polled on focus, so it must stay one indexed count. */
hrNotificationsRouter.get(
  '/unread-count',
  asyncHandler(async (request, response) => {
    response.json({ success: true, unread: await countUnreadHrNotifications(request.hrActor!.id) });
  }),
);

const readSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

hrNotificationsRouter.post(
  '/read',
  validateBody(readSchema),
  asyncHandler(async (request, response) => {
    const { ids } = request.body as z.infer<typeof readSchema>;
    const userId = request.hrActor!.id;
    const changed = await markHrNotificationsRead(userId, ids);
    response.json({ success: true, changed, unread: await countUnreadHrNotifications(userId) });
  }),
);

hrNotificationsRouter.post(
  '/read-all',
  asyncHandler(async (request, response) => {
    const changed = await markAllHrNotificationsRead(request.hrActor!.id);
    response.json({ success: true, changed, unread: 0 });
  }),
);
