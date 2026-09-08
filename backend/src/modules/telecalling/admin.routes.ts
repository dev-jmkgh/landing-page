import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../middleware/actor';
import { asyncHandler } from '../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../middleware/validate';
import { createDownloadUrl, openResume, supportsPresignedUpload } from '../../services/storage';
import { badRequest, notFound } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import { ownershipScope } from './actor';
import {
  listAuditLogs,
  listEmployeeActivity,
  listLeadActivity,
  recordAudit,
} from './activity/activity.repository';
import {
  findRecordingKey,
  listCalls,
  listLeadCalls,
  listRecordings,
} from './calls/call.repository';
import { callListQuerySchema, type CallListQuery } from './calls/call.schema';
import {
  adminDashboard,
  callTrend,
  employeeActivitySummary,
  employeePerformance,
  followUpPerformance,
  leadBreakdown,
  overdueByEmployee,
} from './dashboard/dashboard.repository';
import {
  approveRegistration,
  countOpenLeads,
  countPendingRegistrations,
  findEmployee,
  listAssignableEmployees,
  listEmployees,
  listPendingRegistrations,
  reopenRegistration,
  rejectRegistration,
} from './employees/employee.repository';
import {
  createEmployeeSchema,
  employeeListQuerySchema,
  rejectRegistrationSchema,
  resetPasswordSchema,
  updateEmployeeSchema,
  type EmployeeListQuery,
} from './employees/employee.schema';
import {
  createEmployee,
  editEmployee,
  resetEmployeePassword,
} from './employees/employee.service';
import {
  listFollowUps,
  listLeadFollowUps,
  reassignPendingFollowUps,
} from './followups/followUp.repository';
import {
  createFollowUpSchema,
  editFollowUpSchema,
  followUpListQuerySchema,
  rescheduleFollowUpSchema,
  type FollowUpListQuery,
} from './followups/followUp.schema';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  editFollowUp,
  rescheduleFollowUp,
} from './followups/followUp.service';
import {
  deleteLead,
  findLead,
  findLeadAttachment,
  listLeadNotes,
  listLeads,
  listLeadSources,
  upsertLeadSource,
} from './leads/lead.repository';
import {
  assignLeadSchema,
  bulkAssignSchema,
  createLeadSchema,
  leadListQuerySchema,
  leadNoteSchema,
  leadStatusSchema,
  updateLeadSchema,
  type LeadListQuery,
} from './leads/lead.schema';
import {
  addLeadNote,
  assignLead,
  bulkAssignLeads,
  changeLeadStatus,
  createLead,
  editLead,
  setLeadArchived,
} from './leads/lead.service';
import { queueNotifications } from './notifications/notification.repository';
import {
  listSettings,
  readNumberSetting,
  WRITABLE_SETTING_KEYS,
  writeSetting,
} from './settings/settings.repository';
import { dateRangeSchema, paginationSchema } from './shared.schema';

/**
 * Admin telecalling routes, mounted at `/api/admin/telecalling`.
 *
 * Every route requires an authenticated actor. State-changing routes additionally
 * require CSRF *when the caller authenticated with a cookie* — a browser attaches a
 * cookie by itself, so the cookie alone does not prove intent. A Bearer token is never
 * attached automatically and cannot be read cross-origin, so the check is skipped there;
 * see `requireCsrfForCookieSession` for why that is not a bypass.
 *
 * This router is reachable by both clients: an admin in a browser, and a supervisor or
 * manager using the mobile app while they are on the floor.
 *
 * Role requirements are stated per route with `requireRole`. They are on the route and
 * never inferred from what the UI rendered: a hidden button is not an access control,
 * and both clients reach the same API.
 */
export const telecallingAdminRouter = Router();

telecallingAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/**
 * Middleware chain for a state-changing admin route: a minimum role, plus CSRF for a
 * browser's cookie session. `requireCsrfForCookieSession` skips the CSRF check for a
 * Bearer caller, where it would protect nothing — see the middleware for why that is
 * not a bypass.
 */
const write = (minimum: 'supervisor' | 'manager' | 'admin') => [
  requireRole(minimum),
  requireCsrfForCookieSession,
];

