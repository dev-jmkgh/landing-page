import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { uploadHrDocumentFile } from '../../../middleware/uploadHrDocument';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { badRequest, notFound } from '../../../utils/httpError';
import { describeError, logger } from '../../../utils/logger';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { contentDisposition } from '../files/hrFileLinks';
import { pageQuerySchema } from '../hr.schema';
import { broadcastAnnouncement } from './announcements.service';
import { listDocuments } from './documents.repository';
import { openDocumentForAdmin, removeDocument, shareDocument } from './documents.service';
import { countQueue, findRequest, listComments, listRequests } from './requests.repository';
import {
  adminDocumentListQuerySchema,
  adminRequestListQuerySchema,
  broadcastSchema,
  commentSchema,
  statusChangeSchema,
  uploadDocumentSchema,
  type BroadcastInput,
  type StatusChangeInput,
  type UploadDocumentInput,
} from './requests.schema';
import { addComment, changeStatus, currentProfileValues, requestDetail } from './requests.service';

/**
 * HR requests, shared documents and announcements — admin portal, mounted at `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR (see the note at the top of `hrAdmin.routes.ts`).
 * Reads are `requireRole('supervisor')` unless stated; writes are
 * `requireRole('admin')` plus `requireCsrfForCookieSession`.
 *
 * Every write is audited with `recordAudit` (entity types prefixed `hr_`), and the
 * employee is notified of anything that answers them.
 */
export const hrRequestsAdminRouter = Router();

hrRequestsAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined, what = 'Record'): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound(`${what} not found.`);
  return result.data;
}

/** A state-changing admin route: minimum role, plus CSRF for a browser cookie session. */
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** The queue: `?status&category&userId&q&page&pageSize` — open first, oldest first. */
hrRequestsAdminRouter.get(
  '/requests',
  requireRole('supervisor'),
  validateQuery(adminRequestListQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof adminRequestListQuerySchema>;
    response.json({ success: true, ...(await listRequests(filters, 'queue')) });
  }),
);

/** For a badge: `{ open, inProgress }`. Declared before `/requests/:id`. */
hrRequestsAdminRouter.get(
  '/requests/count',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, ...(await countQueue()) });
  }),
);

/**
 * The request as the app shows it, plus — for a profile update — the employee's
 * CURRENT value of every field it would change (`current`), so HR reviews a diff.
 */
hrRequestsAdminRouter.get(
  '/requests/:id',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const detail = await requestDetail(parseId(request.params.id, 'Request'));
    if (!detail) throw notFound('Request not found.');
    response.json({ success: true, ...detail, current: await currentProfileValues(detail.request) });
  }),
);

hrRequestsAdminRouter.get(
  '/requests/:id/comments',
  requireRole('supervisor'),
  validateQuery(pageQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id, 'Request');
    if (!(await findRequest(id))) throw notFound('Request not found.');
    const paging = response.locals.query as z.infer<typeof pageQuerySchema>;
    response.json({ success: true, ...(await listComments(id, paging)) });
  }),
);

/**
 * Moves a request: `{ status: 'in_progress'|'resolved'|'rejected', note? }`; a
 * rejection needs a note. Resolving a profile update APPLIES it to the employee's
 * record in the same transaction — audited against the employee with before/after.
 */
hrRequestsAdminRouter.post(
  '/requests/:id/status',
  ...write(),
  validateBody(statusChangeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id, 'Request');
    const input = request.body as StatusChangeInput;
    const actor = request.actor!;

    const result = await changeStatus(id, input, { id: actor.id, name: actor.name });
    const subject = `"${result.request.subject}" for ${result.request.employeeName} (${result.request.employeeCode})`;

    await recordAudit({
      actor,
      action:
        input.status === 'resolved'
          ? 'hr_request_resolved'
          : input.status === 'rejected'
            ? 'hr_request_rejected'
            : 'hr_request_in_progress',
      entityType: 'hr_request',
      entityId: id,
      summary: `Moved HR request ${subject} from ${result.from} to ${input.status}`,
      meta: {
        category: result.request.category,
        from: result.from,
        to: input.status,
        ...(input.note ? { note: input.note } : {}),
        ...(result.applied ? { before: result.applied.before, after: result.applied.after } : {}),
      },
      ipAddress: clientIp(request),
    });

    // The employee's record changed: that is an entry on THEIR trail too.
    if (result.applied) {
      await recordAudit({
        actor,
        action: 'hr_profile_update_applied',
        entityType: 'hr_user',
        entityId: result.request.userId,
        summary: `Updated ${Object.keys(result.applied.after).join(', ')} for ${result.request.employeeName} (${result.request.employeeCode}) from HR request #${id}`,
        meta: { requestId: id, before: result.applied.before, after: result.applied.after },
        ipAddress: clientIp(request),
      });
    }

    response.json({ success: true, request: result.request, applied: result.applied });
  }),
);

