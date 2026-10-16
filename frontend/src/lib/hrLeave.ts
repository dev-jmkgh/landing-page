import { adminRequest } from './api';
import type { HrPaginated } from './hr';

/**
 * The HR leave admin API: leave requests, balances and allocations, leave types and the
 * holiday calendar (`/api/admin/hr/leave-*`, `/holidays`).
 *
 * Its own module rather than more of `hr.ts`, the same way `telecalling.ts` is kept apart
 * from `api.ts`: leave is a vocabulary of its own (kinds, half days, decisions), and
 * every call still goes through `adminRequest`, so the base URL, the cookie session and
 * the CSRF header on writes stay in exactly one place.
 *
 * Shapes are mirrored by hand from `backend/src/modules/hr/leave/leave.schema.ts`. When
 * one changes there, change it here and let the compiler find the label maps that no
 * longer cover it.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const LEAVE_KINDS = ['leave', 'wfh', 'field'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_KIND_LABELS: Record<LeaveKind, string> = {
  leave: 'Leave',
  wfh: 'Work from home',
  field: 'Field work',
};

export const HALF_DAYS = ['none', 'first_half', 'second_half'] as const;
export type HalfDay = (typeof HALF_DAYS)[number];

export const HALF_DAY_LABELS: Record<HalfDay, string> = {
  none: 'Full day',
  first_half: 'First half',
  second_half: 'Second half',
};

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const LEAVE_STATUS_TONE: Record<LeaveStatus, 'progress' | 'good' | 'bad' | 'neutral'> = {
  pending: 'progress',
  approved: 'good',
  rejected: 'bad',
  cancelled: 'neutral',
};

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type LeaveType = {
  id: number;
  name: string;
  code: string;
  kind: LeaveKind;
  isPaid: boolean;
  /** Days a year. Null means UNTRACKED: there is no balance, and none is shown. */
  annualQuota: number | null;
  allowHalfDay: boolean;
  isActive: boolean;
  sortOrder: number;
};

/**
 * One employee's standing for one leave type in one year.
 *
 * `entitled` and `available` are null — never 0 — for an untracked type. "No balance"
 * and "used it all" are different statements, and the screen must not turn the first
 * into the second. `available` may be negative when an override was lowered below what
 * had already been approved.
 */
export type LeaveBalance = {
  leaveType: LeaveType;
  year: number;
  tracked: boolean;
  entitled: number | null;
  used: number;
  pending: number;
  available: number | null;
  /** The per-person override behind `entitled`, if one is set (admin view only). */
  allocation: { days: number; note: string | null; updatedAt: string | null } | null;
};

export type LeaveRequest = {
  id: number;
  userId: number;
  employeeName: string;
  employeeCode: string;
  leaveType: { id: number; name: string; code: string; kind: LeaveKind; isPaid: boolean };
  startDate: string;
  endDate: string;
  halfDay: HalfDay;
  /** Working days the request costs, fixed when it was raised. */
  days: number;
  reason: string;
  status: LeaveStatus;
  /** Who decided: the admin portal, or a team manager in the HR app. */
  reviewerType: 'admin' | 'manager' | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
  canCancel: boolean;
};

export type Holiday = { id: number; date: string; name: string; isOptional: boolean };

/**
 * The handful of directory fields the pickers need, out of the full row
 * `GET /admin/hr/employees` returns. Typed narrowly on purpose: the directory belongs to
 * the people screens, and these pickers should not break when that row grows.
 */
export type HrEmployeeOption = {
  id: number;
  name: string;
  employeeCode: string;
  email: string;
  isActive: boolean;
  departmentName: string | null;
  designationName: string | null;
};

export type LeaveTypeInput = {
  name: string;
  code: string;
  kind: LeaveKind;
  isPaid: boolean;
  annualQuota: number | null;
  allowHalfDay: boolean;
  sortOrder: number;
};

/* -------------------------------------------------------------------------- */
/* Query strings                                                               */
/* -------------------------------------------------------------------------- */

type QueryValue = string | number | boolean | undefined | null;

/**
 * A query string from a filter object. Blank and `'all'` values are left out, so the
 * server's own default applies rather than a value the screen happened to hold.
 */
export function hrQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * A decision note for the body, or nothing.
 *
 * Omitted rather than sent as null: the server's schema takes an optional string, and
 * `null` is a validation error there, not "no note".
 */
