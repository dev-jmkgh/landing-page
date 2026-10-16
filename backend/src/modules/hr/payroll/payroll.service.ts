import { badRequest, conflict, notFound } from '../../../utils/httpError';
import {
  addDays,
  calendarForUsers,
  companyToday,
  payrollSplit,
  type CalendarDay,
} from '../calendar/calendar.service';
import type { Page } from '../hr.schema';
import { notifyHr } from '../notifications/hrNotifications.repository';
import { getHrSettings } from '../settings/hrSettings';
import {
  allRunPayslips,
  componentsFor,
  deleteRunRow,
  deleteStructureIfUnused,
  findPayslip,
  findPayslipForEmployee as findOwnPayslip,
  findRun,
  findRunByPeriod,
  findStructure,
  hrUserExists,
  insertRun,
  insertStructure,
  lastApprovedRun as lastApprovedRunRow,
  latestApprovedPayslipRow,
  listPayrollEmployees as listPayrollEmployeesRows,
  listPayslipsForEmployee as listOwnPayslips,
  listRunPayslips as listRunPayslipsRows,
  listRuns as listRunsRows,
  listStructures as listStructuresRows,
  approveRunRow,
  payrollCandidates,
  payslipOwners,
  replacePayslips,
  runsForYear,
  RunChangedError,
  structureExistsFrom,
  type ComponentRecord,
  type ComputedPayslip,
  type DayTenths,
  type PayrollCandidate,
} from './payroll.repository';
import {
  formatInr,
  longDate,
  monthLabel,
  paiseToDecimal,
  payPeriodBounds,
  periodField,
  prorate,
  toPaise,
  type CreateStructureInput,
  type PayrollEmployee,
  type PayrollEmployeesQuery,
  type PayrollExclusion,
  type PayrollRun,
  type PayrollRunStatus,
  type Payslip,
  type PayslipSummary,
  type SalaryStructure,
} from './payroll.schema';

/**
 * Payroll: salary structures, pay periods, and the arithmetic that turns a period of
 * attendance into a payslip.
 *
 * A PAY PERIOD follows the HR setting `payrollCycleStartDay` — the calendar month by
 * default, or e.g. 26th to 25th — and is named after the month it ends in. Its dates are
 * fixed when it is created.
 *
 * It may be CALCULATED as soon as it has started, and again as often as wanted until it
 * is approved. While it is still running the figures are PROVISIONAL: they cover up to
 * today, and the days still to come are counted as `remaining` — neither paid nor loss
 * of pay. It may be APPROVED only after it has ended AND been calculated since, so every
 * published payslip covers every day of its period.
 *
 * THE COMPUTATION, per employee:
 *
 *   days      every day of the period up to the calculation date is classified by the
 *             HR calendar (`calendarForUsers`) and split for pay by `payrollSplit` — the
 *             SAME two functions the leave balance and the attendance report use, so a
 *             payslip can never disagree with them about a day. Days after it are
 *             `remaining` (see `sumDays`); once the period has ended there are none.
 *               lopDays  = unpaidLeave + absent
 *               paidDays = daysInPeriod − unemployed − lopDays − remaining
 *   earnings  prorated: round_half_up(full × paidDays / daysInPeriod), per line, in paise.
 *             not prorated: the full amount.
 *   deductions  fixed: the full amount, whatever the attendance.
 *   lopAmount = Σ (full − paid) over prorated earnings, for anyone employed all month
 *               (see `computePay` for a joiner or leaver)
 *   gross     = Σ earning amounts (after loss of pay)
 *   net       = max(0, gross − deductions)
 *
 * Note what "unemployed" does: days before joining or after exit reduce paidDays
 * exactly like loss of pay, so a mid-month joiner's prorated earnings are a fraction of
 * the month — but they are NOT loss of pay and are not counted in lopDays or lopAmount.
 *
 * ROUNDING: each prorated line is rounded half up to the paisa on its own (`prorate`);
 * every total is a sum of rounded lines, so the lines always add up to the totals.
 *
 * THE STRUCTURE IN FORCE is the one with the latest effective_from on or before the
 * period end, applied to the whole period. A raise effective on the 20th therefore pays
 * from the 1st of that month; mid-month splits are not modelled.
 */