hrRequestsAdminRouter.post(
  '/requests/:id/comments',
  ...write(),
  validateBody(commentSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id, 'Request');
    const { body } = request.body as z.infer<typeof commentSchema>;
    const actor = request.actor!;

    const result = await addComment(id, { type: 'admin', id: actor.id, name: actor.name }, body);

    if (!result.deduplicated) {
      await recordAudit({
        actor,
        action: 'hr_request_commented',
        entityType: 'hr_request',
        entityId: id,
        summary: `Replied on HR request "${result.request.subject}" for ${result.request.employeeName}`,
        ipAddress: clientIp(request),
      });
    }

    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

/** `?userId&scope=company|personal|all&requestId&q&page&pageSize` — newest first, removed ones never. */
hrRequestsAdminRouter.get(
  '/documents',
  requireRole('supervisor'),
  validateQuery(adminDocumentListQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof adminDocumentListQuerySchema>;
    response.json({ success: true, ...(await listDocuments(filters)) });
  }),
);

/**
 * Shares a document. Multipart: the file in `file` (PDF, PNG or JPEG), and the fields
 * `title`, `category`, `userId` (omit for company-wide) and `requestId`.
 *
 * Role and CSRF run BEFORE the upload middleware, so a caller who may not upload is
 * refused before the body is buffered. A company-wide document notifies every current
 * employee; `recipients` says how many.
 */
hrRequestsAdminRouter.post(
  '/documents',
  ...write(),
  uploadHrDocumentFile,
  validateBody(uploadDocumentSchema),
  asyncHandler(async (request, response) => {
    const fields = request.body as UploadDocumentInput;
    const actor = request.actor!;
    const file = request.file;
    if (!file) throw badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' });

    const result = await shareDocument({ file, fields, actor: { id: actor.id, name: actor.name } });
    const document = result.document;

    await recordAudit({
      actor,
      action: 'hr_document_shared',
      entityType: 'hr_document',
      entityId: document.id,
      summary:
        document.userId === null
          ? `Shared company-wide document "${document.title}"`
          : `Shared document "${document.title}" with ${document.employeeName ?? `employee #${document.userId}`}`,
      meta: {
        scope: document.scope,
        userId: document.userId,
        requestId: document.requestId,
        category: document.category,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        recipients: result.recipients,
      },
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, ...result });
  }),
);

/**
 * Downloads a document: streamed from disk, or a redirect to a URL signed for a minute
 * on S3. A plain GET, so the admin's cookie session works from a link in the portal.
 * Every access is audited — these are personal documents.
 */
hrRequestsAdminRouter.get(
  '/documents/:id/download',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id, 'Document');
    const opened = await openDocumentForAdmin(id);
    if (!opened) throw notFound('This document is no longer available.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_document_downloaded',
      entityType: 'hr_document',
      entityId: id,
      summary: `Opened HR document "${opened.document.title}"`,
      ipAddress: clientIp(request),
    });

    response.setHeader('Cache-Control', 'private, no-store');

    if (opened.download.kind === 'redirect') {
      response.redirect(302, opened.download.url);
      return;
    }

    const download = opened.download;
    response.setHeader('Content-Type', download.mimeType);
    response.setHeader('Content-Length', String(download.contentLength));
    response.setHeader('Content-Disposition', contentDisposition(download.filename));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    download.stream.on('error', (error) => {
      // Headers are already out; all that is left is to end the response and log it.
      logger.warn('HR document stream failed', { id, ...describeError(error) });
      response.destroy(error);
    });
    download.stream.pipe(response);
  }),
);

/** Removes a document — a soft delete: hidden everywhere, never served again. */
hrRequestsAdminRouter.delete(
  '/documents/:id',
  ...write(),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id, 'Document');
    const removed = await removeDocument(id);
    if (!removed) throw notFound('Document not found.');

    await recordAudit({
      actor: request.actor!,
      action: 'hr_document_removed',
      entityType: 'hr_document',
      entityId: id,
      summary: `Removed HR document "${removed.title}"`,
      meta: { scope: removed.scope, userId: removed.userId },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, document: removed });
  }),
);

/* -------------------------------------------------------------------------- */
/* Announcements                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `{ title, body?, departmentId? }` → `{ recipients }`. Every current employee, or one
 * department's. Lands in each person's HR inbox as an `announcement`.
 */
hrRequestsAdminRouter.post(
  '/notifications/broadcast',
  ...write(),
  validateBody(broadcastSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as BroadcastInput;
    const result = await broadcastAnnouncement(input);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_announcement_sent',
      entityType: 'hr_announcement',
      summary: `Sent announcement "${input.title}" to ${result.recipients} ${
        result.departmentName ? `employees in ${result.departmentName}` : 'employees'
      }`,
      meta: {
        title: input.title,
        body: input.body,
        departmentId: input.departmentId ?? null,
        recipients: result.recipients,
      },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, recipients: result.recipients });
  }),
);
