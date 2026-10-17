import { adminRequest, apiBaseUrl } from './api';

/**
 * The HR payroll admin API: salary structures, pay periods and payslips.
 *
 * A PAY PERIOD is what the API calls a payroll "run" (`/payroll/runs`). The screens say
 * "pay period" throughout; the code keeps the API's word so it can be traced to it.
 *
 * Its own module rather than a section of `hr.ts`, for the same reason `hr.ts` is not a
 * section of `telecalling.ts`: payroll is the one HR surface that is ADMINISTRATOR-ONLY
 * for reads as well as writes (salary is sensitive), and keeping its records apart makes
 * it obvious which screens can ever see a salary figure.
 *
 * Everything still goes through `adminRequest`, so the session cookie, the in-memory
 * CSRF token and `ApiError` normalisation are the transport's, not this file's.
 *
 * MONEY IS THE SERVER'S. Every amount below is a number with at most two decimals that
 * the server computed in whole paise. The screens format these figures; they never add,
 * prorate or round them. The single exception is the live total on the "new structure"
 * form, which is a sum of what the administrator is typing (`parseAmountToPaise`), and
 * even that is summed in integer paise so it agrees with the server to the paisa.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** Mirrored by hand from `backend/src/modules/hr/payroll/payroll.schema.ts`. */
export const PAYROLL_RUN_STATUSES = ['draft', 'processed', 'approved'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/**
 * The API's three statuses in words, for the list's status FILTER only — the server can
 * filter by these and nothing finer. What a period shows as its status is its `RunStage`
 * (below), which splits "processed" by whether the figures are final yet.
 */
export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  draft: 'Not calculated yet',
  processed: 'Calculated, not approved',
  approved: 'Approved · published',
};

/**
 * Where a pay period is, in the words an administrator who is not an accountant reads.
 * Display only: the API statuses are unchanged, and the server still decides every
 * action.
 *
 *   not_calculated  draft — no figures at all
 *   so_far          calculated while the period was running: figures up to a day,
 *                   the days after it not counted yet; cannot be approved as it is
 *   ready           calculated after the period ended, with payslips: can be approved
 *   nobody          calculated after the period ended, but nobody was included
 *   approved        frozen, and the payslips are published in the HR app
 *
 * `so_far` is also what a calculation made before the period ended reads as AFTER it has
 * ended — the figures still stop short, and the server refuses to approve them until a
 * recalculation covers every day (`calculatedThrough >= periodEnd`).
 */
export type RunStage = 'not_calculated' | 'so_far' | 'ready' | 'nobody' | 'approved';

export function runStage(run: PayrollRun): RunStage {
  if (run.status === 'approved') return 'approved';
  if (run.status === 'draft') return 'not_calculated';
  // `calculatedThrough` null on a processed period is the server's "recalculate first".
  if (run.provisional || run.calculatedThrough === null || run.calculatedThrough < run.periodEnd) {
    return 'so_far';
  }
  return run.employeeCount > 0 ? 'ready' : 'nobody';
}

export const RUN_STAGE_LABELS: Record<RunStage, string> = {
  not_calculated: 'Not calculated yet',
  so_far: 'Calculated so far',
  ready: 'Ready to approve',
  nobody: 'Nobody included',
  approved: 'Approved · published',
};

/**
 * Tones from the shared `Tag`: grey before anything is worked out, blue while figures
 * are still moving, amber when the next step is the administrator's (approve, or set up
 * salaries), green once published.
 */
export const RUN_STAGE_TONE: Record<RunStage, 'neutral' | 'progress' | 'good' | 'warn'> = {
  not_calculated: 'neutral',
  so_far: 'progress',
  ready: 'warn',
  nobody: 'warn',
  approved: 'good',
};

/** "Calculated so far · to 16 Oct", or the stage's plain label. */
export function runStageLabel(run: PayrollRun): string {
  const stage = runStage(run);
  if (stage === 'so_far' && run.calculatedThrough) {
    return `${RUN_STAGE_LABELS.so_far} · to ${dayMonth(run.calculatedThrough)}`;
  }
  return RUN_STAGE_LABELS[stage];
}

