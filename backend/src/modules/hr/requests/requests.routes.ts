import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { mobileSyncLimiter } from '../../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { notFound } from '../../../utils/httpError';
import { pageQuerySchema } from '../hr.schema';
import { findRequest, listComments, listRequests } from './requests.repository';
import {
  commentSchema,
  createRequestSchema,
  requestListQuerySchema,
  type CreateRequestInput,
} from './requests.schema';
import { addComment, cancelRequest, createRequest, requestDetail } from './requests.service';

/**
 * HR requests raised by the employee — the HR app, Bearer-only through `requireHrActor`.
 *
 * Every route acts on the SIGNED-IN employee. There is no user parameter anywhere in
 * this file, and every read passes the token's id as the owner, so another employee's
 * request is "not found" — never "forbidden", which would confirm it exists.
 */
export const hrRequestsRouter = Router();

hrRequestsRouter.use(requireHrActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Request not found.');
  return result.data;
}

/** `?status=open|in_progress|resolved|rejected|cancelled|active|closed&page&pageSize` — newest activity first. */
hrRequestsRouter.get(
  '/',
  validateQuery(requestListQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof requestListQuerySchema>;
    const page = await listRequests({ ...filters, userId: request.hrActor!.id }, 'activity');
    response.json({ success: true, ...page });
  }),
);

/*
 * `mobileSyncLimiter`, as on the attendance writes: these are ordinary app actions, and
 * what is worth bounding is a retry loop. Idempotency is the client key's job.
 */
hrRequestsRouter.post(
  '/',
  mobileSyncLimiter,
  validateBody(createRequestSchema),
  asyncHandler(async (request, response) => {
    const result = await createRequest(request.hrActor!.id, request.body as CreateRequestInput);
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

/** The request, the first page of its timeline (oldest first) and the documents shared on it. */
hrRequestsRouter.get(
  '/:id',
  asyncHandler(async (request, response) => {
    const detail = await requestDetail(parseId(request.params.id), request.hrActor!.id);
    if (!detail) throw notFound('Request not found.');
    response.json({ success: true, ...detail });
  }),
);

hrRequestsRouter.get(
  '/:id/comments',
  validateQuery(pageQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    // Ownership first: the timeline of somebody else's request does not exist for you.
    if (!(await findRequest(id, request.hrActor!.id))) throw notFound('Request not found.');
    const paging = response.locals.query as z.infer<typeof pageQuerySchema>;
    response.json({ success: true, ...(await listComments(id, paging)) });
  }),
);

hrRequestsRouter.post(
  '/:id/comments',
  mobileSyncLimiter,
  validateBody(commentSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { body } = request.body as z.infer<typeof commentSchema>;
    const actor = request.hrActor!;
    const result = await addComment(id, { type: 'employee', id: actor.id }, body, actor.id);
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

hrRequestsRouter.post(
  '/:id/cancel',
  mobileSyncLimiter,
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    response.json({ success: true, request: await cancelRequest(id, request.hrActor!.id) });
  }),
);
