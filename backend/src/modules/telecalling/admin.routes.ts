import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../middleware/actor';
import { asyncHandler } from '../../middleware/errorHandler';
import { leadImportLimiter } from '../../middleware/rateLimit';
import { uploadLeadImportFile } from '../../middleware/uploadLeadImport';
import { validateBody, validateQuery } from '../../middleware/validate';
import { createDownloadUrl, openResume, supportsPresignedUpload } from '../../services/storage';
import { badRequest, notFound } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import { ownershipScope } from './actor';
import {
  listAuditLogs,
  listEmployeeActivity,
  recordAudit,
} from './activity/activity.repository';
import { findRecordingKey, listRecordings } from './calls/call.repository';
import { callListQuerySchema, type CallListQuery } from './calls/call.schema';
import { listCallsWithNotes } from './calls/call.service';
import {
  adminDashboard,
  callTrend,
  employeeActivitySummary,
  employeePerformance,
  followUpPerformance,
  leadBreakdown,
  overdueByEmployee,
} from './dashboard/dashboard.repository';
import { analyticsQuerySchema, type AnalyticsQuery } from './dashboard/dashboard.schema';
import { dashboardAnalytics } from './dashboard/dashboard.service';
import {
  countOpenLeads,
  countPendingRegistrations,
  findEmployee,
  listAssignableEmployees,
  listEmployees,
  listPendingRegistrations,
  rejectRegistration,
} from './employees/employee.repository';
import {
  approveRegistrationSchema,
  createEmployeeSchema,
  deactivateEmployeeSchema,
  employeeListQuerySchema,
  rejectRegistrationSchema,
  resetPasswordSchema,
  updateEmployeeSchema,
  type ApproveRegistrationInput,
  type DeactivateEmployeeInput,
  type EmployeeListQuery,
} from './employees/employee.schema';
import {
  approvePendingRegistration,
  createEmployee,
  deactivateEmployee,
  editEmployee,
  getDeactivationCheck,
  reopenRejectedRegistration,
  resetEmployeePassword,
} from './employees/employee.service';
import { listFollowUps } from './followups/followUp.repository';
import {
  createFollowUpSchema,
  editFollowUpSchema,
  followUpListQuerySchema,
  handoverFollowUpsSchema,
  moveFollowUpSchema,
  rescheduleFollowUpSchema,
  type EditFollowUpInput,
  type FollowUpListQuery,
  type HandoverFollowUpsInput,
  type MoveFollowUpInput,
} from './followups/followUp.schema';
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  rescheduleFollowUp,
} from './followups/followUp.service';
import { editFollowUp, handoverFollowUps, moveFollowUp } from './followups/followUpMove.service';
import {
  leadImportCommitSchema,
  leadImportDetailQuerySchema,
  leadImportListQuerySchema,
  leadImportPreviewSchema,
  leadImportRowsCsvQuerySchema,
  type LeadImportCommitInput,
  type LeadImportDetailQuery,
  type LeadImportListQuery,
  type LeadImportPreviewInput,
  type LeadImportRowsCsvQuery,
} from './imports/leadImport.schema';
import {
  LEAD_IMPORT_TEMPLATE_FILE,
  XLSX_CONTENT_TYPE,
  buildLeadImportRowsCsv,
  buildLeadImportTemplate,
  cancelLeadImport,
  commitLeadImportBatch,
  getLeadImport,
  listLeadImports,
  previewLeadImport,
} from './imports/leadImport.service';
import {
  deleteLead,
  findLead,
  findLeadAttachment,
  listLeadSources,
  upsertLeadSource,
} from './leads/lead.repository';
import {
  assignLeadSchema,
  bulkAssignSchema,
  createLeadSchema,
  leadHistoryQuerySchema,
  leadListQuerySchema,
  leadNoteSchema,
  leadStatusSchema,
  updateLeadSchema,
  type LeadHistoryQuery,
  type LeadListQuery,
} from './leads/lead.schema';
import {
  addLeadNote,
  assignLead,
  bulkAssignLeads,
  changeLeadStatus,
  createLead,
  editLead,
  getLeadView,
  listLeadActivityHistory,
  listLeadCallHistory,
  listLeadClosedFollowUps,
  listLeadNoteHistory,
  listLeadsWithLatestNotes,
  setLeadArchived,
} from './leads/lead.service';
import { queueNotifications } from './notifications/notification.repository';
import {
  dailyReportPreviewQuerySchema,
  dailyReportSendSchema,
  dailyReportStatusQuerySchema,
  type DailyReportPreviewQuery,
  type DailyReportSendInput,
  type DailyReportStatusQuery,
} from './reports/dailyReport.schema';
import {
  dailyReportStatus,
  previewDailyReport,
  sendDailyReportNow,
} from './reports/dailyReport.service';
import {
  listSettings,
  readNumberSetting,
  WRITABLE_SETTING_KEYS,
  writeSetting,
} from './settings/settings.repository';
import { checkSettingValue } from './settings/settings.schema';
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

    /*
     * Two different "employees" figures, kept under two names: `headcount` is the
     * Active-employees tile, `employees` the per-employee performance rows. The headcount
     * used to travel as `employees` too, and this spread overwrote it with the rows — the
     * tile rendered blank. The rows keep the name clients already read them by.
     */
    response.json({
      success: true,
      ...dashboard,
      employees: performance,
      overdueByEmployee: overdue,
      pendingRegistrations,
    });
  }),
);

