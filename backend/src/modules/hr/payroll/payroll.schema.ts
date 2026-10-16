import { z } from 'zod';
import { isIsoDate } from '../calendar/calendar.service';
import { isoDateField, pageQuerySchema } from '../hr.schema';

/**
 * Payroll vocabulary: the records the API returns, the request schemas, and the money
 * arithmetic every other payroll file leans on.
 *
 * MONEY IS INTEGER PAISE INSIDE THE SERVER. The database holds DECIMAL(12,2), which the
 * driver returns as a STRING ("30000.00"), and the API carries plain numbers with at most
 * two decimals. Everything in between — proration, totals, the CSV, the PDF — works in
 * whole paise, because a float cannot hold 0.10 and payroll is the one place a stray
 * paisa becomes a dispute. Conversions happen only at the two edges, in the helpers
 * below, and nowhere else.
 */

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A DECIMAL value from the driver (or a number) as integer paise.
 *
 * Parsed from the string digit by digit rather than with `Number(x) * 100`, so
 * "1234567.29" cannot become 123456728.99999999 on the way in. Anything past the second
 * decimal is ignored — DECIMAL(12,2) never has it.
 */
export function toPaise(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const match = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(value);
  if (!match) return 0;
  const rupees = Number(match[2] || '0');
  const fraction = Number(((match[3] ?? '') + '00').slice(0, 2));
  const paise = rupees * 100 + fraction;
  return match[1] === '-' ? -paise : paise;
}

/** Paise as the API's number: 4010050 → 40100.5 (JSON has no trailing zeros). */
export function paiseToAmount(paise: number): number {
  return paise / 100;
}

