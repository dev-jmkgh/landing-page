import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateQuery } from '../../../middleware/validate';
import { notFound } from '../../../utils/httpError';
import { createHrFileLink } from '../files/hrFileLinks';
import { listDocuments } from './documents.repository';
import { documentForEmployee } from './documents.service';
import { documentListQuerySchema } from './requests.schema';

/**
 * Documents HR has shared with the employee — the HR app, Bearer-only through `requireHrActor`.
 *
 * Every route acts on the SIGNED-IN employee: they see company-wide documents and their
 * own, and nothing else exists for them. The bytes are never served from here — the app
 * asks for a five-minute link (`POST /:id/link`) and hands that to the phone's viewer,
 * which cannot send our Authorization header (see `files/hrFileLinks.ts`).
 */
export const hrDocumentsRouter = Router();

hrDocumentsRouter.use(requireHrActor);

const idParam = z.coerce.number().int().positive();

/** `?scope=company|personal|all&requestId&page&pageSize` — newest first. */
hrDocumentsRouter.get(
  '/',
  validateQuery(documentListQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof documentListQuerySchema>;
    const page = await listDocuments({ ...filters, viewerId: request.hrActor!.id });
    response.json({ success: true, ...page });
  }),
);

/**
 * A link to open the file. Checked here, and checked again when the link is followed —
 * a document removed in between is gone by then.
 */
hrDocumentsRouter.post(
  '/:id/link',
  asyncHandler(async (request, response) => {
    const parsed = idParam.safeParse(request.params.id);
    if (!parsed.success) throw notFound('Document not found.');

    const userId = request.hrActor!.id;
    const document = await documentForEmployee(parsed.data, userId);
    if (!document) throw notFound('Document not found.');

    const link = createHrFileLink({ userId, kind: 'document', id: document.id });
    response.json({ success: true, ...link, document });
  }),
);
