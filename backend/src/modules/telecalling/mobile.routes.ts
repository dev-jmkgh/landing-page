import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { requireActor } from '../../middleware/actor';
import { asyncHandler } from '../../middleware/errorHandler';
import { mobileSyncLimiter } from '../../middleware/rateLimit';
import {
  leadPhotoContentType,
  uploadLeadPhoto,
  verifyLeadPhotoContents,
} from '../../middleware/uploadLeadPhoto';
import { validateBody, validateQuery } from '../../middleware/validate';
import {
  createDownloadUrl,
  deleteResume,
  openResume,
  putResume,
  supportsPresignedUpload,
} from '../../services/storage';
import { badRequest, notFound } from '../../utils/httpError';
import { describeError, logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import { ownershipScope } from './actor';
import { mobileAuthRouter } from './auth/mobileAuth.routes';
import { listLeadActivity, recordActivity } from './activity/activity.repository';
import { listCalls, listLeadCalls } from './calls/call.repository';
import {
  callListQuerySchema,
  logCallBatchSchema,
  logCallSchema,
  resolveMissedCallSchema,
  type CallListQuery,
} from './calls/call.schema';
import { logCall, logCallBatch } from './calls/call.service';
import { setCallFollowedUp } from './calls/call.repository';
import { employeeActivitySummary, employeeDashboard } from './dashboard/dashboard.repository';
import { findEmployee, setAvailability } from './employees/employee.repository';
import { availabilitySchema } from './employees/employee.schema';
import { listFollowUps, listLeadFollowUps } from './followups/followUp.repository';
import {
  completeFollowUpSchema,
  createFollowUpSchema,
  followUpListQuerySchema,
  rescheduleFollowUpSchema,
  type FollowUpListQuery,
} from './followups/followUp.schema';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  rescheduleFollowUp,
} from './followups/followUp.service';
import {
  findLead,
  findLeadAttachment,
  findLeadsByPhone,
  listLeadNotes,
  listLeads,
  listLeadSources,
  readLeadAttachmentKey,
  setLeadAttachment,
} from './leads/lead.repository';
import {
  createLeadSchema,
  leadListQuerySchema,
  leadLookupSchema,
  leadNoteSchema,
  leadStatusSchema,
  updateLeadSchema,
  type LeadListQuery,
} from './leads/lead.schema';
import { addLeadNote, changeLeadStatus, createLead, editLead } from './leads/lead.service';
import {
  listNotifications,
  markAllRead,
  markRead,
} from './notifications/notification.repository';
import { dateRangeSchema, paginationSchema } from './shared.schema';

/**
 * Everything the mobile app talks to, mounted at `/api/mobile`.
 *
 * A separate router from the admin one even though several handlers are similar,
 * because the two clients differ in ways that would otherwise become `if` statements
 * inside shared handlers:
 *
 *   - Auth: Bearer here, cookie + CSRF there.
 *   - Scope: a telecaller is confined to their own records; an admin is not.
 *   - Shape: the mobile app wants one composed response per screen to save round trips
 *     on a weak connection, where the admin app pages through tables.
 *
 * `ownershipScope(actor)` returns the employee's own id for a telecaller and `null` for
 * a supervisor and above, and is passed into every repository read. A supervisor using
 * the mobile app therefore sees the whole floor here too, which is what they need when
 * they are on it.
 */
export const mobileRouter = Router();

mobileRouter.use('/auth', mobileAuthRouter);

// Everything below requires a signed-in employee.
mobileRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Dashboard and profile (Modules 1, 2, 12)                                    */
/* -------------------------------------------------------------------------- */

mobileRouter.get(
  '/dashboard',
  asyncHandler(async (request, response) => {
    const dashboard = await employeeDashboard(request.actor!.id);
    response.json({ success: true, ...dashboard });
  }),
);

mobileRouter.get(
  '/activity',
  validateQuery(dateRangeSchema),
  asyncHandler(async (request, response) => {
    const summary = await employeeActivitySummary(
      request.actor!.id,
      response.locals.query as z.infer<typeof dateRangeSchema>,
    );
    response.json({ success: true, ...summary });
  }),
);