/**
 * Who is acting. The admin routes pass `request.actor` (an `Actor` fits this shape); the
 * demo seed passes `{ id: null, name: 'Demo seed' }`. Only the id and name are recorded
 * (created_by / processed_by / approved_by, approved_by_name, created_by_name).
 */
export type PayrollOperator = { id: number | null; name: string };

/* -------------------------------------------------------------------------- */
/* The computation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Sums `payrollSplit` over the period, in TENTHS of a day.
 *
 * The split's fractions are halves at most (a half-day leave, a half day worked), and
 * summing them as integers rather than floats is what keeps "27.5" from becoming
 * 27.499999999.
 */
export function sumDays(
  days: CalendarDay[],
  trackedFrom: string | null,
  /**
   * The calculation date for a period still running; omitted once it has ended. Days
   * after it have not happened. Today itself counts as worked if there is attendance
   * for it — somebody who has checked in today has worked today — and as still to come
   * if there is none yet.
   */
  asOf?: string,
): DayTenths {
  const totals: DayTenths = {
    daysInPeriod: days.length * 10,
    unemployed: 0,
    weeklyOff: 0,
    holiday: 0,
    present: 0,
    paidLeave: 0,
    unpaidLeave: 0,
    absent: 0,
    untracked: 0,
    remaining: 0,
    lop: 0,
    paid: 0,
  };
  for (const day of days) {
    const attended = Boolean(
      day.attendance && ['present', 'late', 'half_day'].includes(day.attendance.status),
    );
    if (asOf && day.employed && (day.date > asOf || (day.date === asOf && !attended))) {
      totals.remaining += 10;
      continue;
    }
    const split = payrollSplit(day, trackedFrom);
    totals.unemployed += Math.round(split.unemployed * 10);
    totals.weeklyOff += Math.round(split.weeklyOff * 10);
    totals.holiday += Math.round(split.holiday * 10);
    totals.present += Math.round(split.present * 10);
    totals.paidLeave += Math.round(split.paidLeave * 10);
    totals.unpaidLeave += Math.round(split.unpaidLeave * 10);
    totals.absent += Math.round(split.absent * 10);
    totals.untracked += Math.round(split.untracked * 10);
  }
  totals.lop = totals.unpaidLeave + totals.absent;
  totals.paid = Math.max(0, totals.daysInPeriod - totals.unemployed - totals.lop - totals.remaining);
  return totals;
}

/**
 * Pure: one person's pay for a period, from their components and day counts.
 *
 * LOSS OF PAY is measured against what the person would have earned for the days they
 * were EMPLOYED, not against the full month: per prorated earning,
 *   lop = round(full × employedDays / daysInPeriod) − round(full × paidDays / daysInPeriod)
 * For anyone employed all month the first term is the full amount, so this is exactly
 * Σ(full − paid). For a mid-month joiner it keeps the days before joining out of the
 * figure — otherwise a joiner with perfect attendance would read "LOP days 0, LOP amount
 * 15,000.00" on their payslip.
 */