/**
 * The dashboard's trend charts: calls, talk time, leads created and converted, leads by
 * status, and follow-ups due — for the same range as the tiles, bucketed by IST hour,
 * day, ISO week or month.
 *
 * A separate request from GET /dashboard so a granularity change refetches only the
 * charts, and a chart failure cannot take the tiles down with it. Read-only, so no CSRF.
 */
telecallingAdminRouter.get(
  '/dashboard/analytics',
  requireRole('supervisor'),
  validateQuery(analyticsQuerySchema),
  asyncHandler(async (_request, response) => {
    const analytics = await dashboardAnalytics(response.locals.query as AnalyticsQuery);
    response.json({ success: true, ...analytics });
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
 * Moves pending follow-ups from one employee to another.
 *
 * The action an admin needs when someone resigns or goes on leave, and the reason
 * `follow_ups.assigned_to` is separate from `leads.assigned_to`: the commitments can be
 * covered for a fortnight without permanently transferring ownership of the leads.
 *
 * One transaction: a selection or everything, optionally re-dated, optionally with the
 * leads; same-day duplicates for the receiving employee are skipped and listed rather
 * than doubled up. The original body `{ toEmployeeId }` still means every pending
 * follow-up, times kept. The employee handing over may already be deactivated — that is
 * how follow-ups stranded on a leaver are cleared.
 */
telecallingAdminRouter.post(
  '/employees/:id/handover-follow-ups',
  ...write('manager'),
  validateBody(handoverFollowUpsSchema),
  asyncHandler(async (request, response) => {
    const fromId = parseId(request.params.id);
    const result = await handoverFollowUps(
      fromId,
      request.body as HandoverFollowUpsInput,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
  }),
);

/**
 * Whether an employee can be deactivated now: pending follow-ups by when they fall due,
 * open leads, and anything else in the way. Advice for the dialog — the deactivation
 * itself re-checks inside its own transaction. Manager and above, like the handover the
 * dialog offers alongside it.
 */
telecallingAdminRouter.get(
  '/employees/:id/deactivation-check',
  requireRole('manager'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const check = await getDeactivationCheck(id, request.actor!);
    response.json({ success: true, ...check });
  }),
);

/**
 * Deactivates an employee, optionally handing every pending follow-up to someone else
 * first — atomically. Refused with 409 `pending_follow_ups` (and nothing written, the
 * handover included) if anything would be left behind. Admin only, as deactivating
 * through `PATCH /employees/:id` is.
 */
telecallingAdminRouter.post(
  '/employees/:id/deactivate',
  ...write('admin'),
  validateBody(deactivateEmployeeSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await deactivateEmployee(
      id,
      request.body as DeactivateEmployeeInput,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
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
 *
 * Body `{ companyPhone? }`: needed only when the applicant has no company SIM number on
 * record (older app builds did not ask), and saved with the approval. The gates — email
 * confirmed, company number present and free — are in `approvePendingRegistration`.
 */
telecallingAdminRouter.post(
  '/registrations/:id/approve',
  ...write('admin'),
  validateBody(approveRegistrationSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { companyPhone } = request.body as ApproveRegistrationInput;
    const employee = await approvePendingRegistration(
      id,
      companyPhone,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, employee });
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
 * without editing the database. Refused (400) if the applicant's company number has been
 * given to someone else since — see `reopenRejectedRegistration`.
 */
telecallingAdminRouter.post(
  '/registrations/:id/reopen',
  ...write('admin'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const employee = await reopenRejectedRegistration(id, request.actor!, clientIp(request));
    response.json({ success: true, employee });
  }),
);

/* -------------------------------------------------------------------------- */
/* Leads (Modules 4, 5, 9)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The admin lead list. Each row also carries its latest note (`latestNote`), which the
 * mobile list — built on the same `listLeads` — deliberately does not.
 */
telecallingAdminRouter.get(
  '/leads',
  requireRole('supervisor'),
  validateQuery(leadListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listLeadsWithLatestNotes(
      response.locals.query as LeadListQuery,
      ownershipScope(request.actor!),
    );
    response.json({ success: true, ...result });
  }),
);

/**
 * The Lead View: the lead, who may do what with it, figures over all its calls, and the
 * FIRST page of each history. The rest of each history comes from the routes below, a
 * page at a time. The mobile lead detail is a different response and stays as it was.
 */
telecallingAdminRouter.get(
  '/leads/:id',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const view = await getLeadView(parseId(request.params.id), request.actor!);
    response.json({ success: true, ...view });
  }),
);

/*
 * One lead's histories, a page at a time — each Lead View card pages on its own. All
 * read-only; each answers 404 for a lead that does not exist or is out of the caller's
 * reach before reading anything.
 */

/** Calls, newest first, each with its notes, follow-ups and the status it set. */
telecallingAdminRouter.get(
  '/leads/:id/calls',
  requireRole('supervisor'),
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    const result = await listLeadCallHistory(
      parseId(request.params.id),
      page,
      pageSize,
      request.actor!,
    );
    response.json({ success: true, ...result });
  }),
);

/** Notes, newest first, every kind — system notes included. */
telecallingAdminRouter.get(
  '/leads/:id/notes',
  requireRole('supervisor'),
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    const result = await listLeadNoteHistory(
      parseId(request.params.id),
      page,
      pageSize,
      request.actor!,
    );
    response.json({ success: true, ...result });
  }),
);