/**
 * Whether the server would approve this period now — the same four conditions
 * `approveRun` checks, so the button is only enabled when the click can succeed.
 * `today` is the company (IST) date.
 */
export function canApprove(run: PayrollRun, today: string): boolean {
  return (
    run.status === 'processed' &&
    !run.provisional &&
    run.calculatedThrough !== null &&
    run.calculatedThrough >= run.periodEnd &&
    run.employeeCount > 0 &&
    today >= run.approvableFrom
  );
}

/* -------------------------------------------------------------------------- */
/* The pay cycle                                                               */
/* -------------------------------------------------------------------------- */

/** The HR setting `payrollCycleStartDay`: 1 to 28 (28 so that every month has the day). */
export const CYCLE_START_DAYS: readonly number[] = Array.from({ length: 28 }, (_, index) => index + 1);

/** 1 → "1st", 22 → "22nd", 26 → "26th". */
export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/** "the calendar month" / "the 26th to the 25th" — the cycle inside a sentence. */
export function cycleSpan(startDay: number): string {
  if (startDay <= 1) return 'the calendar month';
  return `the ${ordinal(startDay)} to the ${ordinal(startDay - 1)}`;
}

/** "Pay periods follow the calendar month" / "Pay periods run from the 26th to the 25th". */
export function describeCycle(startDay: number): string {
  if (startDay <= 1) return 'Pay periods follow the calendar month';
  return `Pay periods run from ${cycleSpan(startDay)}`;
}

/** "October 2026 would be 26 Sep – 25 Oct 2026" — the live example beside the setting. */
export function cycleExample(startDay: number, today: string): string {
  const period = periodContaining(today, startDay);
  const { start, end } = payPeriodBounds(period, startDay);
  return `${monthLabel(period)} would be ${formatPeriodRange(start, end)}`;
}

function isoDate(year: number, month: number, day: number): string {
  // Date.UTC rolls month 0 and month 13 over into the neighbouring year, and day 0 back
  // to the last day of the previous month — which is what both branches below lean on.
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * The first and last day of the pay period named `period` (`YYYY-MM`) under a cycle that
 * starts on `startDay`. MIRRORS `payPeriodBounds` in the server's payroll.schema.ts —
 * used only to preview dates; the server works out the real ones when a period is
 * created, and stores them on it.
 *
 * A period is named after the month it ENDS in: start day 1 is the calendar month; 26
 * makes "2026-10" run 26 September to 25 October.
 */
export function payPeriodBounds(period: string, startDay: number): { start: string; end: string } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  if (startDay <= 1) return { start: isoDate(year, month, 1), end: isoDate(year, month + 1, 0) };
  return { start: isoDate(year, month - 1, startDay), end: isoDate(year, month, startDay - 1) };
}

/**
 * The `YYYY-MM` of the pay period that contains `date` (`YYYY-MM-DD`): the period an
 * administrator is in today. On or after the start day, today belongs to the period that
 * ends next month — 27 October under a 26th cycle is in "November".
 */