/** Paise as a DECIMAL literal for the database and the CSV: 4010050 → "40100.50". */
export function paiseToDecimal(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Indian digit grouping for people to read: 12345678 paise → "1,23,456.78".
 *
 * Lakh/crore grouping (last three digits, then pairs) because that is how every
 * employee of an Indian company reads a salary; "123,456.78" looks like a typo to them.
 */
export function formatInr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  const digits = String(Math.floor(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');

  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);

  return `${sign}${[...groups, lastThree].join(',')}.${fraction}`;
}

/**
 * `fullPaise × paidTenths / periodTenths`, rounded HALF UP to the paisa.
 *
 * THE ROUNDING RULE, stated once: a prorated earning is the exact fraction of the full
 * monthly amount, rounded to the nearest paisa, with an exact half (x.5 paise) going UP.
 * Each line is rounded on its own; totals are sums of rounded lines, so the payslip's
 * lines always add up to its totals.
 *
 * Day counts arrive in TENTHS (27.5 days = 275) so the whole calculation is integer
 * arithmetic. BigInt because full × tenths can pass 2^53 for a large salary over a long
 * month (10^9 paise × 310), where a float would start dropping the last paisa.
 */
export function prorate(fullPaise: number, paidTenths: number, periodTenths: number): number {
  if (periodTenths <= 0 || paidTenths <= 0 || fullPaise <= 0) return 0;
  if (paidTenths >= periodTenths) return fullPaise;
  const numerator = BigInt(fullPaise) * BigInt(paidTenths);
  const denominator = BigInt(periodTenths);
  // floor((2n + d) / 2d) is n/d rounded half up, for non-negative n.
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const COMPONENT_KINDS = ['earning', 'deduction'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const PAYROLL_RUN_STATUSES = ['draft', 'processed', 'approved'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/** The name printed on every payslip. */
export const COMPANY_NAME = 'JMK Global Holdings';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** `2026-09` → "September 2026". */
export function monthLabel(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[month - 1] ?? period} ${year}`;
}

/** `2026-11-01` → "1 November 2026", for messages a person reads. */
export function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTH_NAMES[month - 1] ?? ''} ${year}`;
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type SalaryComponent = {
  id: number;
  label: string;
  kind: ComponentKind;
  /** The full monthly amount, before any loss of pay. */
  amount: number;
  /** Earnings only: reduced in proportion to paid days. Always false for a deduction. */
  prorated: boolean;
  sortOrder: number;
};

export type SalaryStructure = {
  id: number;
  userId: number;
  /** `YYYY-MM-DD`. In force for every period ending on or after it, until a later one. */
  effectiveFrom: string;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  /** A payslip was computed from it, so it can no longer be deleted. */
  inUse: boolean;
  components: SalaryComponent[];
  /** Full-month figures: what the structure pays with no loss of pay. */
  totals: { earnings: number; deductions: number; net: number };
};

export type PayrollRun = {
  id: number;
  /** `YYYY-MM`. */
  period: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  employeeCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  note: string | null;
  processedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  createdAt: string;
  /** The first company date the run may be processed on (the day after the period ends). */
  processableFrom: string;
};

export type PayslipLine = {
  label: string;
  kind: ComponentKind;
  fullAmount: number;
  amount: number;
};

export type Payslip = {
  id: number;
  runId: number;
  period: string;
  periodStart: string;
  periodEnd: string;
  runStatus: PayrollRunStatus;
  approvedAt: string | null;
  userId: number;
  structureId: number | null;
  employeeCode: string;
  employeeName: string;
  departmentName: string | null;
  designationName: string | null;
  daysInPeriod: number;
  unemployedDays: number;
  weeklyOffDays: number;
  holidayDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  untrackedDays: number;
  lopDays: number;
  paidDays: number;
  grossEarnings: number;
  lopAmount: number;
  totalDeductions: number;
  netPay: number;
  lines: PayslipLine[];
};

/** One row of the employee's payslip list. */
export type PayslipSummary = {
  id: number;
  period: string;
  periodStart: string;
  periodEnd: string;
  netPay: number;
  grossEarnings: number;
  totalDeductions: number;
  lopDays: number;
  paidDays: number;
  approvedAt: string | null;
};

/** One row of "who is set up for payroll". */
export type PayrollEmployee = {
  user: {
    id: number;
    employeeCode: string;
    name: string;
    email: string;
    isActive: boolean;
    departmentId: number | null;
    departmentName: string | null;
    designationName: string | null;
    joiningDate: string | null;
    exitDate: string | null;
    employmentStatus: string;
  };
  /** In force today (latest effective_from on or before today), or null. */
  currentStructure: SalaryStructure | null;
  /** The next future-dated structure, if one is already entered. */
  upcomingStructure: SalaryStructure | null;
};

/* -------------------------------------------------------------------------- */
/* Request schemas                                                             */
/* -------------------------------------------------------------------------- */

const validDate = isoDateField.refine(isIsoDate, 'Enter a real date.');

/** `YYYY-MM`, a real month from 2000 on. */
export const periodField = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.')
  .refine((value) => Number(value.slice(0, 4)) >= 2000, 'Choose a month from 2000 onwards.');

const optionalNote = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep the note to ${max} characters or fewer.`)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null));

/** Whole paise only: 1234.5 and 1234.56 are fine, 1234.567 is not. */
const amountField = z
  .number({ required_error: 'Enter an amount.', invalid_type_error: 'Enter an amount.' })
  .min(0, 'An amount cannot be negative.')
  .max(10_000_000, 'Keep each amount to 1,00,00,000 or less.')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'Use at most two decimal places.');

export const componentInputSchema = z.object({
  label: z.string({ required_error: 'Name the component.' }).trim().min(1, 'Name the component.').max(80),
  kind: z.enum(COMPONENT_KINDS),
  amount: amountField,
  /** Earnings only; defaults to true. Ignored (stored false) for a deduction. */
  prorated: z.boolean().optional(),
});

export const createStructureSchema = z
  .object({
    userId: z.coerce.number().int().positive(),
    effectiveFrom: validDate,
    note: optionalNote(255),
    components: z
      .array(componentInputSchema)
      .min(1, 'Add at least one component.')
      .max(30, 'A structure can have at most 30 components.'),
  })
  .superRefine((value, context) => {
    const sum = (kind: ComponentKind) =>
      value.components
        .filter((component) => component.kind === kind)
        .reduce((total, component) => total + Math.round(component.amount * 100), 0);
    const earnings = sum('earning');
    const deductions = sum('deduction');
    if (earnings <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['components'],
        message: 'Add at least one earning above zero.',
      });
    } else if (deductions > earnings) {
      /*
       * Not in the brief, but a structure that pays less than nothing in a full month is
       * a typing mistake, not a policy — refused here, where it can be corrected, rather
       * than discovered as a string of zero payslips.
       */
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['components'],
        message: 'Deductions cannot be more than earnings.',
      });
    }
  });
export type CreateStructureInput = z.infer<typeof createStructureSchema>;

export const structuresQuerySchema = pageQuerySchema.extend({
  userId: z.coerce.number().int().positive(),
  // A history is a few rows a year; 50 per page shows a decade at once.
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

export const payrollEmployeesQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  /** 'true' = has at least one structure (current or upcoming); 'false' = has none. */
  setUp: z.enum(['true', 'false']).optional(),
});
export type PayrollEmployeesQuery = z.infer<typeof payrollEmployeesQuerySchema>;

export const createRunSchema = z.object({
  period: periodField,
  note: optionalNote(500),
});

export const runsQuerySchema = pageQuerySchema.extend({
  status: z.enum(PAYROLL_RUN_STATUSES).optional(),
});

export const runPayslipsQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});

export const employeePayslipsQuerySchema = pageQuerySchema.extend({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
