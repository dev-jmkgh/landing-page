import { Router } from 'express';
import { z } from 'zod';
import { requireActor, requireCsrfForCookieSession, requireRole } from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { notFound } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { contentDisposition } from '../files/hrFileLinks';
import { buildPayslipPdf } from './payslipPdf';
import {
  createRunSchema,
  createStructureSchema,
  fullPaySchema,
  monthLabel,
  payrollEmployeesQuerySchema,
  runPayslipsQuerySchema,
  runsQuerySchema,
  structuresQuerySchema,
  type CreateStructureInput,
  type PayrollEmployeesQuery,
} from './payroll.schema';
import {
  approveRun,
  buildRunCsv,
  clearEmployeeFullPay,
  createRun,
  createStructure,
  deleteRun,
  deleteStructure,
  getPayslip,
  getRun,
  listPayrollEmployees,
  listRunPayslips,
  listRuns,
  listStructures,
  payslipFilename,
  processRun,
  setEmployeeFullPay,
} from './payroll.service';

/**
 * Payroll: salary structures, runs and payslips — admin portal, mounted at `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR (see the note at the top of `hrAdmin.routes.ts`).
 *
 * ADMIN ONLY, READS INCLUDED. Elsewhere in the HR admin surface a supervisor may read;
 * here they may not, because what is read is everybody's salary. Every route below
 * carries `requireRole('admin')` itself, and the `/payroll` prefix carries it again, so a
 * route added later without it is still closed. Writes add CSRF for a cookie session.
 *
 * The prefix guard is path-scoped on purpose: several HR admin routers share
 * `/api/admin/hr`, and a router-wide role check here would refuse a supervisor on the
 * routers mounted after this one.
 */
export const hrPayrollAdminRouter = Router();

hrPayrollAdminRouter.use(requireActor);
hrPayrollAdminRouter.use('/payroll', requireRole('admin'));

const adminOnly = requireRole('admin');
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Salary structures                                                           */
/* -------------------------------------------------------------------------- */

/** One employee's structure history, newest first. */
hrPayrollAdminRouter.get(
  '/payroll/structures',
  adminOnly,
  validateQuery(structuresQuerySchema),
  asyncHandler(async (_request, response) => {
    const { userId, page, pageSize } = response.locals.query as z.infer<typeof structuresQuerySchema>;
    response.json({ success: true, ...(await listStructures(userId, page, pageSize)) });
  }),
);

hrPayrollAdminRouter.post(
  '/payroll/structures',
  ...write(),
  validateBody(createStructureSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as CreateStructureInput;
    const { structure, employee } = await createStructure(input, request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_salary_structure_created',
      entityType: 'hr_salary_structure',
      entityId: structure.id,
      summary: `Added a salary structure for ${employee.name} (${employee.employeeCode}) from ${structure.effectiveFrom}`,
      // Totals, not the individual lines: enough to answer "what changed", admin-only log.
      meta: { userId: structure.userId, effectiveFrom: structure.effectiveFrom, ...structure.totals },
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, structure });
  }),
);

hrPayrollAdminRouter.delete(
  '/payroll/structures/:id',
  ...write(),
  asyncHandler(async (request, response) => {
    const structure = await deleteStructure(parseId(request.params.id));

    await recordAudit({
      actor: request.actor!,
      action: 'hr_salary_structure_deleted',
      entityType: 'hr_salary_structure',
      entityId: structure.id,
      summary: `Deleted the salary structure from ${structure.effectiveFrom} for employee #${structure.userId}`,
      meta: { userId: structure.userId, effectiveFrom: structure.effectiveFrom, ...structure.totals },
      ipAddress: clientIp(request),
    });

    response.json({ success: true });
  }),
);

/** Who is set up for payroll: approved employees with the structure in force today. */
hrPayrollAdminRouter.get(
  '/payroll/employees',
  adminOnly,
  validateQuery(payrollEmployeesQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as PayrollEmployeesQuery;
    response.json({ success: true, ...(await listPayrollEmployees(filters)) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

hrPayrollAdminRouter.get(
  '/payroll/runs',
  adminOnly,
  validateQuery(runsQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof runsQuerySchema>;
    response.json({ success: true, ...(await listRuns(filters)) });
  }),
);

hrPayrollAdminRouter.post(
  '/payroll/runs',
  ...write(),
  validateBody(createRunSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof createRunSchema>;
    const run = await createRun(input, request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_run_created',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Created the ${monthLabel(run.period)} pay period`,
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, run });
  }),
);

hrPayrollAdminRouter.get(
  '/payroll/runs/:id',
  adminOnly,
  asyncHandler(async (request, response) => {
    response.json({ success: true, run: await getRun(parseId(request.params.id)) });
  }),
);

hrPayrollAdminRouter.get(
  '/payroll/runs/:id/payslips',
  adminOnly,
  validateQuery(runPayslipsQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof runPayslipsQuerySchema>;
    response.json({ success: true, ...(await listRunPayslips(parseId(request.params.id), filters)) });
  }),
);

