import { adminRequest, apiBaseUrl } from './api';
import type {
  CalendarDayStatus,
  HrEmploymentStatus,
  HrEmploymentType,
  HrPaginated,
  LeaveKind,
  WorkMode,
} from './hr';

/**
 * The HR dashboard, reports and audit trail — admin portal reads under `/api/admin/hr`.
 *
 * A module of its own beside `hr.ts` rather than more of it: these are the only HR calls
 * that come back as aggregates or files rather than records, and the three screens that
 * use them (Dashboard, Reports, Audit log) share nothing else with the record screens.
 *
 * Everything here is a GET, so nothing needs the CSRF header. Two things are worth
 * knowing before changing it:
 *
 *   - The shapes mirror `backend/src/modules/hr/reports/` exactly as built (the route
 *     file and `reports.service.ts` / `dashboard.service.ts`). Nothing is invented on this
 *     side: a figure the server sends as null stays null, and the screens say so.
 *   - A CSV export is NOT fetched. It is a URL for a plain link that carries the admin
 *     session cookie, like the telecalling import template — the server streams the whole
 *     bounded result as a file, and gathering every page into the browser to write it
 *     here would defeat the paging the tables are built on.
 */

const BASE = '/admin/hr';

type QueryValue = string | number | boolean | undefined | null;

/** A query string from the values that are set. Blank means "no filter" and is left out. */
function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The server's range limits (`REPORT_LIMITS` in reports.service.ts), repeated here only
 * so a range the server will refuse can be named before the request — the server still
 * decides, and its 400 message is what the screen shows.
 */
export const HR_REPORT_LIMITS = {
  /** The attendance summary, on screen and as CSV. */
  attendanceDays: 93,
  /** The day-by-day table on screen. */
  dailyJsonDays: 31,
  /** The day-by-day CSV. */
  dailyCsvDays: 93,
} as const;

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export type HrDashboardTrendPoint = {
  date: string;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
};

/** `GET /admin/hr/dashboard?date` — one bounded aggregate for HR's landing page. */
export type HrAdminDashboard = {
  /** The company date the figures are for. */
  date: string;
  isToday: boolean;
  headcount: {
    /** Active, approved accounts. */
    total: number;
    /** `departmentId`/`name` null is the group with no department recorded. */
    byDepartment: Array<{ departmentId: number | null; name: string | null; count: number }>;
  };
  today: {
    present: number;
    late: number;
    halfDay: number;
    /** Past days only: today, somebody not in yet is `notYetIn`, not absent. */
    absent: number;
    onLeave: number;
    /** A working day with nothing recorded yet — non-zero only for today. */
    notYetIn: number;
    wfh: number;
    field: number;
    holiday: boolean;
    holidayName: string | null;
    /** People whose weekly off falls on the date. */
    weeklyOff: number;
    /** Live, as of now: null unless the date is today. */
    currentlyIn: number | null;
    notCheckedOut: number | null;
    /** Days flagged as a missing punch in the seven days ending `date`. */
    missingPunches: number;
    /** Flagged punches nobody has reviewed yet, up to `date`. */
    flaggedUnreviewed: number;
  };
  pending: { registrations: number; regularisations: number; leave: number; requests: number };
  /** The fourteen days ending `date`, oldest first. */
  trend: HrDashboardTrendPoint[];
  /** Null unless the signed-in administrator has the admin role — salary is sensitive. */
  payroll: { lastApproved: { period: string; totalNet: number; employeeCount: number } | null } | null;
};

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

export type HrReportKind = 'attendance' | 'daily' | 'leave' | 'employees' | 'payroll';

const REPORT_PATHS: Record<HrReportKind, string> = {
  attendance: `${BASE}/reports/attendance`,
  daily: `${BASE}/reports/attendance/daily`,
  leave: `${BASE}/reports/leave`,
  employees: `${BASE}/reports/employees`,
  payroll: `${BASE}/reports/payroll`,
};

/** Which employees an attendance report covers, and over which inclusive range. */
export type AttendanceReportQuery = {
  from?: string;
  to?: string;
  departmentId?: number;
  userId?: number;
  /** The employee's ASSIGNED site. */
  locationId?: number;
  page?: number;
  pageSize?: number;
};

export type AttendanceReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  designationName: string | null;
  workMode: WorkMode;
  locationName: string | null;
  /** Calendar days in the range; every status count adds up to this. */
  days: number;
  /** present + late + halfDay. */
  attended: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holidays: number;
  weeklyOffs: number;
  upcoming: number;
  untracked: number;
  notEmployed: number;
  wfhDays: number;
  fieldDays: number;
  totalWorkedMinutes: number;
  /** Null when no day in the range produced hours — never an invented zero. */
  averageWorkedMinutes: number | null;
  totalLateMinutes: number;
  missingPunches: number;
  flagged: number;
};

