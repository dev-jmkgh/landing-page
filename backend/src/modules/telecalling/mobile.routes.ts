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
import { ownershipScope, type Actor } from './actor';
import { mobileAuthRouter } from './auth/mobileAuth.routes';
import { recordActivity } from './activity/activity.repository';
import { listCalls, listLeadCallsPage, setCallFollowedUp } from './calls/call.repository';
import {
  callListQuerySchema,
  logCallBatchSchema,
  logCallSchema,
  myCallListQuerySchema,
  recordCallSchema,
  resolveMissedCallSchema,
  type CallListQuery,
  type MyCallListQuery,
} from './calls/call.schema';
import {
  getCallDetail,
  listMyCallsPage,
  logCall,
  logCallBatch,
  recordCall,
  recordCallByClientUuid,
} from './calls/call.service';
import { employeeActivitySummary, employeeDashboard } from './dashboard/dashboard.repository';
import { findEmployee, setAvailability } from './employees/employee.repository';
import {
  availabilitySchema,
  companySimReportSchema,
  type CompanySimReportInput,
} from './employees/employee.schema';
import { reportCompanySim } from './employees/employee.service';
import { listFollowUps } from './followups/followUp.repository';
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
  listLeadNotesPage,
  listLeads,
  listLeadSources,
  readLeadAttachmentKey,
  setLeadAttachment,
} from './leads/lead.repository';
import {
  createLeadSchema,
  leadHistoryQuerySchema,
  leadListQuerySchema,
  leadLookupSchema,
  leadNoteSchema,
  leadPhoneBatchSchema,
  leadStatusSchema,
  updateLeadSchema,
  type LeadHistoryQuery,
  type LeadListQuery,
} from './leads/lead.schema';
import { addLeadNote, changeLeadStatus, createLead, editLead } from './leads/lead.service';
import { listLeadActivityPage, listLeadPendingFollowUps } from './leads/leadView.repository';
import {
  listNotifications,
  markAllRead,
  markRead,
} from './notifications/notification.repository';
import { dateRangeSchema, paginationSchema, type Paginated } from './shared.schema';

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

/**
 * Which SIM in this phone is the company SIM — or that it is not in this phone.
 *
 * A state the phone re-sends until it lands, so no idempotency key: a repeat changes
 * nothing and writes no second audit entry. 409 `company_number_changed` when the number
 * the phone chose against is no longer the one on file (the employee picks again); 400
 * when no company number has been added yet. Answers with the updated profile.
 */