mobileRouter.patch(
  '/profile/availability',
  validateBody(availabilitySchema),
  asyncHandler(async (request, response) => {
    const { availability } = request.body as z.infer<typeof availabilitySchema>;
    await setAvailability(request.actor!.id, availability);
    const profile = await findEmployee(request.actor!.id);
    response.json({ success: true, employee: profile });
  }),
);

/* -------------------------------------------------------------------------- */
/* Leads (Modules 3, 4, 9, 10)                                                 */
/* -------------------------------------------------------------------------- */

mobileRouter.get(
  '/leads',
  validateQuery(leadListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listLeads(
      response.locals.query as LeadListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

/**
 * Lead detail with everything the screen needs, in one request.
 *
 * Four queries server-side rather than four HTTP round trips from a handset on a weak
 * connection. The alternative — the client fetching notes, calls, follow-ups and the
 * timeline separately — makes opening a lead feel broken on a slow link and gives four
 * chances for a partial render.
 */
mobileRouter.get(
  '/leads/:id',
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const scope = ownershipScope(request.actor!);

    const lead = await findLead(id, scope);
    if (!lead) throw notFound('Lead not found.');

    const [notes, calls, followUps, timeline] = await Promise.all([
      listLeadNotes(id, 100),
      listLeadCalls(id, 50),
      listLeadFollowUps(id),
      listLeadActivity(id, 100),
    ]);

    response.json({ success: true, lead, notes, calls, followUps, timeline });
  }),
);

mobileRouter.post(
  '/leads',
  mobileSyncLimiter,
  validateBody(createLeadSchema),
  asyncHandler(async (request, response) => {
    const result = await createLead(
      request.body as z.infer<typeof createLeadSchema>,
      request.actor!,
      clientIp(request),
    );

    // 200 rather than 201 on a deduplicated retry: nothing was created this time, and
    // the client should not treat it as a new record.
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

mobileRouter.patch(
  '/leads/:id',
  mobileSyncLimiter,
  validateBody(updateLeadSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const lead = await editLead(id, request.body as z.infer<typeof updateLeadSchema>, request.actor!);
    response.json({ success: true, lead });
  }),
);

mobileRouter.post(
  '/leads/:id/status',
  mobileSyncLimiter,
  validateBody(leadStatusSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await changeLeadStatus(
      id,
      request.body as z.infer<typeof leadStatusSchema>,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
  }),
);

mobileRouter.post(
  '/leads/:id/notes',
  mobileSyncLimiter,
  validateBody(leadNoteSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await addLeadNote(
      id,
      request.body as z.infer<typeof leadNoteSchema>,
      request.actor!,
    );
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

mobileRouter.get(
  '/leads/:id/timeline',
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    // Ownership is checked on the lead before the timeline is read; the activity table
    // has no owner column of its own to filter on.
    const lead = await findLead(id, ownershipScope(request.actor!));
    if (!lead) throw notFound('Lead not found.');

    response.json({ success: true, items: await listLeadActivity(id, 200) });
  }),
);

/**
 * Who is this number?
 *
 * Called when the handset rings with a number the telecaller does not recognise, so the
 * app can show the customer's name and history before they answer. Returns a list —
 * two leads can share a number, and guessing which one would put a conversation in the
 * wrong customer's history.
 */
mobileRouter.get(
  '/leads/lookup/by-phone',
  validateQuery(leadLookupSchema),
  asyncHandler(async (request, response) => {
    const { phone } = response.locals.query as z.infer<typeof leadLookupSchema>;
    const matches = await findLeadsByPhone(phone, ownershipScope(request.actor!));
    response.json({ success: true, items: matches });
  }),
);

/** Source options for the create-lead form, so the app never hard-codes them. */
mobileRouter.get(
  '/lead-sources',
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listLeadSources(true) });
  }),
);