export type DailyReportRow = {
  date: string;
  /** `mon` … `sun`. */
  weekday: string;
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  status: CalendarDayStatus;
  /** First check-in, ISO UTC. */
  firstIn: string | null;
  /** Last check-out, ISO UTC; null while a session is open or nothing was recorded. */
  lastOut: string | null;
  workedMinutes: number | null;
  /** Null when there is no attendance for the day. */
  lateMinutes: number | null;
  late: boolean;
  workMode: WorkMode | null;
  site: string | null;
  leaveType: string | null;
  holiday: string | null;
  missingPunch: boolean;
  flagged: boolean;
};

export type LeaveReportQuery = {
  year?: number;
  departmentId?: number;
  userId?: number;
  page?: number;
  pageSize?: number;
};

export type LeaveReportCell = {
  leaveTypeId: number;
  code: string;
  name: string;
  kind: LeaveKind;
  isPaid: boolean;
  tracked: boolean;
  /** Null when untracked — there is no entitlement, so there is no balance. */
  entitled: number | null;
  used: number;
  pending: number;
  /** Null when untracked. May be negative when HR approved past the entitlement. */
  available: number | null;
};

export type LeaveReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  designationName: string | null;
  types: LeaveReportCell[];
  /** Approved days of the arrangements that have no balance by design. */
  untrackedUsage: { wfh: number; field: number; unpaid: number };
};

export type EmployeesReportQuery = {
  departmentId?: number;
  designationId?: number;
  locationId?: number;
  userId?: number;
  employmentStatus?: HrEmploymentStatus;
  /** As the API takes it: the string, not a boolean. */
  active?: 'true' | 'false';
  q?: string;
  page?: number;
  pageSize?: number;
};

export type EmployeeReportRow = {
  userId: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  departmentName: string | null;
  designationName: string | null;
  managerName: string | null;
  joiningDate: string | null;
  exitDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  workMode: WorkMode;
  locationName: string | null;
  shiftName: string | null;
  isActive: boolean;
};

export type PayrollRunStatus = 'draft' | 'processed' | 'approved';

/** A payroll run as the payroll module records it — the fields the year report reads. */
export type PayrollRunSummary = {
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
};

export type PayrollYearReport = {
  year: number;
  /** The year's runs, oldest first. At most twelve, so the report is not paged. */
  items: PayrollRunSummary[];
  /** Summed over APPROVED runs only; `payslips` counts payslips issued, not people. */
  approvedTotals: { runs: number; payslips: number; gross: number; deductions: number; net: number };
};

export type DatedPage<T> = HrPaginated<T> & { from: string; to: string };

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export type HrAuditQuery = {
  action?: string;
  entityType?: string;
  q?: string;
  /** Inclusive company-calendar days. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export type HrAuditRecord = {
  id: number;
  /** `admin`/`supervisor`/… for the portal; `employee` for HR-app actors (label starts "HR app:"). */
  actorType: string;
  actorId: number | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  meta: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
};

/** How the server labels an action taken in the HR app (`HR_APP_ACTOR_PREFIX` in hrAudit.ts). */
export const HR_APP_ACTOR_PREFIX = 'HR app:';

/**
 * The HR entity types the backend writes, for the audit filter.
 *
 * A fixed list, because the filter is an exact match and nobody should have to know the
 * code spelling. Kept by hand from the `entityType: 'hr_…'` values in the HR modules; a
 * type added on the server and missing here is still listed (every row shows its type)
 * and still found by the search box — it only lacks a filter entry.
 */
export const HR_AUDIT_ENTITY_LABELS: Record<string, string> = {
  hr_user: 'Employee account',
  hr_attendance: 'Attendance day',
  hr_regularisation: 'Attendance correction',
  hr_leave_request: 'Leave request',
  hr_leave_type: 'Leave type',
  hr_leave_allocation: 'Leave allocation',
  hr_holiday: 'Holiday',
  hr_request: 'HR request',
  hr_document: 'Document',
  hr_announcement: 'Announcement',
  hr_payroll_run: 'Payroll run',
  hr_payslip: 'Payslip',
  hr_salary_structure: 'Salary structure',
  hr_department: 'Department',
  hr_designation: 'Designation',
  hr_work_location: 'Work location',
  hr_shift: 'Shift',
  hr_settings: 'HR settings',
  hr_report: 'Report export',
};

