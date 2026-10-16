import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../../middleware/hrActor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateQuery } from '../../../middleware/validate';
import { notFound } from '../../../utils/httpError';
import { createHrFileLink } from '../files/hrFileLinks';
import { employeePayslipsQuerySchema } from './payroll.schema';
import { findPayslipForEmployee, listPayslipsForEmployee } from './payroll.service';

/**
 * The employee's own payslips — the HR app, Bearer-only through `requireHrActor`.
 *
 * Every route acts on the SIGNED-IN employee, and only ever shows payslips of APPROVED
 * runs: a draft or processed payslip is still being checked by HR and may change, so it
 * does not exist as far as the app is concerned. Somebody else's payslip and a draft are
 * the same 404.
 */
export const hrPayslipsRouter = Router();

hrPayslipsRouter.use(requireHrActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Payslip not found.');
  return result.data;
}

/** `?year&page&pageSize` — newest month first. */
hrPayslipsRouter.get(
  '/',
  validateQuery(employeePayslipsQuerySchema),
  asyncHandler(async (request, response) => {
    const filters = response.locals.query as z.infer<typeof employeePayslipsQuerySchema>;
    response.json({ success: true, ...(await listPayslipsForEmployee(request.hrActor!.id, filters)) });
  }),
);

hrPayslipsRouter.get(
  '/:id',
  asyncHandler(async (request, response) => {
    const payslip = await findPayslipForEmployee(parseId(request.params.id), request.hrActor!.id);
    if (!payslip) throw notFound('Payslip not found.');
    response.json({ success: true, payslip });
  }),
);

/**
 * A five-minute download link for the PDF. Ownership and approval are checked here, and
 * again when the link is followed (`renderPayslipForEmployee`).
 */
hrPayslipsRouter.post(
  '/:id/link',
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const userId = request.hrActor!.id;
    if (!(await findPayslipForEmployee(id, userId))) throw notFound('Payslip not found.');
    response.json({ success: true, ...createHrFileLink({ userId, kind: 'payslip', id }) });
  }),
);