/**
 * Attaches a photo of a paper lead (spec: Mobile Module 4).
 *
 * A second request after the lead is created, rather than a multipart create. Two
 * reasons, both about what happens on a bad connection: the typed fields — the part that
 * cannot be re-derived — reach the server in a small JSON request that succeeds on a weak
 * link, and a failed photo upload then costs a retry rather than the whole lead. The
 * telecaller has the paper in front of them and can re-photograph it; they cannot retype
 * a form they have already moved on from.
 *
 * The photo replaces any existing one. A lead has one source document, and keeping a
 * history of superseded photographs of the same sheet is storage nobody will ever read.
 */
mobileRouter.post(
  '/leads/:id/attachment',
  mobileSyncLimiter,
  uploadLeadPhoto,
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    // Ownership first, before a byte is stored: a telecaller must not be able to write
    // an attachment onto someone else's lead by guessing an id.
    const lead = await findLead(id, ownershipScope(request.actor!));
    if (!lead) throw notFound('Lead not found.');

    const file = request.file;
    if (!file) throw badRequest('Attach a photo of the lead.', { photo: 'No file received.' });

    // Verified before storing, so a mismatched file is never written anywhere and no
    // database row ever points at it.
    if (!verifyLeadPhotoContents(file.buffer, file.originalname)) {
      throw badRequest('That file does not look like an image.', {
        photo: 'Attach a JPEG, PNG, WebP or HEIC image.',
      });
    }

    const contentType = leadPhotoContentType(file.originalname);
    const extension = path.extname(file.originalname).toLowerCase();

    const stored = await putResume({ buffer: file.buffer, extension, contentType });

    const previousKey = await readLeadAttachmentKey(id);
    await setLeadAttachment(id, stored.key, contentType);

    /**
     * The superseded file is deleted after the row points at the new one, not before.
     * If the delete fails the lead still has a working attachment — an orphaned object
     * costs a few kilobytes, whereas the other order can leave a lead pointing at a file
     * that no longer exists.
     */
    if (previousKey && previousKey !== stored.key) {
      await deleteResume(previousKey).catch((error) =>
        logger.warn('Could not delete the replaced lead attachment', {
          leadId: id,
          ...describeError(error),
        }),
      );
    }

    await recordActivity({
      leadId: id,
      userId: request.actor!.id,
      type: 'lead_updated',
      summary: `${request.actor!.name} attached a photo of the paper lead`,
      meta: { contentType, sizeBytes: file.size },
    });

    logger.info('Lead attachment stored', { leadId: id, sizeBytes: file.size });

    response.status(201).json({ success: true, hasAttachment: true });
  }),
);

/**
 * Serves the attached photo back.
 *
 * Same pattern as the resume download and the admin attachment route: the file lives
 * outside any web root, and this authenticated, ownership-checked route is the only way
 * to read it. On S3 the client follows a URL signed for sixty seconds instead of the
 * bytes being proxied through this process.
 */
mobileRouter.get(
  '/leads/:id/attachment',
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const attachment = await findLeadAttachment(id, ownershipScope(request.actor!));
    if (!attachment) throw notFound('No attachment on this lead.');

    if (supportsPresignedUpload()) {
      response.redirect(302, await createDownloadUrl(attachment.key, `${attachment.reference}-lead`));
      return;
    }

    const opened = await openResume(attachment.key);
    if (!opened) throw notFound('The attachment is no longer available.');

    response.setHeader('Content-Type', attachment.mime ?? 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    opened.stream.pipe(response);
  }),
);

/* -------------------------------------------------------------------------- */
/* Calls (Modules 5, 7)                                                        */
/* -------------------------------------------------------------------------- */