/** The actions the backend records, grouped for the filter's option groups. */
export const HR_AUDIT_ACTION_GROUPS: Array<{ label: string; actions: Array<[string, string]> }> = [
  {
    label: 'Employees',
    actions: [
      ['hr_registration_approved', 'Registration approved'],
      ['hr_registration_rejected', 'Registration rejected'],
      ['hr_employee_created', 'Employee created'],
      ['hr_employee_updated', 'Employee updated'],
      ['hr_user_activated', 'Access switched on'],
      ['hr_user_deactivated', 'Access switched off'],
      ['hr_assignment_updated', 'Work assignment changed'],
      ['hr_profile_update_applied', 'Profile update applied'],
    ],
  },
  {
    label: 'Attendance',
    actions: [
      ['hr_attendance_corrected', 'Day corrected by an administrator'],
      ['hr_attendance_exception_reviewed', 'Flagged punch reviewed'],
      ['hr_regularisation_approved', 'Correction approved'],
      ['hr_regularisation_rejected', 'Correction rejected'],
    ],
  },
  {
    label: 'Leave and holidays',
    actions: [
      ['hr_leave_approved', 'Leave approved'],
      ['hr_leave_rejected', 'Leave rejected'],
      ['hr_leave_type_created', 'Leave type created'],
      ['hr_leave_type_updated', 'Leave type updated'],
      ['hr_leave_allocation_set', 'Allocation set'],
      ['hr_leave_allocation_removed', 'Allocation removed'],
      ['hr_holiday_created', 'Holiday added'],
      ['hr_holiday_updated', 'Holiday updated'],
      ['hr_holiday_deleted', 'Holiday removed'],
    ],
  },
  {
    label: 'Requests, documents and announcements',
    actions: [
      ['hr_request_in_progress', 'Request picked up'],
      ['hr_request_resolved', 'Request resolved'],
      ['hr_request_rejected', 'Request rejected'],
      ['hr_request_commented', 'Request comment'],
      ['hr_document_shared', 'Document shared'],
      ['hr_document_downloaded', 'Document downloaded'],
      ['hr_document_removed', 'Document removed'],
      ['hr_announcement_sent', 'Announcement sent'],
    ],
  },
  {
    label: 'Payroll',
    actions: [
      ['hr_salary_structure_created', 'Salary structure created'],
      ['hr_salary_structure_deleted', 'Salary structure deleted'],
      ['hr_payroll_run_created', 'Payroll run created'],
      ['hr_payroll_run_processed', 'Payroll run processed'],
      ['hr_payroll_run_approved', 'Payroll run approved'],
      ['hr_payroll_run_deleted', 'Payroll run deleted'],
    ],
  },
  {
    label: 'Organisation and settings',
    actions: [
      ['hr_department_created', 'Department created'],
      ['hr_department_updated', 'Department updated'],
      ['hr_designation_created', 'Designation created'],
      ['hr_designation_updated', 'Designation updated'],
      ['hr_location_created', 'Work location created'],
      ['hr_location_updated', 'Work location updated'],
      ['hr_shift_created', 'Shift created'],
      ['hr_shift_updated', 'Shift updated'],
      ['hr_settings_updated', 'Settings changed'],
      ['hr_report_exported', 'Report exported'],
    ],
  },
];

const ACTION_LABELS = new Map(HR_AUDIT_ACTION_GROUPS.flatMap((group) => group.actions));

/** "Leave approved" for `hr_leave_approved`; an action this list does not know is de-snaked. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS.get(action) ?? humaniseCode(action.replace(/^hr_/, ''));
}

export function auditEntityLabel(entityType: string): string {
  return HR_AUDIT_ENTITY_LABELS[entityType] ?? humaniseCode(entityType.replace(/^hr_/, ''));
}

function humaniseCode(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

export const hrReportsApi = {
  /** Empty `date` means "whatever the server calls today". */
  dashboard: (date: string | undefined, signal?: AbortSignal) =>
    adminRequest<HrAdminDashboard>(`${BASE}/dashboard${qs({ date })}`, { signal }),

  attendance: (query: AttendanceReportQuery, signal?: AbortSignal) =>
    adminRequest<DatedPage<AttendanceReportRow>>(`${REPORT_PATHS.attendance}${qs(query)}`, { signal }),

  daily: (query: AttendanceReportQuery, signal?: AbortSignal) =>
    adminRequest<DatedPage<DailyReportRow>>(`${REPORT_PATHS.daily}${qs(query)}`, { signal }),

  leave: (query: LeaveReportQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<LeaveReportRow> & { year: number }>(`${REPORT_PATHS.leave}${qs(query)}`, {
      signal,
    }),

  employees: (query: EmployeesReportQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<EmployeeReportRow>>(`${REPORT_PATHS.employees}${qs(query)}`, { signal }),

  /** ADMIN ONLY — a supervisor gets 403. Bounded at twelve runs, so not paged. */
  payroll: (year: number | undefined, signal?: AbortSignal) =>
    adminRequest<PayrollYearReport>(`${REPORT_PATHS.payroll}${qs({ year })}`, { signal }),

  /**
   * The same report as a CSV file, for a plain link.
   *
   * Same filters as the table, without the page: the server streams every row the
   * filters select (bounded by the validated range), so the file is never "page 3 of 7".
   * Each export is recorded in the HR audit trail by the server.
   */
  csvUrl: (kind: HrReportKind, query: Record<string, QueryValue>) =>
    `${apiBaseUrl()}${REPORT_PATHS[kind]}${qs({ ...query, page: undefined, pageSize: undefined, format: 'csv' })}`,

  /** ADMIN ONLY — the `hr_*` slice of the audit trail, newest first. */
  audit: (query: HrAuditQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<HrAuditRecord>>(`${BASE}/audit${qs(query)}`, { signal }),
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹2,67,406.67 — Indian digit grouping, always two decimals, as the payslip prints it. */
export function formatRupees(amount: number): string {
  return Number.isFinite(amount) ? RUPEES.format(amount) : '—';
}