mobileRouter.put(
  '/profile/company-sim',
  mobileSyncLimiter,
  validateBody(companySimReportSchema),
  asyncHandler(async (request, response) => {
    const employee = await reportCompanySim(
      request.actor!,
      request.body as CompanySimReportInput,
      clientIp(request),
    );
    response.json({ success: true, employee });
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
 * How much of each history the lead screen opens with: about what a reader takes in
 * before scrolling. The rest comes a page at a time from the history routes below, so a
 * lead with years of calls opens as fast as a new one.
 */
const LEAD_SCREEN_FIRST_PAGE = { calls: 10, notes: 10, timeline: 15 } as const;

/**
 * What app builds from before paging are sent instead — the amounts they always got.
 *
 * Those builds read only this response and cannot ask for a second page, so the short
 * first pages above would quietly cut their histories off at ten entries with counts
 * that look complete. A build that pages says so with `?paged=1`.
 */
const LEAD_SCREEN_LEGACY_SIZES = { calls: 50, notes: 100, timeline: 100 } as const;

/** The lead's open follow-ups the screen is sent — open work, a handful on a real lead. */
const LEAD_SCREEN_PENDING_FOLLOW_UPS = 20;

/** A page's position and totals, without its rows. */
function pageInfo({ page, pageSize, total, totalPages }: Paginated<unknown>) {
  return { page, pageSize, total, totalPages };
}

/** 404 unless the lead exists and is within the caller's ownership scope. */
async function assertLeadInScope(id: number, actor: Actor): Promise<void> {
  const lead = await findLead(id, ownershipScope(actor));
  if (!lead) throw notFound('Lead not found.');
}

/**
 * Lead detail with everything the screen needs, in one request.
 *
 * Four queries server-side rather than four HTTP round trips from a handset on a weak
 * connection. The alternative — the client fetching notes, calls, follow-ups and the
 * timeline separately — makes opening a lead feel broken on a slow link and gives four
 * chances for a partial render.
 *
 * Each history is its FIRST page only. They stay plain arrays, as app builds from before
 * paging expect, and `history` gives each one's totals; the screen pages on through
 * GET /leads/:id/calls, /notes and /timeline with the same page size. Builds that page
 * ask with `?paged=1` and get the short first pages; older builds get the amounts they
 * always did (see LEAD_SCREEN_LEGACY_SIZES). `followUps` is the open ones, soonest due
 * first — all the screen shows.
 */
mobileRouter.get(
  '/leads/:id',
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const scope = ownershipScope(request.actor!);

    const lead = await findLead(id, scope);
    if (!lead) throw notFound('Lead not found.');

    const sizes = request.query.paged === '1' ? LEAD_SCREEN_FIRST_PAGE : LEAD_SCREEN_LEGACY_SIZES;

    const [notes, calls, followUps, timeline] = await Promise.all([
      listLeadNotesPage(id, 1, sizes.notes),
      listLeadCallsPage(id, 1, sizes.calls),
      listLeadPendingFollowUps(id, LEAD_SCREEN_PENDING_FOLLOW_UPS),
      listLeadActivityPage(id, 1, sizes.timeline),
    ]);

    response.json({
      success: true,
      lead,
      notes: notes.items,
      calls: calls.items,
      followUps,
      timeline: timeline.items,
      history: { notes: pageInfo(notes), calls: pageInfo(calls), timeline: pageInfo(timeline) },
    });
  }),
);

/*
 * The lead screen's histories, a page at a time, newest first: `page` and `pageSize`
 * (default 20, at most 50). Read-only; each answers 404 for a lead that does not exist or
 * is outside the caller's scope, before reading anything. A page past the end returns
 * the last page, with `page` saying which.
 */
mobileRouter.get(
  '/leads/:id/calls',
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    await assertLeadInScope(id, request.actor!);
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    response.json({ success: true, ...(await listLeadCallsPage(id, page, pageSize)) });
  }),
);