/* -------------------------------------------------------------------------- */
/* Dashboard (Module 2)                                                        */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/dashboard',
  requireRole('supervisor'),
  validateQuery(dateRangeSchema),
  asyncHandler(async (_request, response) => {
    const range = response.locals.query as z.infer<typeof dateRangeSchema>;

    const [dashboard, performance, overdue, pendingRegistrations] = await Promise.all([
      adminDashboard(range),
      employeePerformance(range),
      // The alert threshold is a setting, so an operations team can decide how long an
      // overdue follow-up may sit before it is worth interrupting someone over.
      readNumberSetting('followup.overdue_alert_hours', 24).then((hours) =>
        overdueByEmployee(hours),
      ),
      /*
       * Surfaced on the dashboard because otherwise nothing tells an admin a registration
       * is waiting — they would have to go and look at the employees screen on the off
       * chance, and a telecaller who cannot sign in would just be stuck.
       */
      countPendingRegistrations(),
    ]);

    response.json({
      success: true,
      ...dashboard,
      employees: performance,
      overdueByEmployee: overdue,
      pendingRegistrations,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Employees (Module 3)                                                       */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/employees',
  requireRole('supervisor'),
  validateQuery(employeeListQuerySchema),
  asyncHandler(async (_request, response) => {
    const result = await listEmployees(response.locals.query as EmployeeListQuery);
    response.json({ success: true, ...result });
  }),
);

/** Unpaginated active staff, for assignment pickers. */
telecallingAdminRouter.get(
  '/employees/assignable',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listAssignableEmployees() });
  }),
);

telecallingAdminRouter.get(
  '/employees/:id',
  requireRole('supervisor'),
  validateQuery(dateRangeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const employee = await findEmployee(id);
    if (!employee) throw notFound('Employee not found.');

    const range = response.locals.query as z.infer<typeof dateRangeSchema>;

    const [summary, openLeads, activity] = await Promise.all([
      employeeActivitySummary(id, range),
      countOpenLeads(id),
      listEmployeeActivity(id, 100),
    ]);

    response.json({ success: true, employee, summary, openLeads, activity });
  }),
);

telecallingAdminRouter.post(
  '/employees',
  ...write('admin'),
  validateBody(createEmployeeSchema),
  asyncHandler(async (request, response) => {
    const employee = await createEmployee(
      request.body as z.infer<typeof createEmployeeSchema>,
      request.actor!,
      clientIp(request),
    );
    response.status(201).json({ success: true, employee });
  }),
);

telecallingAdminRouter.patch(
  '/employees/:id',
  ...write('admin'),
  validateBody(updateEmployeeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const employee = await editEmployee(
      id,
      request.body as z.infer<typeof updateEmployeeSchema>,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, employee });
  }),
);

telecallingAdminRouter.post(
  '/employees/:id/password',
  ...write('admin'),
  validateBody(resetPasswordSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { password } = request.body as z.infer<typeof resetPasswordSchema>;
    await resetEmployeePassword(id, password, request.actor!, clientIp(request));
    response.json({ success: true });
  }),
);

/**
 * Moves every pending follow-up from one employee to another.
 *
 * The action an admin needs when someone resigns or goes on leave, and the reason
 * `follow_ups.assigned_to` is separate from `leads.assigned_to`: the commitments can be
 * covered for a fortnight without permanently transferring ownership of the leads.
 */
const handoverSchema = z.object({
  toEmployeeId: z.coerce.number().int().positive(),
});

telecallingAdminRouter.post(
  '/employees/:id/handover-follow-ups',
  ...write('manager'),
  validateBody(handoverSchema),
  asyncHandler(async (request, response) => {
    const fromId = parseId(request.params.id);
    const { toEmployeeId } = request.body as z.infer<typeof handoverSchema>;

    if (fromId === toEmployeeId) throw badRequest('Choose a different employee.');

    const [from, to] = await Promise.all([findEmployee(fromId), findEmployee(toEmployeeId)]);
    if (!from) throw notFound('Employee not found.');
    if (!to) throw badRequest('The chosen employee does not exist.');
    if (!to.isActive) throw badRequest('That employee is deactivated.');

    const moved = await reassignPendingFollowUps(fromId, toEmployeeId);

    await recordAudit({
      actor: request.actor!,
      action: 'follow_ups_handed_over',
      entityType: 'employee',
      entityId: fromId,
      summary: `Moved ${moved} pending follow-up(s) from ${from.name} to ${to.name}`,
      meta: { from: fromId, to: toEmployeeId, moved },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, moved });
  }),
);