function noteBody(note: string | null | undefined): { note?: string } {
  const trimmed = (note ?? '').trim();
  return trimmed ? { note: trimmed } : {};
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/hr';

export type LeaveRequestQuery = {
  status?: LeaveStatus | 'all';
  userId?: number;
  leaveTypeId?: number;
  /** Requests overlapping `[from, to]`. */
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export const leaveAdminApi = {
  /* ---- requests ---- */

  /** The queue: pending first (oldest first), then everything decided. */
  listRequests: (query: LeaveRequestQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<LeaveRequest>>(`${BASE}/leave-requests${hrQuery(query)}`, { signal }),

  /** Just the pending count, for the tab badge. */
  pendingCount: (signal?: AbortSignal) =>
    adminRequest<{ pending: number }>(`${BASE}/leave-requests/count`, { signal }).then(
      (r) => r.pending,
    ),

  getRequest: (id: number, signal?: AbortSignal) =>
    adminRequest<{ request: LeaveRequest }>(`${BASE}/leave-requests/${id}`, { signal }).then(
      (r) => r.request,
    ),

  approve: (id: number, note?: string | null) =>
    adminRequest<{ request: LeaveRequest }>(`${BASE}/leave-requests/${id}/approve`, {
      method: 'POST',
      body: noteBody(note),
    }).then((r) => r.request),

  reject: (id: number, note?: string | null) =>
    adminRequest<{ request: LeaveRequest }>(`${BASE}/leave-requests/${id}/reject`, {
      method: 'POST',
      body: noteBody(note),
    }).then((r) => r.request),

  /* ---- balances ---- */

  /** Every active leave-kind type for one employee and year, each with its override. */
  allocations: (userId: number, year: number, signal?: AbortSignal) =>
    adminRequest<{ userId: number; year: number; items: LeaveBalance[] }>(
      `${BASE}/leave-allocations${hrQuery({ userId, year })}`,
      { signal },
    ),

  /** Sets one person's entitlement. `days: null` removes the override (quota applies). */
  setAllocation: (body: {
    userId: number;
    leaveTypeId: number;
    year: number;
    days: number | null;
    note?: string | null;
  }) =>
    adminRequest<{ balance: LeaveBalance }>(`${BASE}/leave-allocations`, {
      method: 'PUT',
      body,
    }).then((r) => r.balance),

  /* ---- leave types ---- */

  /** Every type, inactive ones included — a bounded configuration list. */
  listTypes: (signal?: AbortSignal) =>
    adminRequest<{ items: LeaveType[] }>(`${BASE}/leave-types`, { signal }).then((r) => r.items),

  createType: (body: LeaveTypeInput) =>
    adminRequest<{ leaveType: LeaveType }>(`${BASE}/leave-types`, { method: 'POST', body }).then(
      (r) => r.leaveType,
    ),

  /** Only the fields that changed. `annualQuota: null` makes the type untracked. */
  updateType: (id: number, body: Partial<LeaveTypeInput & { isActive: boolean }>) =>
    adminRequest<{ leaveType: LeaveType }>(`${BASE}/leave-types/${id}`, {
      method: 'PATCH',
      body,
    }).then((r) => r.leaveType),

  /* ---- holidays ---- */

  /** One calendar year of holidays — bounded, so unpaginated. */
  holidays: (year: number, signal?: AbortSignal) =>
    adminRequest<{ year: number; items: Holiday[] }>(`${BASE}/holidays${hrQuery({ year })}`, {
      signal,
    }),

  createHoliday: (body: { date: string; name: string; isOptional: boolean }) =>
    adminRequest<{ holiday: Holiday }>(`${BASE}/holidays`, { method: 'POST', body }).then(
      (r) => r.holiday,
    ),

  updateHoliday: (id: number, body: Partial<{ date: string; name: string; isOptional: boolean }>) =>
    adminRequest<{ holiday: Holiday }>(`${BASE}/holidays/${id}`, { method: 'PATCH', body }).then(
      (r) => r.holiday,
    ),

  deleteHoliday: (id: number) =>
    adminRequest<{ success: true }>(`${BASE}/holidays/${id}`, { method: 'DELETE' }),

  /* ---- employee search, for the pickers ---- */

  /**
   * Approved accounts matching `q`, one page. Approved only: a registration still waiting
   * for a decision has no leave, no documents and no record to attach either to.
   */
  searchEmployees: (
    query: { q: string; page?: number; pageSize?: number },
    signal?: AbortSignal,
  ) =>
    adminRequest<HrPaginated<HrEmployeeOption>>(
      `${BASE}/employees${hrQuery({ ...query, approval: 'approved' })}`,
      { signal },
    ),
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** A day count as people say it: "1 day", "0.5 day", "2.5 days". */
export function formatDays(days: number): string {
  const value = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${value} ${Math.abs(days) <= 1 ? 'day' : 'days'}`;
}

/** A bare day count for a table cell: "12", "11.5". */
export function formatDayCount(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/**
 * The parts of a `YYYY-MM-DD` calendar date, formatted from noon UTC on that date in UTC.
 *
 * Never through the browser's own zone: "2026-10-02" is the 2nd of October wherever the
 * administrator's laptop is set, and a calendar date has no time of day to shift.
 */
function calendarDate(value: string, options: Intl.DateTimeFormatOptions): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.toLocaleDateString('en-IN', { timeZone: 'UTC', ...options });
}

/** "02 Oct 2026". */
export function formatCalendarDate(value: string): string {
  return calendarDate(value, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "Fri, 02 Oct 2026" — for the holiday list, where the weekday is the point. */
export function formatCalendarDay(value: string): string {
  return calendarDate(value, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

/** "30 Oct 2026", or "22 Oct – 24 Oct 2026" for a span. */
export function formatLeaveRange(startDate: string, endDate: string): string {
  if (startDate === endDate) return formatCalendarDate(startDate);
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  const start = sameYear
    ? calendarDate(startDate, { day: '2-digit', month: 'short' })
    : formatCalendarDate(startDate);
  return `${start} – ${formatCalendarDate(endDate)}`;
}

/** Whole and half days only — what the server accepts for a quota or an allocation. */
export function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value * 2);
}