export function computePay(
  components: ComponentRecord[],
  days: DayTenths,
): Pick<ComputedPayslip, 'grossPaise' | 'lopPaise' | 'deductionsPaise' | 'netPaise' | 'lines'> {
  /*
   * The days a person could have been paid for so far: employed, and already happened.
   * Days still to come in a provisional calculation are not loss of pay.
   */
  const employedTenths = days.daysInPeriod - days.unemployed - days.remaining;
  let gross = 0;
  let lop = 0;
  let deductions = 0;
  const lines: ComputedPayslip['lines'] = [];

  for (const component of components) {
    const full = component.amountPaise;
    if (component.kind === 'deduction') {
      // Fixed: a deduction does not shrink because the person was absent.
      deductions += full;
      lines.push({ label: component.label, kind: 'deduction', fullPaise: full, amountPaise: full, sortOrder: component.sortOrder });
      continue;
    }

    const amount = component.prorated ? prorate(full, days.paid, days.daysInPeriod) : full;
    gross += amount;
    if (component.prorated) lop += prorate(full, employedTenths, days.daysInPeriod) - amount;
    lines.push({ label: component.label, kind: 'earning', fullPaise: full, amountPaise: amount, sortOrder: component.sortOrder });
  }

  return {
    grossPaise: gross,
    lopPaise: Math.max(0, lop),
    deductionsPaise: deductions,
    netPaise: Math.max(0, gross - deductions),
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* Structures                                                                  */
/* -------------------------------------------------------------------------- */

const DUPLICATE_KEY = 1062;
const isDuplicate = (error: unknown) =>
  typeof error === 'object' && error !== null && Number((error as { errno?: unknown }).errno) === DUPLICATE_KEY;

export async function listStructures(userId: number, page: number, pageSize: number): Promise<Page<SalaryStructure>> {
  return listStructuresRows(userId, page, pageSize);
}

export async function createStructure(
  input: CreateStructureInput,
  actor: PayrollOperator,
): Promise<{ structure: SalaryStructure; employee: { name: string; employeeCode: string } }> {
  const employee = await hrUserExists(input.userId);
  if (!employee) throw badRequest('That employee does not exist.', { userId: 'That employee does not exist.' });

  const duplicateMessage = `This employee already has a salary structure from ${longDate(input.effectiveFrom)}. Pick another date.`;
  if (await structureExistsFrom(input.userId, input.effectiveFrom)) {
    throw badRequest(duplicateMessage, { effectiveFrom: duplicateMessage });
  }

  let id: number;
  try {
    id = await insertStructure({
      userId: input.userId,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
      createdBy: actor.id,
      createdByName: actor.name.slice(0, 120),
      components: input.components.map((component) => ({
        label: component.label,
        kind: component.kind,
        amountPaise: Math.round(component.amount * 100),
        prorated: component.kind === 'earning' ? component.prorated !== false : false,
      })),
    });
  } catch (error) {
    // Lost a race with an identical request: the unique key is the real guarantee.
    if (isDuplicate(error)) throw badRequest(duplicateMessage, { effectiveFrom: duplicateMessage });
    throw error;
  }

  return { structure: (await findStructure(id))!, employee };
}

export async function deleteStructure(id: number): Promise<SalaryStructure> {
  const structure = await findStructure(id);
  if (!structure) throw notFound('Salary structure not found.');

  const outcome = await deleteStructureIfUnused(id);
  if (outcome === 'missing') throw notFound('Salary structure not found.');
  if (outcome === 'in_use') {
    throw badRequest(
      'This structure was used for a payslip, so it is kept as the record of what was paid. Add a new structure with a later date instead.',
    );
  }
  return structure;
}

export async function listPayrollEmployees(filters: PayrollEmployeesQuery): Promise<Page<PayrollEmployee>> {
  return listPayrollEmployeesRows({ ...filters, today: companyToday() });
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

export async function listRuns(filters: {
  status?: PayrollRunStatus;
  page: number;
  pageSize: number;
}): Promise<Page<PayrollRun>> {
  return listRunsRows(filters);
}

export async function getRun(id: number): Promise<PayrollRun> {
  const run = await findRun(id);
  if (!run) throw notFound('Pay period not found.');
  return run;
}

export async function createRun(input: { period: string; note: string | null }, actor: PayrollOperator): Promise<PayrollRun> {
  const { payrollCycleStartDay } = await getHrSettings();
  const { start, end } = payPeriodBounds(input.period, payrollCycleStartDay);

  /*
   * Started, or in the past. A period that has not begun has nothing to calculate and
   * could only be a typo.
   */
  if (start > companyToday()) {
    const message = `The ${monthLabel(input.period)} pay period starts on ${longDate(start)}.`;
    throw badRequest(message, { period: message });
  }

  const duplicateMessage = `There is already a pay period for ${monthLabel(input.period)}.`;
  if (await findRunByPeriod(input.period)) throw badRequest(duplicateMessage, { period: duplicateMessage });

  let id: number;
  try {
    id = await insertRun({ period: input.period, periodStart: start, periodEnd: end, note: input.note, createdBy: actor.id });
  } catch (error) {
    if (isDuplicate(error)) throw badRequest(duplicateMessage, { period: duplicateMessage });
    throw error;
  }
  return (await findRun(id))!;
}

/** How many users go into one calendar query. The calendar's IN lists stay short. */
const CALENDAR_BATCH = 200;

/**
 * Computes every payslip for a run and replaces the run's payslips with them.
 *
 * Reads first, writes second: the calendar and structures are read through the pool,
 * then `replacePayslips` writes everything in one transaction that re-checks the run
 * under a row lock. Repeating it is safe and gives the same result for the same data —
 * which is what "re-process" means.
 *
 * Returns the run and how many employed people were left out for having no salary
 * structure, so the screen can say so instead of silently paying fewer people.
 */
export async function processRun(
  runId: number,
  actor: PayrollOperator,
): Promise<{ run: PayrollRun; missingStructure: number }> {
  const run = await getRun(runId);
  if (run.status === 'approved') {
    throw badRequest('This pay period has been approved, so its payslips can no longer change.');
  }

  const today = companyToday();
  if (run.periodStart > today) {
    throw badRequest(`This pay period starts on ${longDate(run.periodStart)}.`);
  }

  /*
   * Ended: every day is judged. Still running: judged up to today, the rest is
   * `remaining` — see the note at the top of this file.
   */
  const ended = run.periodEnd < today;
  const calculatedThrough = ended ? run.periodEnd : today;

  const [settings, candidates] = await Promise.all([
    getHrSettings(),
    payrollCandidates(run.periodStart, run.periodEnd),
  ]);

  const withStructure = candidates.filter(
    (candidate): candidate is PayrollCandidate & { structureId: number } => candidate.structureId !== null,
  );
  const missingStructure = candidates.length - withStructure.length;

  /*
   * Everybody employed in the period who will get no payslip, by name and with the
   * reason — "0 employees" on its own sent people looking for a bug.
   */
  const exclusions: PayrollExclusion[] = candidates
    .filter((candidate) => candidate.structureId === null)
    .map((candidate) => ({
      userId: candidate.userId,
      employeeCode: candidate.employeeCode,
      employeeName: candidate.employeeName,
      reason: candidate.nextStructureFrom ? 'structure_starts_later' : 'no_structure',
      structureFrom: candidate.nextStructureFrom,
    }));

  const components = await componentsFor([...new Set(withStructure.map((c) => c.structureId))]);

  const slips: ComputedPayslip[] = [];
  for (let start = 0; start < withStructure.length; start += CALENDAR_BATCH) {
    const batch = withStructure.slice(start, start + CALENDAR_BATCH);
    const calendars = await calendarForUsers(
      batch.map((candidate) => candidate.userId),
      run.periodStart,
      run.periodEnd,
      // Ended: the day after the period, so every day in it is judged. Running: today.
      { today: ended ? addDays(run.periodEnd, 1) : today },
    );

    for (const candidate of batch) {
      const days = sumDays(
        calendars.get(candidate.userId) ?? [],
        settings.attendanceTrackedFrom,
        ended ? undefined : today,
      );
      // The SQL filter and the calendar agree on employment dates; this is the backstop.
      if (days.daysInPeriod === 0 || days.unemployed >= days.daysInPeriod) continue;
      slips.push({
        ...candidate,
        days,
        ...computePay(components.get(candidate.structureId) ?? [], days),
      });
    }
  }

  try {
    await replacePayslips(runId, slips, actor.id, { calculatedThrough, exclusions });
  } catch (error) {
    if (error instanceof RunChangedError) {
      if (error.reason === 'missing') throw notFound('Pay period not found.');
      if (error.reason === 'approved') {
        throw badRequest('This pay period was approved while it was being calculated, so its payslips were not changed.');
      }
      throw conflict(
        'A salary structure was removed while this pay period was being calculated. Calculate it again.',
        'structures_changed',
      );
    }
    throw error;
  }

  return { run: await getRun(runId), missingStructure };
}

/**
 * Approves a processed run: it is frozen from here on, and every payslip owner is told
 * their payslip is ready. Only now can employees see it.
 *
 * One notification per payslip, so each carries its own payslip id for the app to open.
 * The dedupe key makes a retried approval (or a second click that lost the race) unable
 * to notify anyone twice.
 */
export async function approveRun(runId: number, actor: PayrollOperator): Promise<{ run: PayrollRun; notified: number }> {
  const run = await getRun(runId);
  if (run.status === 'approved') throw badRequest('This pay period has already been approved.');
  if (run.status === 'draft') throw badRequest('Calculate the payslips before approving them.');
  /*
   * Only figures that cover the whole period are published. A calculation made while
   * the period was running is a preview: approving it would freeze pay for days nobody
   * had worked yet.
   */
  if (companyToday() <= run.periodEnd) {
    throw badRequest(
      `This pay period runs until ${longDate(run.periodEnd)}. Recalculate on or after ${longDate(addDays(run.periodEnd, 1))}, then approve.`,
    );
  }
  if (run.provisional || run.calculatedThrough === null) {
    throw badRequest('These figures were calculated before the period ended. Recalculate, then approve.');
  }
  if (run.employeeCount === 0) {
    throw badRequest('There are no payslips in this pay period to approve. Add salary structures and calculate again.');
  }

  const applied = await approveRunRow(runId, { id: actor.id, name: actor.name });
  if (!applied) throw badRequest('This pay period could not be approved. Reload it and try again.');

  const label = monthLabel(run.period);
  let notified = 0;
  for (const owner of await payslipOwners(runId)) {
    notified += await notifyHr({
      userIds: [owner.userId],
      kind: 'payslip_published',
      title: `Your payslip for ${label} is ready`,
      body: 'Open Payslips to view or download it.',
      entityType: 'hr_payslip',
      entityId: owner.payslipId,
      dedupeKey: `payslip:${owner.payslipId}`,
    });
  }

  return { run: await getRun(runId), notified };
}

export async function deleteRun(runId: number): Promise<PayrollRun> {
  const run = await getRun(runId);
  if (run.status === 'approved') {
    throw badRequest('An approved pay period is the record of what was paid and cannot be deleted.');
  }
  if (!(await deleteRunRow(runId))) {
    // Approved between the read and the delete.
    throw badRequest('An approved pay period is the record of what was paid and cannot be deleted.');
  }
  return run;
}

/**
 * Demo data: creates the run for `period` if it is missing, processes it and approves it,
 * as a system operator — the SAME create/process/approve paths the admin routes use, so
 * demo payslips come out of the real arithmetic. Called by `scripts/seed-hr-demo.ts`
 * against the demo database only. Not audited: there is no administrator behind it.
 *
 * An already-approved run is left as it is (approval freezes it) and only reported. A
 * run nobody can be paid in (no structures) is processed but left unapproved, because
 * an empty approved month could never be processed again.
 */
export async function seedDemoRun(period: string): Promise<string> {
  const parsed = periodField.safeParse(period);
  if (!parsed.success) throw new Error(`seedDemoRun: "${period}" is not a YYYY-MM period.`);

  const operator: PayrollOperator = { id: null, name: 'Demo seed' };
  let run = (await findRunByPeriod(parsed.data)) ?? (await createRun({ period: parsed.data, note: 'Demo data' }, operator));

  if (run.status !== 'approved') {
    run = (await processRun(run.id, operator)).run;
    if (run.employeeCount > 0) run = (await approveRun(run.id, operator)).run;
  }

  const payslips = `${run.employeeCount} payslip${run.employeeCount === 1 ? '' : 's'}`;
  return `Payroll ${run.period}: ${payslips}, net INR ${formatInr(toPaise(run.totalNet))}, ${run.status}`;
}

/* -------------------------------------------------------------------------- */
/* Payslips                                                                    */
/* -------------------------------------------------------------------------- */

export async function listRunPayslips(
  runId: number,
  filters: { q?: string; page: number; pageSize: number },
): Promise<Page<Payslip>> {
  await getRun(runId);
  return listRunPayslipsRows(runId, filters);
}

/** Admin: any payslip, any run status. */
export async function getPayslip(id: number): Promise<Payslip> {
  const payslip = await findPayslip(id);
  if (!payslip) throw notFound('Payslip not found.');
  return payslip;
}

/** Employee: own, approved runs only. */
export async function listPayslipsForEmployee(
  userId: number,
  filters: { year?: number; page: number; pageSize: number },
): Promise<Page<PayslipSummary>> {
  return listOwnPayslips(userId, filters);
}

/** Employee: own and approved, else null — the routes answer 404 either way. */
export async function findPayslipForEmployee(id: number, userId: number): Promise<Payslip | null> {
  return findOwnPayslip(id, userId);
}

/**
 * The employee's newest payslip from an APPROVED run, or null. For the HR app
 * dashboard (`reports/dashboard.routes.ts`).
 */
export async function latestApprovedPayslip(
  userId: number,
): Promise<{ id: number; period: string; netPay: number } | null> {
  return latestApprovedPayslipRow(userId);
}

/** The newest approved run, or null. For the admin dashboard (admins only). */
export async function lastApprovedRun(): Promise<PayrollRun | null> {
  return lastApprovedRunRow();
}

/** Runs of one calendar year, oldest first (≤ 12). For the admin payroll report. */
export async function payrollRunsForYear(year: number): Promise<PayrollRun[]> {
  return runsForYear(year);
}

/** `payslip-2026-09-EMP-0012.pdf` — the file name both the app link and the admin view use. */
export function payslipFilename(payslip: Pick<Payslip, 'period' | 'employeeCode'>): string {
  const code = payslip.employeeCode.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `payslip-${payslip.period}-${code}.pdf`;
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A CSV value. Quoted when needed; text that would run as a formula once the file is
 * opened in Excel (=, +, -, @, tab, CR at the start) is prefixed with an apostrophe —
 * employee names are typed by the employees themselves at signup.
 */
function csvText(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_HEADER = [
  'Employee code',
  'Employee name',
  'Department',
  'Designation',
  'Days in period',
  'Not employed days',
  'Weekly offs',
  'Holidays',
  'Present days',
  'Paid leave days',
  'Unpaid leave days',
  'Absent days',
  'Untracked days',
  'LOP days',
  'Paid days',
  'Gross earnings',
  'LOP amount',
  'Total deductions',
  'Net pay',
];

const csvDays = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const csvMoney = (value: number) => paiseToDecimal(Math.round(value * 100));

/** One row per payslip of the run, with a UTF-8 BOM so Excel keeps non-English names intact. */
export async function buildRunCsv(runId: number): Promise<{ filename: string; csv: string }> {
  const run = await getRun(runId);
  const payslips = await allRunPayslips(runId);

  const rows = payslips.map((slip) =>
    [
      csvText(slip.employeeCode),
      csvText(slip.employeeName),
      csvText(slip.departmentName),
      csvText(slip.designationName),
      csvDays(slip.daysInPeriod),
      csvDays(slip.unemployedDays),
      csvDays(slip.weeklyOffDays),
      csvDays(slip.holidayDays),
      csvDays(slip.presentDays),
      csvDays(slip.paidLeaveDays),
      csvDays(slip.unpaidLeaveDays),
      csvDays(slip.absentDays),
      csvDays(slip.untrackedDays),
      csvDays(slip.lopDays),
      csvDays(slip.paidDays),
      csvMoney(slip.grossEarnings),
      csvMoney(slip.lopAmount),
      csvMoney(slip.totalDeductions),
      csvMoney(slip.netPay),
    ].join(','),
  );

  return {
    filename: `payroll-${run.period}.csv`,
    csv: `﻿${[CSV_HEADER.map(csvText).join(','), ...rows].join('\r\n')}\r\n`,
  };
}
