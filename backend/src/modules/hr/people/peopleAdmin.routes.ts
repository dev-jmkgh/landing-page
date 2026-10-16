import { Router } from 'express';
import { z } from 'zod';
import {
  requireActor,
  requireCsrfForCookieSession,
  requireRole,
} from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { validateBody, validateQuery } from '../../../middleware/validate';
import { badRequest, notFound } from '../../../utils/httpError';
import { clientIp } from '../../../utils/request';
import { recordAudit } from '../../telecalling/activity/activity.repository';
import { assignmentFor, historyFor, summaryFor } from '../attendance/attendance.service';
import { calendarFor, companyToday, monthBounds } from '../calendar/calendar.service';
import { listHrUsers } from '../hr.repository';
import { getHrSettings, updateHrSettings } from '../settings/hrSettings';
import {
  attendancePage,
  countDirectReports,
  departmentNameTaken,
  designationNameTaken,
  findAccountState,
  findDepartment,
  findDesignation,
  findEmployee,
  insertDepartment,
  insertDesignation,
  listDepartments,
  listDesignations,
  updateDepartment,
  updateDesignation,
} from './people.repository';
import {
  departmentCreateSchema,
  departmentPatchSchema,
  designationCreateSchema,
  designationPatchSchema,
  directoryQuerySchema,
  employeeAttendanceQuerySchema,
  employeeCalendarQuerySchema,
  employeeCreateSchema,
  employeePatchSchema,
  settingsPatchSchema,
  type EmployeeCreateInput,
  type EmployeePatchInput,
} from './people.schema';
import { createEmployee, updateEmployee } from './people.service';

/**
 * Employee records, departments, designations and HR settings — admin portal, mounted at `/api/admin/hr`.
 *
 * Authenticates as an ADMINISTRATOR (see the note at the top of `hrAdmin.routes.ts`).
 * Reads are `requireRole('supervisor')` unless stated; writes are
 * `requireRole('admin')` plus `requireCsrfForCookieSession`. Every write is audited with
 * an `hr_`-prefixed entity type, so the HR audit trail can be read on its own.
 */
export const hrPeopleAdminRouter = Router();

hrPeopleAdminRouter.use(requireActor);

const idParam = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParam.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

/** Minimum role plus CSRF for a cookie session. Same chain the other admin routers use. */
const write = () => [requireRole('admin'), requireCsrfForCookieSession];

/* -------------------------------------------------------------------------- */
/* Departments                                                                 */
/* -------------------------------------------------------------------------- */

hrPeopleAdminRouter.get(
  '/departments',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listDepartments() });
  }),
);

hrPeopleAdminRouter.post(
  '/departments',
  ...write(),
  validateBody(departmentCreateSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof departmentCreateSchema>;

    if (await departmentNameTaken(input.name, null)) {
      throw badRequest('A department with that name already exists.', {
        name: 'A department with that name already exists.',
      });
    }

    const id = await insertDepartment(input.name, input.code ?? null);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_department_created',
      entityType: 'hr_department',
      entityId: id,
      summary: `Created department ${input.name}`,
      meta: { code: input.code ?? null },
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, department: await findDepartment(id) });
  }),
);

hrPeopleAdminRouter.patch(
  '/departments/:id',
  ...write(),
  validateBody(departmentPatchSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as z.infer<typeof departmentPatchSchema>;

    const before = await findDepartment(id);
    if (!before) throw notFound('Department not found.');

    if (input.name !== undefined && (await departmentNameTaken(input.name, id))) {
      throw badRequest('A department with that name already exists.', {
        name: 'A department with that name already exists.',
      });
    }

    await updateDepartment(id, input);
    const after = await findDepartment(id);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_department_updated',
      entityType: 'hr_department',
      entityId: id,
      summary: `Updated department ${before.name}`,
      meta: {
        before: { name: before.name, code: before.code, isActive: before.isActive },
        after: { name: after?.name, code: after?.code, isActive: after?.isActive },
      },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, department: after });
  }),
);

/* -------------------------------------------------------------------------- */
/* Designations                                                                */
/* -------------------------------------------------------------------------- */

hrPeopleAdminRouter.get(
  '/designations',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, items: await listDesignations() });
  }),
);