mobileRouter.get(
  '/calls',
  validateQuery(callListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listCalls(
      response.locals.query as CallListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

mobileRouter.post(
  '/calls',
  mobileSyncLimiter,
  validateBody(logCallSchema),
  asyncHandler(async (request, response) => {
    const result = await logCall(request.body as z.infer<typeof logCallSchema>, request.actor!);
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

/**
 * Batch endpoint for the offline queue.
 *
 * Always answers 200, even when some entries failed. The client needs the per-entry
 * verdict to know what to drop and what to retry; a 4xx for the whole batch would make
 * it retry the entries that already succeeded.
 */
mobileRouter.post(
  '/calls/batch',
  mobileSyncLimiter,
  validateBody(logCallBatchSchema),
  asyncHandler(async (request, response) => {
    const { calls } = request.body as z.infer<typeof logCallBatchSchema>;
    const result = await logCallBatch(calls, request.actor!);
    response.json({ success: true, ...result });
  }),
);

/** The callback queue: unanswered calls nobody has come back to. */
mobileRouter.get(
  '/calls/pending-callbacks',
  validateQuery(paginationSchema),
  asyncHandler(async (request, response) => {
    const pagination = response.locals.query as z.infer<typeof paginationSchema>;

    // `pendingCallback` is forced rather than read from the query: this endpoint *is*
    // the callback queue, and letting a client turn the filter off would quietly make it
    // return every call the telecaller has ever made.
    const filters: CallListQuery = { ...pagination, pendingCallback: true };

    const result = await listCalls(filters, ownershipScope(request.actor!));
    response.json({ success: true, ...result });
  }),
);

mobileRouter.patch(
  '/calls/:id/followed-up',
  mobileSyncLimiter,
  validateBody(resolveMissedCallSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { followedUp } = request.body as z.infer<typeof resolveMissedCallSchema>;

    const updated = await setCallFollowedUp(id, followedUp, ownershipScope(request.actor!));
    if (!updated) throw notFound('Call not found.');

    response.json({ success: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Follow-ups (Module 8)                                                       */
/* -------------------------------------------------------------------------- */

mobileRouter.get(
  '/follow-ups',
  validateQuery(followUpListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listFollowUps(
      response.locals.query as FollowUpListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

mobileRouter.post(
  '/follow-ups',
  mobileSyncLimiter,
  validateBody(createFollowUpSchema),
  asyncHandler(async (request, response) => {
    const result = await createFollowUp(
      request.body as z.infer<typeof createFollowUpSchema>,
      request.actor!,
    );
    response.status(result.deduplicated ? 200 : 201).json({ success: true, ...result });
  }),
);

mobileRouter.post(
  '/follow-ups/:id/complete',
  mobileSyncLimiter,
  validateBody(completeFollowUpSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { outcomeNote } = request.body as z.infer<typeof completeFollowUpSchema>;
    const followUp = await completeFollowUp(id, outcomeNote, request.actor!);
    response.json({ success: true, followUp });
  }),
);

mobileRouter.post(
  '/follow-ups/:id/reschedule',
  mobileSyncLimiter,
  validateBody(rescheduleFollowUpSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { dueAt, note } = request.body as z.infer<typeof rescheduleFollowUpSchema>;
    const followUp = await rescheduleFollowUp(id, dueAt, note, request.actor!);
    response.json({ success: true, followUp });
  }),
);

mobileRouter.post(
  '/follow-ups/:id/cancel',
  mobileSyncLimiter,
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const followUp = await cancelFollowUp(id, request.actor!);
    response.json({ success: true, followUp });
  }),
);

/* -------------------------------------------------------------------------- */
/* Notifications (Module 11)                                                   */
/* -------------------------------------------------------------------------- */

const notificationQuerySchema = paginationSchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

mobileRouter.get(
  '/notifications',
  validateQuery(notificationQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof notificationQuerySchema>;
    const result = await listNotifications(request.actor!.id, filters);
    response.json({ success: true, ...result });
  }),
);

const markReadSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).max(200).optional(),
  all: z.boolean().default(false),
});

mobileRouter.post(
  '/notifications/read',
  validateBody(markReadSchema),
  asyncHandler(async (request, response) => {
    const { ids, all } = request.body as z.infer<typeof markReadSchema>;

    if (!all && (!ids || ids.length === 0)) {
      throw badRequest('Send either a list of ids or all: true.');
    }

    // Both paths are scoped to the caller's own user id in the repository, so a guessed
    // id cannot mark someone else's notification read.
    const updated = all
      ? await markAllRead(request.actor!.id)
      : await markRead(request.actor!.id, ids ?? []);

    response.json({ success: true, updated });
  }),
);