/* -------------------------------------------------------------------------- */
/* Self-registration approvals (Module 1 — user access management)             */
/* -------------------------------------------------------------------------- */

/**
 * The pending-registration queue.
 *
 * Supervisor-and-above may READ it, so a supervisor can see that someone is waiting and
 * chase an admin. Only an admin may decide — see the write routes below.
 */
telecallingAdminRouter.get(
  '/registrations',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    const items = await listPendingRegistrations();
    response.json({ success: true, items, total: items.length });
  }),
);

/**
 * Just the count, for a badge.
 *
 * Separate from the list because the admin shell polls this to decide whether to show a
 * "N waiting" indicator, and pulling every pending row to render a number is waste.
 */
telecallingAdminRouter.get(
  '/registrations/count',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, pending: await countPendingRegistrations() });
  }),
);

/**
 * Approves a registration. ADMIN ONLY.
 *
 * Matching `POST /employees`, because that is what this is: approving a self-registration
 * creates a working employee account with access to every customer record its owner is
 * assigned. It is not a lesser act than creating one by hand, so it does not get a lesser
 * permission.
 */
telecallingAdminRouter.post(
  '/registrations/:id/approve',
  ...write('admin'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const employee = await findEmployee(id);
    if (!employee) throw notFound('Registration not found.');

    if (employee.approvalStatus !== 'pending') {
      throw badRequest(
        employee.approvalStatus === 'approved'
          ? 'That registration has already been approved.'
          : 'That registration was rejected. Reopen it first if you want to approve it.',
      );
    }

    /*
     * An unconfirmed email address cannot be approved.
     *
     * This is the gate that makes verification mandatory rather than advisory. Sign-in
     * already refuses an unverified account, but without this an administrator could
     * approve one — and would then have an "approved" employee who still cannot sign in,
     * with nothing on either screen explaining why.
     *
     * It also means approving is a decision about a person who has demonstrably read
     * mail at that address, rather than about an address somebody typed. A typo'd
     * registration can never become a live account by being clicked through.
     *
     * Refusing rather than silently marking it verified: only the applicant can prove
     * they control the mailbox, and an administrator clicking Approve is not that proof.
     */
    if (employee.emailVerifiedAt === null) {
      throw badRequest(
        `${employee.name} has not confirmed their email address yet. They need to enter the code sent to ${employee.email} before the account can be approved.`,
      );
    }

    const applied = await approveRegistration(id, request.actor!.id);
    if (!applied) {
      // Lost a race with another admin deciding the same registration.
      throw badRequest('That registration was just decided by someone else. Refresh and check.');
    }

    await recordAudit({
      actor: request.actor!,
      action: 'registration_approved',
      entityType: 'employee',
      entityId: id,
      summary: `Approved the registration of ${employee.name} (${employee.employeeCode})`,
      meta: { email: employee.email, registeredAt: employee.registeredAt },
      ipAddress: clientIp(request),
    });

    logger.info('Registration approved', {
      id,
      employeeCode: employee.employeeCode,
      by: request.actor!.email,
    });

    response.json({ success: true, employee: await findEmployee(id) });
  }),
);

/**
 * Rejects a registration. ADMIN ONLY.
 *
 * The row is kept, not deleted — the applicant is shown the reason on their next sign-in
 * attempt rather than being left to guess, and the retained row stops the same address
 * re-registering straight back into the queue.
 */