hrPeopleAdminRouter.post(
  '/designations',
  ...write(),
  validateBody(designationCreateSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof designationCreateSchema>;

    if (await designationNameTaken(input.name, null)) {
      throw badRequest('A designation with that name already exists.', {
        name: 'A designation with that name already exists.',
      });
    }

    const id = await insertDesignation(input.name);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_designation_created',
      entityType: 'hr_designation',
      entityId: id,
      summary: `Created designation ${input.name}`,
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, designation: await findDesignation(id) });
  }),
);

hrPeopleAdminRouter.patch(
  '/designations/:id',
  ...write(),
  validateBody(designationPatchSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as z.infer<typeof designationPatchSchema>;

    const before = await findDesignation(id);
    if (!before) throw notFound('Designation not found.');

    if (input.name !== undefined && (await designationNameTaken(input.name, id))) {
      throw badRequest('A designation with that name already exists.', {
        name: 'A designation with that name already exists.',
      });
    }

    await updateDesignation(id, input);
    const after = await findDesignation(id);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_designation_updated',
      entityType: 'hr_designation',
      entityId: id,
      summary: `Updated designation ${before.name}`,
      meta: {
        before: { name: before.name, isActive: before.isActive },
        after: { name: after?.name, isActive: after?.isActive },
      },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, designation: after });
  }),
);

/* -------------------------------------------------------------------------- */
/* The employee directory                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The directory, one page at a time, alphabetical.
 *
 * Every approval state is included unless `approval` narrows it — the registrations
 * queue is the same population in a different order, and the directory is where an
 * administrator finds somebody whatever state their account is in.
 */
hrPeopleAdminRouter.get(
  '/employees',
  requireRole('supervisor'),
  validateQuery(directoryQuerySchema),
  asyncHandler(async (_request, response) => {
    const filters = response.locals.query as z.infer<typeof directoryQuerySchema>;
    const result = await listHrUsers({ ...filters, sort: 'name' });
    response.json({ success: true, ...result });
  }),
);

hrPeopleAdminRouter.get(
  '/employees/:id',
  requireRole('supervisor'),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const employee = await findEmployee(id);
    if (!employee) throw notFound('Employee not found.');
    response.json({ success: true, employee, directReports: await countDirectReports(id) });
  }),
);

/**
 * Creates an employee directly. ADMIN ONLY.
 *
 * The administrator is vouching for the person, so the account skips the signup path's
 * two gates — email confirmation and approval — and can sign in at once with the
 * password set here. That is the whole difference from signup; everything else (code
 * series, password rules, hashing) is shared with it.
 */
hrPeopleAdminRouter.post(
  '/employees',
  ...write(),
  validateBody(employeeCreateSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as EmployeeCreateInput;

    const { id, employeeCode } = await createEmployee(input, request.actor!.id);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_employee_created',
      entityType: 'hr_user',
      entityId: id,
      summary: `Created HR employee ${input.name} (${employeeCode})`,
      meta: {
        role: input.role,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        managerId: input.managerId ?? null,
        joiningDate: input.joiningDate ?? null,
        employmentType: input.employmentType,
        employmentStatus: input.employmentStatus,
      },
      ipAddress: clientIp(request),
    });

    response.status(201).json({ success: true, employee: await findEmployee(id) });
  }),
);

/**
 * Edits an employee record. ADMIN ONLY.
 *
 * A ROLE change is written now but reaches the app at the employee's next token refresh:
 * the access token carries the role and stays valid for its remaining minutes. The
 * response says so in `notice`, so the administrator is not surprised that a new manager
 * cannot see their team for a few minutes.
 */