export function periodContaining(date: string, startDay: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (startDay > 1 && day >= startDay) {
    return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

export const COMPONENT_KINDS = ['earning', 'deduction'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
};

/** The server's limits, checked here too so a typo is caught next to its field. */
export const STRUCTURE_LIMITS = {
  components: 30,
  labelLength: 80,
  noteLength: 255,
  /** Rupees, per component. */
  maxAmount: 10_000_000,
} as const;

export const RUN_NOTE_LENGTH = 500;

/* -------------------------------------------------------------------------- */
/* Records — exactly what the API returns                                      */
/* -------------------------------------------------------------------------- */

export type PayrollPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type SalaryComponent = {
  id: number;
  label: string;
  kind: ComponentKind;
  /** The full monthly amount, before any loss of pay. */
  amount: number;
  /** Earnings only: reduced for loss-of-pay days. Always false on a deduction. */
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
  /** A payslip was computed from it, so the server refuses to delete it. */
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
  /**
   * The first company date the period may be CALCULATED on: the day it starts. It may be
   * calculated again at any time until it is approved.
   */
  processableFrom: string;
  /**
   * The first date it may be APPROVED on: the day after it ends. Approval also needs a
   * calculation made on or after that day.
   */
  approvableFrom: string;
  /** The last day the current figures cover, or null before the first calculation. */
  calculatedThrough: string | null;
  /**
   * True when the figures stop short of the period end — calculated while it was still
   * running. Days after `calculatedThrough` are neither paid nor loss of pay yet.
   */
  provisional: boolean;
  /** Employed people the last calculation left out, and why. Empty before it ran. */
  exclusions: PayrollExclusion[];
};

/**
 * Somebody employed during the period who has no payslip in it.
 *
 *   no_structure            no salary structure at all
 *   structure_starts_later  their structure starts after the period ends
 */
export type PayrollExclusion = {
  userId: number;
  employeeCode: string;
  employeeName: string;
  reason: 'no_structure' | 'structure_starts_later';
  /** For `structure_starts_later`: the `YYYY-MM-DD` it starts. */
  structureFrom: string | null;
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
  structureId: number | null;
  userId: number;
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
  /**
   * Days of the period still to come when it was calculated — only ever above zero on a
   * calculation made while the period was running. Neither paid nor loss of pay, so the
   * paid days and amounts beside it are "so far".
   */
  remainingDays: number;
  lopDays: number;
  /** Loss of pay waived because an administrator pays this employee in full this period. */
  lopWaivedDays: number;
  /** Why, while the employee is paid in full this period. */
  fullPayReason: string | null;
  paidDays: number;
  grossEarnings: number;
  lopAmount: number;
  totalDeductions: number;
  netPay: number;
  lines: PayslipLine[];
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
  /** In force today, or null. */
  currentStructure: SalaryStructure | null;
  /** The next future-dated structure, if one is already entered. */
  upcomingStructure: SalaryStructure | null;
};

/** A department, as the payroll employee filter needs it. */
export type PayrollDepartment = {
  id: number;
  name: string;
  isActive: boolean;
};

export type NewStructureInput = {
  userId: number;
  effectiveFrom: string;
  note: string | null;
  components: { label: string; kind: ComponentKind; amount: number; prorated: boolean }[];
};

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/hr';
const PAYROLL = `${BASE}/payroll`;

type QueryValue = string | number | boolean | undefined | null;

/** Blank values are left out, so the server applies its own "any" default. */
function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

export const payrollApi = {
  /* ---------------------------------------------------------------- runs */

  listRuns: (
    query: { status?: PayrollRunStatus | 'all'; page: number; pageSize: number },
    signal?: AbortSignal,
  ) => adminRequest<PayrollPage<PayrollRun>>(`${PAYROLL}/runs${qs(query)}`, { signal }),

  getRun: (id: number, signal?: AbortSignal) =>
    adminRequest<{ run: PayrollRun }>(`${PAYROLL}/runs/${id}`, { signal }).then((r) => r.run),

  /**
   * Opens a pay period (a draft), with dates from the pay cycle as it is now. The server
   * refuses a period that has not started yet, or a duplicate, with `errors.period`.
   */
  createRun: (body: { period: string; note: string | null }) =>
    adminRequest<{ run: PayrollRun }>(`${PAYROLL}/runs`, { method: 'POST', body }).then((r) => r.run),

  /**
   * (Re)calculates every payslip — any time after the period starts, until it is
   * approved. `missingStructure` counts the people left out; who they are, and why, is
   * `run.exclusions`, which is stored with the run.
   */
  processRun: (id: number) =>
    adminRequest<{ run: PayrollRun; missingStructure: number }>(`${PAYROLL}/runs/${id}/process`, {
      method: 'POST',
    }),

  /**
   * Freezes the period and publishes its payslips. Only after the period has ended AND
   * been recalculated since (`canApprove`). `notified` counts new notifications.
   */
  approveRun: (id: number) =>
    adminRequest<{ run: PayrollRun; notified: number }>(`${PAYROLL}/runs/${id}/approve`, {
      method: 'POST',
    }),

  /**
   * Pays one employee in full for the period — their loss of pay is waived — for the reason
   * given. Admin only, audited; the period is recalculated and comes back.
   */
  setFullPay: (runId: number, userId: number, reason: string) =>
    adminRequest<{ run: PayrollRun }>(`${PAYROLL}/runs/${runId}/full-pay/${userId}`, {
      method: 'PUT',
      body: { reason },
    }),

  /** Withdraws it: the employee's loss of pay applies again. Recalculates too. */
  clearFullPay: (runId: number, userId: number) =>
    adminRequest<{ run: PayrollRun }>(`${PAYROLL}/runs/${runId}/full-pay/${userId}`, { method: 'DELETE' }),

  /** Draft or processed only; the payslips go with it. */
  deleteRun: (id: number) =>
    adminRequest<{ success: true }>(`${PAYROLL}/runs/${id}`, { method: 'DELETE' }),

  listPayslips: (
    runId: number,
    query: { q?: string; page: number; pageSize: number },
    signal?: AbortSignal,
  ) =>
    adminRequest<PayrollPage<Payslip>>(`${PAYROLL}/runs/${runId}/payslips${qs(query)}`, { signal }),

  /**
   * The run as a CSV, built by the server — one row per payslip, bounded by the run.
   *
   * A URL rather than a request, like the lead import's rows CSV: the response is a file
   * for the browser to save, and the admin session cookie travels with a same-site GET.
   */
  runCsvUrl: (id: number) => `${apiBaseUrl()}${PAYROLL}/runs/${id}/export.csv`,

  /** One payslip's PDF, served inline so it opens in a tab. Any run status. */
  payslipPdfUrl: (id: number) => `${apiBaseUrl()}${PAYROLL}/payslips/${id}/pdf`,

  /* ---------------------------------------------------------- structures */

  listEmployees: (
    query: {
      q?: string;
      departmentId?: number | null;
      setUp?: 'true' | 'false' | 'all';
      page: number;
      pageSize: number;
    },
    signal?: AbortSignal,
  ) => adminRequest<PayrollPage<PayrollEmployee>>(`${PAYROLL}/employees${qs(query)}`, { signal }),

  /** One employee's structure history, newest first. */
  listStructures: (
    query: { userId: number; page: number; pageSize: number },
    signal?: AbortSignal,
  ) => adminRequest<PayrollPage<SalaryStructure>>(`${PAYROLL}/structures${qs(query)}`, { signal }),

  createStructure: (body: NewStructureInput) =>
    adminRequest<{ structure: SalaryStructure }>(`${PAYROLL}/structures`, {
      method: 'POST',
      body,
    }).then((r) => r.structure),

  /** Refused (400) once a payslip was computed from it. */
  deleteStructure: (id: number) =>
    adminRequest<{ success: true }>(`${PAYROLL}/structures/${id}`, { method: 'DELETE' }),

  /**
   * Departments for the employee filter.
   *
   * Read here rather than borrowed from `hr.ts` so this module does not depend on a file
   * another screen owns. A bounded list (the organisation's departments), not a page.
   */
  listDepartments: (signal?: AbortSignal) =>
    adminRequest<{ items: PayrollDepartment[] }>(`${BASE}/departments`, { signal }).then(
      (r) => r.items,
    ),

  /* ----------------------------------------------------------- pay cycle */

  /**
   * The pay cycle's start day, from the HR settings. Read and written here, not through
   * `hr.ts`, for the same reason as the departments above; Organisation → HR settings
   * edits the same value through `peopleApi`.
   */
  cycleStartDay: (signal?: AbortSignal) =>
    adminRequest<{ settings: { payrollCycleStartDay?: number } }>(`${BASE}/settings`, { signal }).then(
      (r) => validCycleDay(r.settings.payrollCycleStartDay),
    ),

  /** Administrator only. Periods already opened keep their dates. Field error: `payrollCycleStartDay`. */
  setCycleStartDay: (payrollCycleStartDay: number) =>
    adminRequest<{ settings: { payrollCycleStartDay?: number } }>(`${BASE}/settings`, {
      method: 'PATCH',
      body: { payrollCycleStartDay },
    }).then((r) => validCycleDay(r.settings.payrollCycleStartDay)),
};

/**
 * The start day as the server's `validCycleDay` reads it: 1 to 28, else 1. Also covers an
 * API from before the setting existed, which sends none — that is the calendar month.
 */
function validCycleDay(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 28 ? value : 1;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rupees, with Indian digit grouping: 267406.67 → "₹2,67,406.67".
 *
 * Lakh/crore grouping because that is how everyone in an Indian company reads a salary;
 * "₹267,406.67" looks like a typo to them. Always two decimals, so a column of amounts
 * lines up on the paisa. The PDF writes "INR" because its font has no ₹; a browser has.
 */
const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatInr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return INR.format(amount);
}

/** Integer paise as rupees — for the structure form's live totals only. */
export function formatPaise(paise: number): string {
  return formatInr(paise / 100);
}

/** A day count: whole days as "29", half days as "27.5". The server sends at most one decimal. */
export function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const MONTH_NAMES: readonly string[] = MONTHS;

/** `2026-09` → "September 2026". */
export function monthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const name = MONTHS[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : period;
}

function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  // Noon UTC, formatted in UTC: the calendar date itself, with no zone left to move it.
  // A bare `new Date('2026-10-01')` is midnight UTC, which is the previous evening in
  // any zone west of Greenwich.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

/** A `YYYY-MM-DD` calendar date as "01 Oct 2026" — the admin tables' date style. */
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = calendarDate(value);
  if (!date) return value;
  return date.toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Three-letter months for the short dates in sentences and ranges. Fixed rather than
 * `toLocaleDateString`, whose en-IN style writes "Sept" for September but "Oct" for
 * October.
 */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-10-16` → "16 Oct". */
export function dayMonth(value: string): string {
  const date = calendarDate(value);
  if (!date) return value;
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()] ?? ''}`;
}

/** `2026-10-16` → "16 Oct 2026" — for sentences ("calculated up to 16 Oct 2026"). */
export function shortCalendarDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = calendarDate(value);
  if (!date) return value;
  return `${dayMonth(value)} ${date.getUTCFullYear()}`;
}