telecallingAdminRouter.post(
  '/registrations/:id/reject',
  ...write('admin'),
  validateBody(rejectRegistrationSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { reason } = request.body as z.infer<typeof rejectRegistrationSchema>;

    const employee = await findEmployee(id);
    if (!employee) throw notFound('Registration not found.');

    if (employee.approvalStatus !== 'pending') {
      throw badRequest('That registration has already been decided.');
    }

    const applied = await rejectRegistration(id, request.actor!.id, reason);
    if (!applied) {
      throw badRequest('That registration was just decided by someone else. Refresh and check.');
    }

    await recordAudit({
      actor: request.actor!,
      action: 'registration_rejected',
      entityType: 'employee',
      entityId: id,
      summary: `Rejected the registration of ${employee.name} (${employee.employeeCode})`,
      meta: { email: employee.email, reason },
      ipAddress: clientIp(request),
    });

    logger.info('Registration rejected', { id, by: request.actor!.email });

    response.json({ success: true, employee: await findEmployee(id) });
  }),
);

/**
 * Puts a rejected registration back in the queue. ADMIN ONLY.
 *
 * Exists because rejection is otherwise a dead end: the retained row blocks the address
 * from re-registering, so an admin who rejects the wrong person would have no route back
 * without editing the database.
 */
telecallingAdminRouter.post(
  '/registrations/:id/reopen',
  ...write('admin'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const employee = await findEmployee(id);
    if (!employee) throw notFound('Registration not found.');
    if (employee.approvalStatus !== 'rejected') {
      throw badRequest('Only a rejected registration can be reopened.');
    }

    const applied = await reopenRegistration(id);
    if (!applied) throw badRequest('That registration could not be reopened. Refresh and check.');

    await recordAudit({
      actor: request.actor!,
      action: 'registration_reopened',
      entityType: 'employee',
      entityId: id,
      summary: `Reopened the registration of ${employee.name} (${employee.employeeCode})`,
      ipAddress: clientIp(request),
    });

    response.json({ success: true, employee: await findEmployee(id) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Leads (Modules 4, 5, 9)                                                     */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/leads',
  requireRole('supervisor'),
  validateQuery(leadListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listLeads(
      response.locals.query as LeadListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

telecallingAdminRouter.get(
  '/leads/:id',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const scope = ownershipScope(request.actor!);

    const lead = await findLead(id, scope);
    if (!lead) throw notFound('Lead not found.');

    const [notes, calls, followUps, timeline] = await Promise.all([
      listLeadNotes(id, 200),
      listLeadCalls(id, 100),
      listLeadFollowUps(id),
      listLeadActivity(id, 200),
    ]);

    response.json({ success: true, lead, notes, calls, followUps, timeline });
  }),
);

telecallingAdminRouter.post(
  '/leads',
  ...write('supervisor'),
  validateBody(createLeadSchema),
  asyncHandler(async (request, response) => {
    const result = await createLead(
      request.body as z.infer<typeof createLeadSchema>,
      request.actor!,
      clientIp(request),
    );
    response.status(201).json({ success: true, ...result });
  }),
);

telecallingAdminRouter.patch(
  '/leads/:id',
  ...write('supervisor'),
  validateBody(updateLeadSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const lead = await editLead(
      id,
      request.body as z.infer<typeof updateLeadSchema>,
      request.actor!,
    );
    response.json({ success: true, lead });
  }),
);

telecallingAdminRouter.post(
  '/leads/:id/status',
  ...write('supervisor'),
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

telecallingAdminRouter.post(
  '/leads/:id/notes',
  ...write('supervisor'),
  validateBody(leadNoteSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await addLeadNote(
      id,
      request.body as z.infer<typeof leadNoteSchema>,
      request.actor!,
    );
    response.status(201).json({ success: true, ...result });
  }),
);

telecallingAdminRouter.post(
  '/leads/:id/assign',
  ...write('supervisor'),
  validateBody(assignLeadSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { assignedTo, reason } = request.body as z.infer<typeof assignLeadSchema>;
    const lead = await assignLead(id, assignedTo, reason, request.actor!, clientIp(request));
    response.json({ success: true, lead });
  }),
);

telecallingAdminRouter.post(
  '/leads/bulk-assign',
  ...write('manager'),
  validateBody(bulkAssignSchema),
  asyncHandler(async (request, response) => {
    const result = await bulkAssignLeads(
      request.body as z.infer<typeof bulkAssignSchema>,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
  }),
);

const archiveSchema = z.object({ archived: z.boolean() });

telecallingAdminRouter.post(
  '/leads/:id/archive',
  ...write('manager'),
  validateBody(archiveSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { archived } = request.body as z.infer<typeof archiveSchema>;
    const lead = await setLeadArchived(id, archived, request.actor!, clientIp(request));
    response.json({ success: true, lead });
  }),
);

/**
 * Permanent deletion. Admin only.
 *
 * Cascades to notes, calls, follow-ups and activity — the entire record of the
 * relationship. Archiving is the ordinary action and is one rank lower for exactly that
 * reason; this exists for a duplicate import or a test row.
 */
telecallingAdminRouter.delete(
  '/leads/:id',
  ...write('admin'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const lead = await findLead(id, null);
    if (!lead) throw notFound('Lead not found.');

    const deleted = await deleteLead(id);
    if (!deleted) throw notFound('Lead not found.');

    await recordAudit({
      actor: request.actor!,
      action: 'lead_deleted',
      entityType: 'lead',
      entityId: id,
      summary: `Permanently deleted lead ${lead.reference} (${lead.customerName})`,
      meta: { reference: lead.reference, phone: lead.phone, status: lead.status },
      ipAddress: clientIp(request),
    });

    logger.warn('Lead permanently deleted', {
      id,
      reference: lead.reference,
      by: request.actor!.email,
    });

    response.json({ success: true });
  }),
);

/**
 * The photo of a paper lead.
 *
 * Follows the resume-download pattern exactly: the file lives outside any web root, and
 * this authenticated route is the only way to read it. On S3 the browser is redirected
 * to a URL signed for sixty seconds rather than the bytes being proxied through this
 * process.
 */
telecallingAdminRouter.get(
  '/leads/:id/attachment',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const attachment = await findLeadAttachment(id, ownershipScope(request.actor!));
    if (!attachment) throw notFound('No attachment on this lead.');

    const downloadName = `${attachment.reference}-lead`;

    if (supportsPresignedUpload()) {
      response.redirect(302, await createDownloadUrl(attachment.key, downloadName));
      return;
    }

    const opened = await openResume(attachment.key);
    if (!opened) {
      logger.warn('Lead attachment missing from storage', { id, key: attachment.key });
      throw notFound('The attachment is no longer available.');
    }

    response.setHeader('Content-Type', attachment.mime ?? 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
    opened.stream.pipe(response);
  }),
);

