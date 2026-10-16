import { adminRequest, apiBaseUrl } from './api';

/**
 * The HR payroll admin API: salary structures, monthly runs and payslips.
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

export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  draft: 'Draft',
  processed: 'Processed',
  approved: 'Approved',
};

/**
 * Tones from the shared `Tag`. Approved is the only "done" state; processed is work in
 * progress (figures exist but nobody can see them yet); a draft has no figures at all.
 */
export const PAYROLL_RUN_STATUS_TONE: Record<PayrollRunStatus, 'neutral' | 'progress' | 'good'> = {
  draft: 'neutral',
  processed: 'progress',
  approved: 'good',
};

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
  /** The first company date the run may be processed on (the day after the period). */
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
  lopDays: number;
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

  /** A draft run. The server refuses a future month or a duplicate, with `errors.period`. */
  createRun: (body: { period: string; note: string | null }) =>
    adminRequest<{ run: PayrollRun }>(`${PAYROLL}/runs`, { method: 'POST', body }).then((r) => r.run),

  /**
   * (Re)computes every payslip. `missingStructure` is how many employed people were left
   * out for having no salary structure — returned only here, never stored, so the
   * screen says it straight after processing or not at all.
   */
  processRun: (id: number) =>
    adminRequest<{ run: PayrollRun; missingStructure: number }>(`${PAYROLL}/runs/${id}/process`, {
      method: 'POST',
    }),

  /** Freezes the run and publishes its payslips. `notified` counts new notifications. */
  approveRun: (id: number) =>
    adminRequest<{ run: PayrollRun; notified: number }>(`${PAYROLL}/runs/${id}/approve`, {
      method: 'POST',
    }),

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
};

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

/** A pay period as "01 Sept – 30 Sept 2026": the year once when both ends share it. */
export function formatPeriodRange(start: string, end: string): string {
  const from = formatCalendarDate(start);
  const to = formatCalendarDate(end);
  if (start.slice(0, 4) === end.slice(0, 4)) {
    const fromWithoutYear = from.replace(/\s\d{4}$/, '');
    if (fromWithoutYear !== from) return `${fromWithoutYear} – ${to}`;
  }
  return `${from} – ${to}`;
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