hrPeopleAdminRouter.patch(
  '/employees/:id',
  ...write(),
  validateBody(employeePatchSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const input = request.body as EmployeePatchInput;

    const changes = await updateEmployee(id, input);
    const employee = await findEmployee(id);

    if (changes.length > 0) {
      await recordAudit({
        actor: request.actor!,
        action: 'hr_employee_updated',
        entityType: 'hr_user',
        entityId: id,
        summary: `Updated ${employee?.name ?? 'employee'} (${employee?.employeeCode ?? id}): ${changes
          .map((change) => change.field)
          .join(', ')}`,
        meta: {
          before: Object.fromEntries(changes.map((change) => [change.field, change.before])),
          after: Object.fromEntries(changes.map((change) => [change.field, change.after])),
        },
        ipAddress: clientIp(request),
      });
    }

    const roleChanged = changes.some((change) => change.field === 'role');

    response.json({
      success: true,
      employee,
      changed: changes.map((change) => change.field),
      notice: roleChanged
        ? 'The new role takes effect the next time their app refreshes its session, within a few minutes.'
        : null,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* One employee's attendance                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An employee's recorded days, newest first, a page at a time. Defaults to the current
 * month in the COMPANY's calendar.
 */
hrPeopleAdminRouter.get(
  '/employees/:id/attendance',
  requireRole('supervisor'),
  validateQuery(employeeAttendanceQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const filters = response.locals.query as z.infer<typeof employeeAttendanceQuerySchema>;

    if (!(await findAccountState(id))) throw notFound('Employee not found.');

    const today = companyToday();
    const from = filters.from ?? `${today.slice(0, 7)}-01`;
    const to = filters.to ?? today;
    if (from > to) {
      throw badRequest('The start date must be on or before the end date.', {
        from: 'The start date must be on or before the end date.',
      });
    }

    const page = await attendancePage(id, from, to, filters);
    response.json({ success: true, from, to, ...page });
  }),
);

/** One month as a calendar — the same classification the employee sees in the app. */
hrPeopleAdminRouter.get(
  '/employees/:id/calendar',
  requireRole('supervisor'),
  validateQuery(employeeCalendarQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { month } = response.locals.query as z.infer<typeof employeeCalendarQuerySchema>;

    if (!(await findAccountState(id))) throw notFound('Employee not found.');

    const period = month ?? companyToday().slice(0, 7);
    const { start, end } = monthBounds(period);
    const days = await calendarFor(id, start, end, { includePending: true });
    response.json({ success: true, month: period, days });
  }),
);

/**
 * One employee's month for the attendance view: every date as the classifier sees it,
 * each with its recorded day — punches included — beside it, the month's totals, and the
 * shift they are on now.
 *
 * The calendar alone cannot draw a punch timeline (it carries first in and last out, not
 * the sessions), and the paged attendance list cannot draw a calendar (a day with no row
 * is invisible there). A month is at most 31 days, so both are read whole: a bounded
 * aggregate the same size as the calendar it extends, in four queries however many days
 * have punches.
 *
 * `shift` is the CURRENT assignment, for the timeline's shift band on days with no record.
 * A recorded day carries its own shift snapshot (`record.shiftStartsAt`), which wins.
 */
hrPeopleAdminRouter.get(
  '/employees/:id/attendance-month',
  requireRole('supervisor'),
  validateQuery(employeeCalendarQuerySchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { month } = response.locals.query as z.infer<typeof employeeCalendarQuerySchema>;

    if (!(await findAccountState(id))) throw notFound('Employee not found.');

    const period = month ?? companyToday().slice(0, 7);
    const { start, end } = monthBounds(period);
    const [days, recorded, summary, assignment] = await Promise.all([
      calendarFor(id, start, end, { includePending: true }),
      historyFor(id, start, end),
      summaryFor(id, start, end),
      assignmentFor(id),
    ]);

    const byDate = new Map(recorded.map((day) => [day.workDate, day]));
    const shift = assignment.shift;

    response.json({
      success: true,
      month: period,
      shift: shift
        ? { name: shift.name, startsAt: shift.startsAt, endsAt: shift.endsAt, breakMinutes: shift.breakMinutes }
        : null,
      summary,
      days: days.map((day) => ({ ...day, record: byDate.get(day.date) ?? null })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* HR settings                                                                 */
/* -------------------------------------------------------------------------- */

hrPeopleAdminRouter.get(
  '/settings',
  requireRole('supervisor'),
  asyncHandler(async (_request, response) => {
    response.json({ success: true, settings: await getHrSettings() });
  }),
);

/**
 * Company-wide HR policy. ADMIN ONLY.
 *
 * These two values change how every past and future day is classified — payroll's loss
 * of pay included — so the audit row carries the before and after in full.
 */
hrPeopleAdminRouter.patch(
  '/settings',
  ...write(),
  validateBody(settingsPatchSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof settingsPatchSchema>;

    const before = await getHrSettings();
    const after = await updateHrSettings(input, request.actor!.id);

    await recordAudit({
      actor: request.actor!,
      action: 'hr_settings_updated',
      entityType: 'hr_settings',
      summary: `Updated HR settings: ${Object.keys(input)
        .filter((key) => input[key as keyof typeof input] !== undefined)
        .join(', ')}`,
      meta: { before, after },
      ipAddress: clientIp(request),
    });

    response.json({ success: true, settings: after });
  }),
);