/* -------------------------------------------------------------------------- */
/* Call monitoring and recordings (Modules 6, 7)                               */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/calls',
  requireRole('supervisor'),
  validateQuery(callListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listCalls(
      response.locals.query as CallListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

const recordingQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  leadId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

/**
 * Recordings are manager-and-above, not supervisor.
 *
 * Call metadata says a call happened; a recording is the customer's voice and the
 * employee's, and access to it is a higher bar than access to the fact of the call. The
 * spec asks for permission-gated recording access and this is where that lives.
 */
telecallingAdminRouter.get(
  '/recordings',
  requireRole('manager'),
  validateQuery(recordingQuerySchema),
  asyncHandler(async (_request, response) => {
    const result = await listRecordings(
      response.locals.query as z.infer<typeof recordingQuerySchema>,
    );
    response.json({ success: true, ...result });
  }),
);

/**
 * Playback.
 *
 * Every access is written to the audit log before the URL is issued — a recording is
 * personal data and who listened to it is a question that gets asked. Logged before,
 * not after, so an abandoned download still leaves a trace.
 */
telecallingAdminRouter.get(
  '/recordings/:id/audio',
  requireRole('manager'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const recording = await findRecordingKey(id);
    if (!recording) throw notFound('Recording not found.');

    await recordAudit({
      actor: request.actor!,
      action: 'recording_accessed',
      entityType: 'call_recording',
      entityId: id,
      summary: `Listened to a call recording`,
      meta: { leadId: recording.leadId, employeeId: recording.userId },
      ipAddress: clientIp(request),
    });

    if (supportsPresignedUpload()) {
      response.redirect(302, await createDownloadUrl(recording.key, `recording-${id}`));
      return;
    }

    const opened = await openResume(recording.key);
    if (!opened) throw notFound('The recording file is no longer available.');

    response.setHeader('Content-Type', recording.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // `inline` so the admin UI can play it in an <audio> element rather than forcing a
    // download of someone's phone call onto a laptop.
    response.setHeader('Content-Disposition', `inline; filename="recording-${id}"`);
    opened.stream.pipe(response);
  }),
);

/* -------------------------------------------------------------------------- */
/* Follow-ups (Module 8)                                                       */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/follow-ups',
  requireRole('supervisor'),
  validateQuery(followUpListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listFollowUps(
      response.locals.query as FollowUpListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

telecallingAdminRouter.post(
  '/follow-ups',
  ...write('supervisor'),
  validateBody(createFollowUpSchema),
  asyncHandler(async (request, response) => {
    const result = await createFollowUp(
      request.body as z.infer<typeof createFollowUpSchema>,
      request.actor!,
    );
    response.status(201).json({ success: true, ...result });
  }),
);

telecallingAdminRouter.patch(
  '/follow-ups/:id',
  ...write('supervisor'),
  validateBody(editFollowUpSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const followUp = await editFollowUp(
      id,
      request.body as z.infer<typeof editFollowUpSchema>,
      request.actor!,
    );
    response.json({ success: true, followUp });
  }),
);

telecallingAdminRouter.post(
  '/follow-ups/:id/reschedule',
  ...write('supervisor'),
  validateBody(rescheduleFollowUpSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { dueAt, note } = request.body as z.infer<typeof rescheduleFollowUpSchema>;
    const followUp = await rescheduleFollowUp(id, dueAt, note, request.actor!);
    response.json({ success: true, followUp });
  }),
);

telecallingAdminRouter.post(
  '/follow-ups/:id/complete',
  ...write('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const followUp = await completeFollowUp(id, null, request.actor!);
    response.json({ success: true, followUp });
  }),
);

telecallingAdminRouter.post(
  '/follow-ups/:id/cancel',
  ...write('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const followUp = await cancelFollowUp(id, request.actor!);
    response.json({ success: true, followUp });
  }),
);