mobileRouter.get(
  '/leads/:id/notes',
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    await assertLeadInScope(id, request.actor!);
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    response.json({ success: true, ...(await listLeadNotesPage(id, page, pageSize)) });
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
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    // Ownership is checked on the lead before the timeline is read; the activity table
    // has no owner column of its own to filter on.
    await assertLeadInScope(id, request.actor!);
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    response.json({ success: true, ...(await listLeadActivityPage(id, page, pageSize)) });
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

/**
 * The same question for a screenful of numbers at once.
 *
 * POST for a read, because the numbers go in a body: a query string of fifty `+91…`
 * values runs into length limits and into `+` meaning a space, and getting that wrong
 * silently returns "no match" — which on this screen means offering to create a lead that
 * already exists.
 *
 * Answers with a map keyed by the string the caller sent, not by a normalised form, so
 * the client can look its own rows up without reimplementing the matching rule. Matching
 * stays here for the same reason it does everywhere else: it is ownership-scoped, and a
 * second copy of that rule on the handset would be a weaker one.
 */
mobileRouter.post(
  '/leads/lookup/by-phones',
  validateBody(leadPhoneBatchSchema),
  asyncHandler(async (request, response) => {
    const { phones } = request.body as z.infer<typeof leadPhoneBatchSchema>;
    const scope = ownershipScope(request.actor!);

    /*
     * De-duplicated before the lookups run. A burst of missed calls from one number is
     * the normal shape of this screen's data, and it would otherwise be the same query
     * repeated once per row.
     */
    const unique: string[] = [...new Set(phones)];
    const found = await Promise.all(unique.map((phone) => findLeadsByPhone(phone, scope)));

    const items: Record<string, { id: number; reference: string; name: string; status: string }[]> =
      {};

    unique.forEach((phone, index) => {
      items[phone] = (found[index] ?? []).map((lead) => ({
        id: lead.id,
        reference: lead.reference,
        name: lead.customerName,
        status: lead.status,
      }));
    });

    response.json({ success: true, items });
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

/**
 * Calls as the Incoming screen and the dashboard's recent calls read them. `line`
 * defaults to the company line, so an older build that never sends it still never lists
 * a personal call; `summary` covers the whole filtered list.
 */
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

/**
 * Saves a call.
 *
 * 201 only when a row was created. A replay (`deduplicated`) and an incoming call set
 * aside because its line could not be verified (`ignored`) are both 200 — and never a
 * 4xx: the offline queue treats a 4xx as permanent, drops the item and tells the
 * employee something they saved was lost, which for a call read from the call log
 * (nothing typed, nothing lost) would be false and alarming.
 */
mobileRouter.post(
  '/calls',
  mobileSyncLimiter,
  validateBody(logCallSchema),
  asyncHandler(async (request, response) => {
    const result = await logCall(request.body as z.infer<typeof logCallSchema>, request.actor!);
    response
      .status(result.deduplicated || result.ignored ? 200 : 201)
      .json({ success: true, ...result });
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
    // return every call the telecaller has ever made. `line` is forced for the same kind
    // of reason: a missed call on a personal SIM is nobody's callback to make.
    const filters: CallListQuery = { ...pagination, pendingCallback: true, line: 'company' };

    const result = await listCalls(filters, ownershipScope(request.actor!));
    response.json({ success: true, ...result });
  }),
);

/**
 * My activity — the signed-in employee's OWN calls, newest first, one page at a time.
 *
 * Own calls whatever the role: unlike `GET /calls`, which shows a supervisor the whole
 * floor, this is a personal history. Keyset-paged: pass the previous page's `nextCursor`
 * as `cursor`. Company-line calls only. `counts` (one figure per filter chip) comes back
 * on a first page that sends `withCounts=true`.
 */
mobileRouter.get(
  '/activity/calls',
  validateQuery(myCallListQuerySchema),
  asyncHandler(async (request, response) => {
    const page = await listMyCallsPage(request.actor!, response.locals.query as MyCallListQuery);
    response.json({ success: true, ...page });
  }),
);

/**
 * One call in full: the call, the notes written on it (the newest 50, with `notesTotal`
 * so a longer history is never cut off silently), the follow-up booked from it, and —
 * for a call not yet filed against a lead — the leads its number matches.
 *
 * Registered AFTER `/calls/pending-callbacks`: Express matches in order, and `:id` would
 * otherwise swallow that path and answer it with a 404.
 */
mobileRouter.get(
  '/calls/:id',
  asyncHandler(async (request, response) => {
    const detail = await getCallDetail(parseId(request.params.id), request.actor!);
    response.json({ success: true, ...detail });
  }),
);

/**
 * Writes up a call addressed by the CALL's client id — for a call saved offline whose
 * server id the handset has not learned yet. The caller's own call, or any call for a
 * supervisor and above; anything else is a 404. Same body, same idempotency and same
 * answer as `/calls/:id/record`.
 */
mobileRouter.post(
  '/calls/by-client/:clientUuid/record',
  mobileSyncLimiter,
  validateBody(recordCallSchema),
  asyncHandler(async (request, response) => {
    const result = await recordCallByClientUuid(
      request.params.clientUuid,
      request.body as z.infer<typeof recordCallSchema>,
      request.actor!,
    );
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

/**
 * Writes up a call the app detected on its own (spec: Incoming calls).
 *
 * Deliberately not `POST /calls`. That endpoint creates, and an incoming call already
 * exists by the time anybody has something to say about it — the app read it out of the
 * handset's log and saved it. Routing this through the create endpoint would either be
 * rejected as a replay, because the client id is derived from the log row and therefore
 * stable, or would insert a second row for one physical call. One row per call, before
 * and after, is what makes a duplicate call record impossible here.
 *
 * Idempotent by the write-up's own `clientUuid`: a retry answers `deduplicated: true` and
 * changes nothing, a second save moves the follow-up booked on the call instead of
 * adding one. Always 200.
 */
mobileRouter.post(
  '/calls/:id/record',
  mobileSyncLimiter,
  validateBody(recordCallSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await recordCall(id, request.body as z.infer<typeof recordCallSchema>, request.actor!);

    response.json({ success: true, ...result });
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