/** Completed and cancelled follow-ups, newest first. The open ones come whole with the lead. */
telecallingAdminRouter.get(
  '/leads/:id/follow-ups',
  requireRole('supervisor'),
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    const result = await listLeadClosedFollowUps(
      parseId(request.params.id),
      page,
      pageSize,
      request.actor!,
    );
    response.json({ success: true, ...result });
  }),
);

/** The timeline, newest first. */
telecallingAdminRouter.get(
  '/leads/:id/activity',
  requireRole('supervisor'),
  validateQuery(leadHistoryQuerySchema),
  asyncHandler(async (request, response) => {
    const { page, pageSize } = response.locals.query as LeadHistoryQuery;
    const result = await listLeadActivityHistory(
      parseId(request.params.id),
      page,
      pageSize,
      request.actor!,
    );
    response.json({ success: true, ...result });
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

/**
 * The call monitor. `line` defaults to the company line, so legacy unverified incoming
 * rows appear only when an admin asks for them (`line=unverified`). Each row carries its
 * newest note and note count, and the response a `summary` over the whole filtered list
 * — the figures the dashboard card that opened it showed.
 */
telecallingAdminRouter.get(
  '/calls',
  requireRole('supervisor'),
  validateQuery(callListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listCallsWithNotes(
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
  /** Inclusive IST calendar days on when the recording arrived (see companyTime.ts). */
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

/**
 * Recordings are manager-and-above, not supervisor.
 *
 * Call metadata says a call happened; a recording is the customer's voice and the
 * employee's, and access to it is a higher bar than access to the fact of the call. The
 * spec asks for permission-gated recording access and this is where that lives.
 *
 * Paged like every list (page/pageSize, at most 100), with `from`/`to` read as IST days.
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
    // A new assignedTo is carried out as a move — pending only, the same-day rule, 409s.
    const followUp = await editFollowUp(
      id,
      request.body as EditFollowUpInput,
      request.actor!,
      clientIp(request),
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

/**
 * Moves a pending follow-up to a new time, a new lead, a new employee — or several at
 * once. Supervisor and above, like rescheduling and reassigning.
 *
 * Errors a screen handles by `code`: 409 `follow_up_changed` (someone else changed it
 * since the screen loaded it — `details.current` is how it is now), 409
 * `follow_up_not_pending`, 409 `duplicate_follow_up` (`details.conflict` is the follow-up
 * it would double), and 422 with field errors on `dueAt`, `leadId` or `assignedTo`.
 * Repeating a move that already applied answers 200 with `changed: false`.
 */
telecallingAdminRouter.post(
  '/follow-ups/:id/move',
  ...write('supervisor'),
  validateBody(moveFollowUpSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const result = await moveFollowUp(
      id,
      request.body as MoveFollowUpInput,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
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
    const { points, truncated } = await callTrend(granularity, range, userId);
    response.json({ success: true, granularity, items: points, truncated });
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
/* Daily report email (Requirement 1)                                          */
/* -------------------------------------------------------------------------- */

/*
 * ADMIN ONLY, all three. The email carries every employee's performance and goes to the
 * configured inboxes, and the status shows where (masked); supervisors and managers keep
 * the dashboard and the reports above. A Bearer admin on the mobile app can call these
 * too — nothing about them is browser-specific. Sending is a POST, so it depends on no
 * CORS method beyond the basics.
 */

/** Settings, delivery configuration, the next run, and one page of run history. */
telecallingAdminRouter.get(
  '/reports/daily-email',
  requireRole('admin'),
  validateQuery(dailyReportStatusQuerySchema),
  asyncHandler(async (_request, response) => {
    const status = await dailyReportStatus(response.locals.query as DailyReportStatusQuery);
    response.json({ success: true, ...status });
  }),
);

/**
 * The report and its rendered email for a day, without sending or recording anything.
 *
 * JSON rather than an HTML page: the API's CSP (`default-src 'none'`, `frame-ancestors
 * 'none'`) would show a page served from here unstyled and unframeable. The admin screen
 * renders `email.html` in a sandboxed srcdoc iframe instead.
 */
telecallingAdminRouter.get(
  '/reports/daily-email/preview',
  requireRole('admin'),
  validateQuery(dailyReportPreviewQuerySchema),
  asyncHandler(async (_request, response) => {
    const { date } = response.locals.query as DailyReportPreviewQuery;
    response.json({ success: true, ...(await previewDailyReport(date)) });
  }),
);

/** Sends a finished day's report now — to the recipients, or with `toMe` to the caller only. */
telecallingAdminRouter.post(
  '/reports/daily-email/send',
  ...write('admin'),
  validateBody(dailyReportSendSchema),
  asyncHandler(async (request, response) => {
    const result = await sendDailyReportNow(
      request.body as DailyReportSendInput,
      request.actor!,
      { ipAddress: clientIp(request) },
    );
    response.json({ success: true, ...result });
  }),
);

/* -------------------------------------------------------------------------- */
/* Lead import (Module 4)                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Manager and above throughout. An import creates and assigns up to two thousand leads in
 * one action — the scale of bulk assignment and archiving, both manager routes — while a
 * single create stays a supervisor's.
 *
 * The prefix is /lead-imports rather than /leads/import...: GET /leads/:id would capture
 * GET /leads/imports and answer 404 through parseId. Only GET and POST are used, and
 * /template and /:id/rows.csv are registered before /:id.
 */

/** The blank template, as a file download (the browser opens it with the session cookie). */
telecallingAdminRouter.get(
  '/lead-imports/template',
  requireRole('manager'),
  asyncHandler(async (_request, response) => {
    const file = await buildLeadImportTemplate();
    response.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    response.setHeader('Content-Disposition', `attachment; filename="${LEAD_IMPORT_TEMPLATE_FILE}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(file);
  }),
);

/**
 * Checks a file: multipart, the spreadsheet in `file`. Writes staging rows only.
 *
 * The role and CSRF checks and the limiter run BEFORE the upload, so a caller who may not
 * import is refused before five megabytes are buffered.
 */
telecallingAdminRouter.post(
  '/lead-imports',
  ...write('manager'),
  leadImportLimiter,
  uploadLeadImportFile,
  validateBody(leadImportPreviewSchema),
  asyncHandler(async (request, response) => {
    const result = await previewLeadImport(
      request.file!,
      request.body as LeadImportPreviewInput,
      request.actor!,
    );
    response.status(201).json({ success: true, ...result });
  }),
);

telecallingAdminRouter.get(
  '/lead-imports',
  requireRole('manager'),
  validateQuery(leadImportListQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await listLeadImports(response.locals.query as LeadImportListQuery, request.actor!);
    response.json({ success: true, ...result });
  }),
);

/** Rows to fix (by default: not imported, skipped or failed) as CSV, original columns first. */
telecallingAdminRouter.get(
  '/lead-imports/:id/rows.csv',
  requireRole('manager'),
  validateQuery(leadImportRowsCsvQuerySchema),
  asyncHandler(async (request, response) => {
    const { fileName, csv } = await buildLeadImportRowsCsv(
      parseId(request.params.id),
      response.locals.query as LeadImportRowsCsvQuery,
    );
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(csv);
  }),
);

/** One import and one page of its rows (`page`, `pageSize` ≤ 100, `outcome`, `state`). */
telecallingAdminRouter.get(
  '/lead-imports/:id',
  requireRole('manager'),
  validateQuery(leadImportDetailQuerySchema),
  asyncHandler(async (request, response) => {
    const result = await getLeadImport(
      parseId(request.params.id),
      response.locals.query as LeadImportDetailQuery,
    );
    response.json({ success: true, ...result });
  }),
);

/** The next batch. The client calls it until `done`; every call is safe to repeat. */
telecallingAdminRouter.post(
  '/lead-imports/:id/commit',
  ...write('manager'),
  validateBody(leadImportCommitSchema),
  asyncHandler(async (request, response) => {
    const result = await commitLeadImportBatch(
      parseId(request.params.id),
      request.body as LeadImportCommitInput,
      request.actor!,
      clientIp(request),
    );
    response.json({ success: true, ...result });
  }),
);

telecallingAdminRouter.post(
  '/lead-imports/:id/cancel',
  ...write('manager'),
  asyncHandler(async (request, response) => {
    const result = await cancelLeadImport(parseId(request.params.id), request.actor!, clientIp(request));
    response.json({ success: true, ...result });
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
   * Unconstrained here: these settings hold booleans, numbers and small objects, and the
   * closed `key` enum is what stops arbitrary rows being written. Most readers coerce and
   * fall back to a default, so a wrong type degrades to the default rather than breaking
   * call logging. The keys whose exact shape something depends on — the daily email's
   * switch and send time — are checked per key in the handler (`checkSettingValue`).
   */
  value: z.unknown(),
});

telecallingAdminRouter.put(
  '/settings',
  ...write('admin'),
  validateBody(settingWriteSchema),
  asyncHandler(async (request, response) => {
    const { key, value: submitted } = request.body as z.infer<typeof settingWriteSchema>;

    /*
     * A 400 carrying the specific sentence — "Use 24-hour time as HH:MM…" — rather than the
     * generic 422 text, because the Settings screen shows a refused save's message as it is.
     */
    const checked = checkSettingValue(key, submitted);
    if (!checked.ok) throw badRequest(checked.message, { value: checked.message });
    const value = checked.value;

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