/* -------------------------------------------------------------------------- */
/* Reports and analytics (Modules 11, 12, 13)                                  */
/* -------------------------------------------------------------------------- */

const trendQuerySchema = dateRangeSchema.extend({
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  userId: z.coerce.number().int().positive().optional(),
});

telecallingAdminRouter.get(
  '/reports/calls',
  requireRole('supervisor'),
  validateQuery(trendQuerySchema),
  asyncHandler(async (_request, response) => {
    const { granularity, userId, ...range } = response.locals.query as z.infer<
      typeof trendQuerySchema
    >;
    const points = await callTrend(granularity, range, userId);
    response.json({ success: true, granularity, items: points });
  }),
);

telecallingAdminRouter.get(
  '/reports/performance',
  requireRole('supervisor'),
  validateQuery(dateRangeSchema),
  asyncHandler(async (_request, response) => {
    const range = response.locals.query as z.infer<typeof dateRangeSchema>;
    response.json({ success: true, items: await employeePerformance(range) });
  }),
);

const breakdownQuerySchema = dateRangeSchema.extend({
  dimension: z.enum(['status', 'source', 'employee']).default('status'),
});

telecallingAdminRouter.get(
  '/reports/leads',
  requireRole('supervisor'),
  validateQuery(breakdownQuerySchema),
  asyncHandler(async (_request, response) => {
    const { dimension, ...range } = response.locals.query as z.infer<typeof breakdownQuerySchema>;
    response.json({ success: true, dimension, items: await leadBreakdown(dimension, range) });
  }),
);

const followUpReportQuerySchema = dateRangeSchema.extend({
  userId: z.coerce.number().int().positive().optional(),
});