/** One row per payslip of the run — bounded by the run, so the whole file in one go. */
hrPayrollAdminRouter.get(
  '/payroll/runs/:id/export.csv',
  adminOnly,
  asyncHandler(async (request, response) => {
    const { filename, csv } = await buildRunCsv(parseId(request.params.id));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', contentDisposition(filename));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(csv);
  }),
);

hrPayrollAdminRouter.post(
  '/payroll/runs/:id/process',
  ...write(),
  asyncHandler(async (request, response) => {
    const { run, missingStructure } = await processRun(parseId(request.params.id), request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_run_processed',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Calculated payslips for ${monthLabel(run.period)} (${run.employeeCount} employee${run.employeeCount === 1 ? '' : 's'})`,
      meta: {
        employeeCount: run.employeeCount,
        totalGross: run.totalGross,
        totalDeductions: run.totalDeductions,
        totalNet: run.totalNet,
        missingStructure,
      },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, run, missingStructure });
  }),
);

hrPayrollAdminRouter.post(
  '/payroll/runs/:id/approve',
  ...write(),
  asyncHandler(async (request, response) => {
    const { run, notified } = await approveRun(parseId(request.params.id), request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_run_approved',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Approved payroll for ${monthLabel(run.period)} (${run.employeeCount} employee${run.employeeCount === 1 ? '' : 's'})`,
      meta: { employeeCount: run.employeeCount, totalNet: run.totalNet, notified },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, run, notified });
  }),
);

hrPayrollAdminRouter.delete(
  '/payroll/runs/:id',
  ...write(),
  asyncHandler(async (request, response) => {
    const run = await deleteRun(parseId(request.params.id));

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_run_deleted',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Deleted the ${monthLabel(run.period)} pay period`,
      meta: { status: run.status, employeeCount: run.employeeCount },
      ipAddress: clientIp(request),
    });

    response.json({ success: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Paying in full                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pays an employee in full for the pay period: their loss of pay is waived, for the
 * reason given. ADMIN ONLY, audited, and the period is recalculated straight away.
 */
hrPayrollAdminRouter.put(
  '/payroll/runs/:id/full-pay/:userId',
  ...write(),
  validateBody(fullPaySchema),
  asyncHandler(async (request, response) => {
    const runId = parseId(request.params.id);
    const userId = parseId(request.params.userId);
    const { reason } = request.body as z.infer<typeof fullPaySchema>;
    const { run, employeeName, employeeCode } = await setEmployeeFullPay(runId, userId, reason, request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_full_pay_set',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Paid ${employeeName} (${employeeCode}) in full for ${monthLabel(run.period)}: ${reason}`,
      meta: { userId, reason },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, run });
  }),
);

/** Withdraws it: the employee's loss of pay applies again. */
hrPayrollAdminRouter.delete(
  '/payroll/runs/:id/full-pay/:userId',
  ...write(),
  asyncHandler(async (request, response) => {
    const runId = parseId(request.params.id);
    const userId = parseId(request.params.userId);
    const { run, employeeName, employeeCode } = await clearEmployeeFullPay(runId, userId, request.actor!);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_payroll_full_pay_cleared',
      entityType: 'hr_payroll_run',
      entityId: run.id,
      summary: `Stopped paying ${employeeName} (${employeeCode}) in full for ${monthLabel(run.period)}`,
      meta: { userId },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, run });
  }),
);

/* -------------------------------------------------------------------------- */
/* Payslips                                                                    */
/* -------------------------------------------------------------------------- */

hrPayrollAdminRouter.get(
  '/payroll/payslips/:id',
  adminOnly,
  asyncHandler(async (request, response) => {
    response.json({ success: true, payslip: await getPayslip(parseId(request.params.id)) });
  }),
);

/**
 * The PDF of any payslip, whatever its run's status — an administrator checks a draft
 * before approving it. Inline, so the browser opens it in a tab.
 */
hrPayrollAdminRouter.get(
  '/payroll/payslips/:id/pdf',
  adminOnly,
  asyncHandler(async (request, response) => {
    const payslip = await getPayslip(parseId(request.params.id));
    const body = buildPayslipPdf(payslip);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Length', String(body.length));
    response.setHeader('Content-Disposition', contentDisposition(payslipFilename(payslip), 'inline'));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(body);
  }),
);
