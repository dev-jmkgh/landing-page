import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireActor, requireRole } from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateQuery } from '../../../middleware/validate';
import { badRequest } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { isIsoDate } from '../calendar/calendar.service';
import { contentDisposition } from '../files/hrFileLinks';
import { HR_EMPLOYMENT_STATUSES, isoDateField, pageQuerySchema } from '../hr.schema';
import { csvDocument } from './csv';
import { adminDashboard } from './dashboard.service';
import {
  PAYROLL_CSV_HEADER,
  REPORT_LIMITS,
  attendanceReport,
  companyYear,
  dailyReport,
  employeesReport,
  exportAttendanceCsv,
  exportDailyCsv,
  exportEmployeesCsv,
  exportLeaveCsv,
  leaveReport,
  listHrAudit,
  payrollYearCsvRows,
  payrollYearReport,
  resolveRange,
  type EmployeeScope,
} from './reports.service';

/**
 * HR dashboard, reports, exports and the HR audit trail — admin portal, mounted at `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR (see the note at the top of `hrAdmin.routes.ts`).
 * Everything here is a READ:
 *
 *   supervisor — the dashboard (without payroll), every report except payroll, CSV
 *   admin      — also payroll figures (salary is sensitive) and the audit trail
 *
 * No route writes, so none needs CSRF. A CSV export of personal data IS recorded in the
 * audit trail, the way access to a call recording is: who took a copy of the directory
 * is a question somebody will one day need answered.
 */
export const hrReportsAdminRouter = Router();

hrReportsAdminRouter.use(requireActor);

/* -------------------------------------------------------------------------- */
/* Query schemas                                                               */
/* -------------------------------------------------------------------------- */

const idField = z.coerce.number().int().positive();
const formatField = z.enum(['json', 'csv']).default('json');
const yearField = z.coerce.number().int().min(2000).max(2100);

const scopeFields = {
  departmentId: idField.optional(),
  userId: idField.optional(),
  locationId: idField.optional(),
};

const attendanceQuerySchema = pageQuerySchema.extend({
  from: isoDateField.optional(),
  to: isoDateField.optional(),
  ...scopeFields,
  format: formatField,
});
type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

const leaveQuerySchema = pageQuerySchema.extend({
  year: yearField.optional(),
  departmentId: idField.optional(),
  userId: idField.optional(),
  format: formatField,
});
type LeaveQuery = z.infer<typeof leaveQuerySchema>;

const employeesQuerySchema = pageQuerySchema.extend({
  departmentId: idField.optional(),
  designationId: idField.optional(),
  locationId: idField.optional(),
  userId: idField.optional(),
  employmentStatus: z.enum(HR_EMPLOYMENT_STATUSES).optional(),
  active: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(120).optional(),
  format: formatField,
});
type EmployeesQuery = z.infer<typeof employeesQuerySchema>;

const payrollQuerySchema = z.object({ year: yearField.optional(), format: formatField });

const dashboardQuerySchema = z.object({ date: isoDateField.optional() });

const auditQuerySchema = pageQuerySchema.extend({
  action: z.string().trim().min(1).max(60).optional(),
  entityType: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().max(120).optional(),
  from: isoDateField.optional(),
  to: isoDateField.optional(),
});
type AuditQuery = z.infer<typeof auditQuerySchema>;

function scopeOf(filters: {
  departmentId?: number;
  userId?: number;
  locationId?: number;
}): EmployeeScope {
  return { departmentId: filters.departmentId, userId: filters.userId, locationId: filters.locationId };
}

/** Written BEFORE the file streams, so the trail has the row by the time the download lands. */
async function auditExport(request: Request, report: string, meta: Record<string, unknown>): Promise<void> {
  await recordAudit({
    actor: request.actor!,
    action: 'hr_report_exported',
    entityType: 'hr_report',
    entityId: null,
    summary: `Exported the ${report} report as CSV`,
    meta: { report, ...meta },
    ipAddress: clientIp(request),
  });
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/dashboard',
  requireRole('supervisor'),
  validateQuery(dashboardQuerySchema),
  asyncHandler(async (request, response) => {
    const { date } = response.locals.query as z.infer<typeof dashboardQuerySchema>;
    if (date && !isIsoDate(date)) throw badRequest('Enter a real date.', { date: 'Enter a real date.' });

    const dashboard = await adminDashboard({
      date,
      // Salary totals are admin-only, like every payroll read. A supervisor gets null.
      includePayroll: request.actor!.role === 'admin',
    });
    response.json({ success: true, ...dashboard });
  }),
);