telecallingAdminRouter.get(
  '/reports/follow-ups',
  requireRole('supervisor'),
  validateQuery(followUpReportQuerySchema),
  asyncHandler(async (_request, response) => {
    const { userId, ...range } = response.locals.query as z.infer<
      typeof followUpReportQuerySchema
    >;
    response.json({ success: true, ...(await followUpPerformance(range, userId)) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Lead sources (Module 13)                                                    */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/lead-sources',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listLeadSources(false) });
  }),
);

const leadSourceSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores only.'),
  label: z.string().trim().min(2).max(120),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(100),
});

telecallingAdminRouter.put(
  '/lead-sources',
  ...write('admin'),
  validateBody(leadSourceSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof leadSourceSchema>;

    await upsertLeadSource(input);

    await recordAudit({
      actor: request.actor!,
      action: 'lead_source_saved',
      entityType: 'lead_source',
      entityId: null,
      summary: `Saved lead source "${input.label}" (${input.slug})`,
      meta: input,
      ipAddress: clientIp(request),
    });

    response.json({ success: true, items: await listLeadSources(false) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Audit log (Module 14)                                                       */
/* -------------------------------------------------------------------------- */

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(40).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

/**
 * Manager and above. A supervisor monitors calling activity; the audit log records
 * administrative action, including action taken against employees, and is a different
 * kind of visibility.
 */
telecallingAdminRouter.get(
  '/audit-logs',
  requireRole('manager'),
  validateQuery(auditQuerySchema),
  asyncHandler(async (_request, response) => {
    const result = await listAuditLogs(response.locals.query as z.infer<typeof auditQuerySchema>);
    response.json({ success: true, ...result });
  }),
);

/* -------------------------------------------------------------------------- */
/* System settings (Module 15)                                                 */
/* -------------------------------------------------------------------------- */

telecallingAdminRouter.get(
  '/settings',
  requireRole('manager'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listSettings() });
  }),
);

const settingWriteSchema = z.object({
  key: z.enum(WRITABLE_SETTING_KEYS),
  /**
   * Unconstrained by design: these settings hold booleans, numbers and small objects,
   * and the closed `key` enum is what stops arbitrary rows being written. The consuming
   * reader coerces and falls back to a default, so a wrong type degrades to the default
   * rather than breaking call logging.
   */
  value: z.unknown(),
});

telecallingAdminRouter.put(
  '/settings',
  ...write('admin'),
  validateBody(settingWriteSchema),
  asyncHandler(async (request, response) => {
    const { key, value } = request.body as z.infer<typeof settingWriteSchema>;

    await writeSetting(key, value, request.actor!.id);

    await recordAudit({
      actor: request.actor!,
      action: 'setting_changed',
      entityType: 'system_setting',
      entityId: null,
      summary: `Changed setting ${key}`,
      meta: { key, value },
      ipAddress: clientIp(request),
    });

    logger.info('Telecalling setting changed', { key, by: request.actor!.email });

    response.json({ success: true, items: await listSettings() });
  }),
);

/* -------------------------------------------------------------------------- */
/* Broadcast (Module 10)                                                       */
/* -------------------------------------------------------------------------- */

const broadcastSchema = z.object({
  title: z.string().trim().min(2).max(190),
  body: z.string().trim().max(500).optional(),
  /** Omit to reach every active employee. */
  employeeIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
});

telecallingAdminRouter.post(
  '/broadcast',
  ...write('manager'),
  validateBody(broadcastSchema),
  asyncHandler(async (request, response) => {
    const { title, body, employeeIds } = request.body as z.infer<typeof broadcastSchema>;

    const recipients =
      employeeIds && employeeIds.length > 0
        ? employeeIds
        : (await listAssignableEmployees()).map((employee) => employee.id);

    if (recipients.length === 0) throw badRequest('There are no active employees to notify.');

    await queueNotifications(
      recipients.map((userId) => ({
        userId,
        kind: 'admin_message' as const,
        title,
        body: body ?? null,
      })),
    );

    await recordAudit({
      actor: request.actor!,
      action: 'broadcast_sent',
      entityType: 'notification',
      entityId: null,
      summary: `Sent "${title}" to ${recipients.length} employee(s)`,
      meta: { recipients: recipients.length },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, recipients: recipients.length });
  }),
);