/** A pay period as "26 Sep – 25 Oct 2026": the year once when both ends share it. */
export function formatPeriodRange(start: string, end: string): string {
  if (start.slice(0, 4) === end.slice(0, 4)) return `${dayMonth(start)} – ${shortCalendarDate(end)}`;
  return `${shortCalendarDate(start)} – ${shortCalendarDate(end)}`;
}

/** A `YYYY-MM-DD` calendar date as "1 November 2026" — for sentences, like the server's. */
export function longCalendarDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = calendarDate(value);
  if (!date) return value;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/* -------------------------------------------------------------------------- */
/* The structure form's amounts                                                */
/* -------------------------------------------------------------------------- */

export type ParsedAmount = { ok: true; paise: number } | { ok: false; error: string };

/**
 * What the administrator typed in an amount field, as integer paise.
 *
 * Parsed from the digits rather than with `Number(x) * 100`, so "1234567.29" cannot come
 * out as 123456728.99999999 and drift the live total by a paisa. Commas, spaces and a
 * leading ₹ are accepted and ignored, because people paste "30,000" from a spreadsheet.
 * The messages match the server's.
 */
export function parseAmountToPaise(text: string): ParsedAmount {
  const cleaned = text.replace(/[\s,₹]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter an amount.' };

  if (/^-/.test(cleaned)) return { ok: false, error: 'An amount cannot be negative.' };
  if (/^\d*\.\d{3,}$/.test(cleaned)) return { ok: false, error: 'Use at most two decimal places.' };

  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned) ?? /^()\.(\d{1,2})$/.exec(cleaned);
  if (!match) return { ok: false, error: 'Enter an amount, like 25000 or 1250.50.' };

  const rupees = Number(match[1] || '0');
  const paise = rupees * 100 + Number(((match[2] ?? '') + '00').slice(0, 2));

  if (paise > STRUCTURE_LIMITS.maxAmount * 100) {
    return { ok: false, error: 'Keep each amount to ₹1,00,00,000 or less.' };
  }

  return { ok: true, paise };
}