/* -------------------------------------------------------------------------- */
/* Attendance                                                                  */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/reports/attendance',
  requireRole('supervisor'),
  validateQuery(attendanceQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as AttendanceQuery;
    const range = resolveRange(filters, REPORT_LIMITS.attendanceDays);
    const scope = scopeOf(filters);

    if (filters.format === 'csv') {
      await auditExport(request, 'attendance', { from: range.from, to: range.to, ...scope });
      await exportAttendanceCsv(scope, range, response);
      return;
    }

    response.json({
      success: true,
      ...(await attendanceReport(scope, range, { page: filters.page, pageSize: filters.pageSize })),
    });
  }),
);

hrReportsAdminRouter.get(
  '/reports/attendance/daily',
  requireRole('supervisor'),
  validateQuery(attendanceQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as AttendanceQuery;
    const csv = filters.format === 'csv';
    // A month on screen, a quarter as a file — the screen pages through rows a person reads.
    const range = resolveRange(filters, csv ? REPORT_LIMITS.dailyCsvDays : REPORT_LIMITS.dailyJsonDays);
    const scope = scopeOf(filters);

    if (csv) {
      await auditExport(request, 'attendance-daily', { from: range.from, to: range.to, ...scope });
      await exportDailyCsv(scope, range, response);
      return;
    }

    response.json({
      success: true,
      ...(await dailyReport(scope, range, { page: filters.page, pageSize: filters.pageSize })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Leave                                                                       */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/reports/leave',
  requireRole('supervisor'),
  validateQuery(leaveQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as LeaveQuery;
    const year = filters.year ?? companyYear();
    const scope: EmployeeScope = { departmentId: filters.departmentId, userId: filters.userId };

    if (filters.format === 'csv') {
      await auditExport(request, 'leave', { year, ...scope });
      await exportLeaveCsv(scope, year, response);
      return;
    }

    response.json({
      success: true,
      ...(await leaveReport(scope, year, { page: filters.page, pageSize: filters.pageSize })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Employee directory                                                          */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/reports/employees',
  requireRole('supervisor'),
  validateQuery(employeesQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as EmployeesQuery;
    const scope: EmployeeScope = {
      departmentId: filters.departmentId,
      designationId: filters.designationId,
      locationId: filters.locationId,
      userId: filters.userId,
      employmentStatus: filters.employmentStatus,
      active: filters.active === undefined ? undefined : filters.active === 'true',
      q: filters.q || undefined,
    };

    if (filters.format === 'csv') {
      await auditExport(request, 'employees', { ...scope });
      await exportEmployeesCsv(scope, response);
      return;
    }

    response.json({
      success: true,
      ...(await employeesReport(scope, { page: filters.page, pageSize: filters.pageSize })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Payroll by year — ADMIN ONLY                                                */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/reports/payroll',
  requireRole('admin'),
  validateQuery(payrollQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof payrollQuerySchema>;
    const year = filters.year ?? companyYear();
    // At most twelve runs: bounded, so neither form pages.
    const report = await payrollYearReport(year);

    if (filters.format === 'csv') {
      await auditExport(request, 'payroll', { year });
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', contentDisposition(`hr-payroll-${year}.csv`));
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.send(csvDocument(PAYROLL_CSV_HEADER, payrollYearCsvRows(report)));
      return;
    }

    response.json({ success: true, ...report });
  }),
);

/* -------------------------------------------------------------------------- */
/* The HR audit trail — ADMIN ONLY                                             */
/* -------------------------------------------------------------------------- */

hrReportsAdminRouter.get(
  '/audit',
  requireRole('admin'),
  validateQuery(auditQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as AuditQuery;
    response.json({
      success: true,
      ...(await listHrAudit({
        action: filters.action,
        entityType: filters.entityType,
        q: filters.q || undefined,
        from: filters.from,
        to: filters.to,
        page: filters.page,
        pageSize: filters.pageSize,
      })),
    });
  }),
);
