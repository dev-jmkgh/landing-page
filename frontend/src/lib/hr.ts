import { adminRequest } from './api';

/**
 * The HR admin API.
 *
 * Deliberately a separate module from `telecalling.ts`, mirroring the backend split. HR
 * accounts live in their own table with their own roles (backend migration 017), and the
 * two products' vocabularies must stay free to diverge — importing `EmployeeRole` from
 * the telecalling module would mean adding a telecalling role silently changed what this
 * screen believes an HR employee can be.
 *
 * The transport is still shared: everything here goes through `adminRequest`, so there is
 * exactly one place that knows how to talk to the API and carry the session cookie (and
 * the CSRF header on every write).
 *
 * Note the direction of access. The HR *app* cannot reach telecalling and vice versa, but
 * an ADMINISTRATOR manages both — so this calls `/api/admin/hr/*` with the same admin
 * session the telecalling screens use. That was never what the separation forbade.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mirrored by hand from `backend/src/modules/hr/hr.schema.ts`.
 *
 * Kept in step by the compiler: when a role is added on the server, add it here and every
 * label map that needs updating stops compiling.
 */
export const HR_ROLES = ['employee', 'hr_manager', 'hr_admin'] as const;
export type HrRole = (typeof HR_ROLES)[number];

/**
 * Explicit labels rather than a generic de-snake-casing helper, which would render
 * `hr_admin` as "Hr admin" — a lowercase acronym nobody says out loud.
 */
export const HR_ROLE_LABELS: Record<HrRole, string> = {
  employee: 'Employee',
  hr_manager: 'HR manager',
  hr_admin: 'HR administrator',
};

export const HR_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type HrApprovalStatus = (typeof HR_APPROVAL_STATUSES)[number];

export const HR_APPROVAL_LABELS: Record<HrApprovalStatus, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Employment facts HR records (migration 027). Mirrors `HR_EMPLOYMENT_TYPES`. */
export const HR_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export type HrEmploymentType = (typeof HR_EMPLOYMENT_TYPES)[number];

export const HR_EMPLOYMENT_TYPE_LABELS: Record<HrEmploymentType, string> = {
  full_time: 'Full time',
  part_time: 'Part time',
  contract: 'Contract',
  intern: 'Intern',
};

/**
 * Where somebody is in their employment — NOT whether they can sign in.
 *
 * The two are independent and both say "active" on the server, which is why the screens
 * call the account flag "app access" and keep "Active" for this one.
 */
export const HR_EMPLOYMENT_STATUSES = ['probation', 'active', 'notice_period', 'exited'] as const;
export type HrEmploymentStatus = (typeof HR_EMPLOYMENT_STATUSES)[number];

export const HR_EMPLOYMENT_STATUS_LABELS: Record<HrEmploymentStatus, string> = {
  probation: 'Probation',
  active: 'Active',
  notice_period: 'Notice period',
  exited: 'Exited',
};

/**
 * One HR account with its employee record and attendance assignment — exactly what
 * `GET /api/admin/hr/employees` (the directory), `GET /employees/:id` and
 * `GET /registrations` return per row (`HrRegistrationRow` on the server).
 *
 * Every record field may be null: an account created before HR recorded these facts has
 * none of them, and the screens say "Not recorded" rather than substituting something
 * adjacent (the account's creation date is not a joining date).
 */
export type HrEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: HrRole;
  isActive: boolean;
  approvalStatus: HrApprovalStatus;
  rejectionReason: string | null;
  /** Null until the applicant entered the code emailed to them. */
  emailVerifiedAt: string | null;
  registeredAt: string | null;
  approvedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;

  /* ---- the employee record ---- */
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationName: string | null;
  managerId: number | null;
  managerName: string | null;
  /** `YYYY-MM-DD`. The employment fact HR entered — not when the account was created. */
  joiningDate: string | null;
  exitDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;

  /* ---- what they are assigned to work ---- */
  workMode: 'office' | 'remote' | 'field';
  workLocationId: number | null;
  workLocationName: string | null;
  shiftId: number | null;
  shiftName: string | null;
};

export type HrPaginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

/** Pages in a result, never fewer than one so a pager can always say "page 1 of 1". */
export function pageCount(result: { total: number; pageSize: number }): number {
  return Math.max(1, Math.ceil(result.total / Math.max(1, result.pageSize)));
}

/* ---- organisation ---- */

export type Department = {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  /** Active, approved employees in it — the same headcount the dashboard reports. */
  employeeCount: number;
};

export type Designation = {
  id: number;
  name: string;
  isActive: boolean;
  employeeCount: number;
};

/* ---- weekdays and settings ---- */

/** Sunday first, the order the server returns them in. Mirrors `WEEKDAYS` in hrSettings. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

export const WEEKDAY_LONG: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

/** "Sun", "Sat, Sun" or "None" — in week order whatever order they were picked in. */
export function describeWeekdays(days: readonly Weekday[] | undefined): string {
  const ordered = WEEKDAYS.filter((day) => days?.includes(day));
  return ordered.length === 0 ? 'None' : ordered.map((day) => WEEKDAY_SHORT[day]).join(', ');
}

export type HrSettings = {
  /**
   * `YYYY-MM-DD`, or null. Days before it are not judged present or absent — with no
   * punch on record they are "untracked", and payroll does not deduct for them.
   */
  attendanceTrackedFrom: string | null;
  /** Weekly-off days for an employee with no shift. */
  defaultWeeklyOff: Weekday[];
  /**
   * The day of the month a pay period starts on, 1 to 28. 1 is the calendar month; 26
   * is "26th to 25th", with the period named after the month it ends in. Changing it
   * affects pay periods opened afterwards; existing ones keep their dates.
   */
  payrollCycleStartDay: number;
};

/* -------------------------------------------------------------------------- */
/* Registrations API (the approval queue)                                      */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/hr';

type QueryValue = string | number | boolean | undefined | null;

function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

export const hrApi = {
  /** The registrations queue — pending first, then rejected, then approved. */
  listEmployees: (
    query: {
      page?: number;
      pageSize?: number;
      approval?: HrApprovalStatus | 'all';
      q?: string;
    },
    signal?: AbortSignal,
  ) => adminRequest<HrPaginated<HrEmployee>>(`${BASE}/registrations${qs(query)}`, { signal }),

  /**
   * Just the count, for the sidebar badge.
   *
   * Separate from the list so the number stays right while an administrator is looking at
   * the Employees tab — deriving it from a list total would only be correct on the one tab
   * where a badge is redundant.
   */
  pendingCount: (signal?: AbortSignal) =>
    adminRequest<{ pending: number }>(`${BASE}/registrations/count`, { signal }).then(
      (r) => r.pending,
    ),

  approve: (id: number) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/registrations/${id}/approve`, {
      method: 'POST',
    }).then((r) => r.employee),

  /**
   * Reject, optionally saying why.
   *
   * The reason travels to the applicant verbatim on the app's waiting screen, and it is
   * the only message they ever get — which is why the panel asks for one rather than
   * rejecting silently.
   */
  reject: (id: number, reason: string | null) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/registrations/${id}/reject`, {
      method: 'POST',
      body: { reason },
    }).then((r) => r.employee),

  /**
   * Switch an approved account off, or back on.
   *
   * Deactivating revokes every device server-side, so it takes effect within one
   * access-token lifetime rather than whenever the handset next signs out.
   */
  setActive: (id: number, active: boolean) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/users/${id}/active`, {
      method: 'POST',
      body: { active },
    }).then((r) => r.employee),
};

/* -------------------------------------------------------------------------- */
/* Attendance vocabulary                                                       */
/* -------------------------------------------------------------------------- */

export const WORK_MODES = ['office', 'remote', 'field'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  office: 'Office',
  remote: 'Remote',
  field: 'Field',
};

/** What the attendance roll-up recorded for a day that has a row. */
export type AttendanceStatus = 'present' | 'late' | 'half_day' | 'absent' | 'on_leave';

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  on_leave: 'On leave',
};

/**
 * What a day WAS, as the server's one classifier (`calendar.service`) decides it. Leave,
 * holidays and weekly offs take precedence over "no punch", so `absent` never names
 * somebody who was not expected in.
 */
export type CalendarDayStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'absent'
  | 'on_leave'
  | 'holiday'
  | 'weekly_off'
  | 'upcoming'
  | 'untracked'
  | 'not_employed';

export const DAY_STATUS_LABELS: Record<CalendarDayStatus, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  on_leave: 'On leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  upcoming: 'Not yet',
  untracked: 'Not tracked',
  not_employed: 'Not employed',
};

export type StatusTone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad';

export const DAY_STATUS_TONE: Record<CalendarDayStatus, StatusTone> = {
  present: 'good',
  late: 'warn',
  half_day: 'warn',
  absent: 'bad',
  on_leave: 'progress',
  holiday: 'neutral',
  weekly_off: 'neutral',
  upcoming: 'neutral',
  untracked: 'neutral',
  not_employed: 'neutral',
};

/** Why a punch was flagged for review — the session `in_flags` / `out_flags` SET. */
export const PUNCH_FLAGS = ['mock_location', 'clock_skew', 'low_accuracy'] as const;
export type PunchFlag = (typeof PUNCH_FLAGS)[number];

export const PUNCH_FLAG_LABELS: Record<PunchFlag, string> = {
  mock_location: 'Mock location',
  clock_skew: 'Clock skew',
  low_accuracy: 'Low accuracy',
};

/** What each flag means, for a tooltip beside the tag. */
export const PUNCH_FLAG_HINTS: Record<PunchFlag, string> = {
  mock_location: 'The phone reported that its location came from a mock location app.',
  clock_skew: 'The phone’s clock was well away from the server’s at the time of the punch.',
  low_accuracy: 'The phone’s location fix was too imprecise to trust.',
};

export type AttendanceSource = 'app' | 'regularisation' | 'admin';

export const ATTENDANCE_SOURCE_LABELS: Record<AttendanceSource, string> = {
  app: 'App',
  regularisation: 'Corrected by request',
  admin: 'Corrected by admin',
};

export type WorkLocation = {
  id: number;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMetres: number;
  isActive: boolean;
};

export type Shift = {
  id: number;
  name: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  graceMinutes: number;
  halfDayMinutes: number;
  isActive: boolean;
  /** Rest days, Sunday first. An empty list is a real answer — a seven-day rota. */
  weeklyOffDays: Weekday[];
};

/** The register's status filter: the day's calendar status, plus two session states. */
export const REGISTER_STATUS_FILTERS = [
  'present',
  'late',
  'half_day',
  'absent',
  'on_leave',
  'holiday',
  'weekly_off',
  'currently_in',
  'not_checked_out',
] as const;
export type RegisterStatusFilter = (typeof REGISTER_STATUS_FILTERS)[number];

export const REGISTER_STATUS_FILTER_LABELS: Record<RegisterStatusFilter, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  on_leave: 'On leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  currently_in: 'In right now',
  not_checked_out: 'Did not check out',
};

/** One line of the day register. Everyone approved and active appears, present or not. */
export type RegisterEntry = {
  userId: number;
  name: string;
  employeeCode: string;
  workMode: WorkMode;
  departmentName: string | null;
  designationName: string | null;
  workDate: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  workedMinutes: number | null;
  breakMinutes: number | null;
  lateMinutes: number | null;
  /** The roll-up's own status; `absent` when there is no row at all. */
  status: AttendanceStatus;
  /** The classifier's answer, which knows about leave, holidays and weekly offs. */
  dayStatus: CalendarDayStatus | null;
  source: AttendanceSource | null;
  /** A session was closed by the system because nobody checked out. */
  missingPunch: boolean;
  /** A punch was flagged for review (mock location, clock skew, low accuracy). */
  flagged: boolean;
  /** Approved leave (or work from home / field work) covering the date. */
  leaveTypeName: string | null;
  locationName: string | null;
  /** How far from the site the check-in was, as the server measured it. */
  distanceMetres: number | null;
  /** How many check-in/check-out pairs have closed that day. */
  completedSessions: number;
  /** True while they are mid-session, i.e. in the building right now. */
  currentlyIn: boolean;
};

export type RegisterPage = HrPaginated<RegisterEntry> & { date: string };

/** One check-in / check-out pair. */
export type AttendanceSession = {
  id: number;
  startedAt: string;
  /** Null while this session is the one currently running. */
  endedAt: string | null;
  minutes: number | null;
  source: AttendanceSource;
  /** Closed by the system because nobody checked out before the day ended. */
  autoClosed: boolean;
  flags: PunchFlag[];
};

/** A day as the app's history shows it, sessions included. */
export type AttendanceDay = {
  id: number | null;
  workDate: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  workedMinutes: number | null;
  breakMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  status: AttendanceStatus;
  workMode: WorkMode;
  shiftStartsAt: string | null;
  shiftEndsAt: string | null;
  source: AttendanceSource;
  /** For an admin correction, the reason given. */
  note: string | null;
  completedSessions: number;
  openSessionStartedAt: string | null;
  missingPunch: boolean;
  flagged: boolean;
  sessions: AttendanceSession[];
};

export type LeaveKind = 'leave' | 'wfh' | 'field';
export type HalfDay = 'none' | 'first_half' | 'second_half';

export type CalendarLeave = {
  requestId: number;
  leaveTypeId: number;
  typeName: string;
  typeCode: string;
  kind: LeaveKind;
  isPaid: boolean;
  halfDay: HalfDay;
  status: 'approved' | 'pending';
};

export type CalendarDay = {
  date: string;
  weekday: Weekday;
  isToday: boolean;
  employed: boolean;
  weeklyOff: boolean;
  /** Includes optional holidays, which are NOT days off — see `isOptional`. */
  holiday: { id: number; name: string; isOptional: boolean } | null;
  leave: CalendarLeave | null;
  pendingLeave: CalendarLeave | null;
  attendance: {
    status: AttendanceStatus;
    workedMinutes: number | null;
    lateMinutes: number;
    earlyMinutes: number;
    missingPunch: boolean;
    flagged: boolean;
    checkedInAt: string | null;
    checkedOutAt: string | null;
    workMode: WorkMode;
  } | null;
  status: CalendarDayStatus;
};

/** One session of an exception day, with the evidence a reviewer needs. */
export type ExceptionSession = {
  id: number;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number | null;
  source: AttendanceSource;
  autoClosed: boolean;
  inFlags: PunchFlag[];
  outFlags: PunchFlag[];
  /** What the handset believed the time was — recorded, never trusted. */
  inDeviceAt: string | null;
  outDeviceAt: string | null;
  inLatitude: number | null;
  inLongitude: number | null;
  outLatitude: number | null;
  outLongitude: number | null;
  inDistanceMetres: number | null;
  outDistanceMetres: number | null;
  inAccuracyMetres: number | null;
  outAccuracyMetres: number | null;
};

export type AttendanceException = {
  attendanceId: number;
  userId: number;
  employeeName: string;
  employeeCode: string;
  workDate: string;
  status: AttendanceStatus;
  workMode: WorkMode;
  source: AttendanceSource;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  workedMinutes: number | null;
  missingPunch: boolean;
  flagged: boolean;
  reviewed: boolean;
  /** `reviewedBy` is an admin-portal account id; `reviewerName` is a snapshot taken at review. */
  review: {
    reviewedAt: string | null;
    reviewedBy: number | null;
    reviewerName: string | null;
    note: string | null;
  } | null;
  sessions: ExceptionSession[];
};

export type Regularisation = {
  id: number;
  userId: number;
  employeeName?: string;
  employeeCode?: string;
  workDate: string;
  requestedCheckInAt: string | null;
  requestedCheckOutAt: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Who decided — an administrator or the employee's manager. */
  reviewerName: string | null;
  createdAt: string;
};

/**
 * One leave balance as `GET /leave-allocations` returns it. Read-only on the employee
 * screen — entitlements are set in the Leave section.
 *
 * An UNTRACKED type (no allocation and no quota) has no balance at all: `entitled` and
 * `available` are null, never zero. `available` may be negative when leave was approved
 * past the entitlement.
 */
export type HrLeaveBalance = {
  leaveType: {
    id: number;
    name: string;
    code: string;
    kind: LeaveKind;
    isPaid: boolean;
    annualQuota: number | null;
    allowHalfDay: boolean;
    isActive: boolean;
    sortOrder: number;
  };
  year: number;
  tracked: boolean;
  entitled: number | null;
  used: number;
  pending: number;
  available: number | null;
  allocation: { days: number; note: string | null; updatedAt: string | null } | null;
};

/* -------------------------------------------------------------------------- */
/* People API (directory, records, organisation, settings)                     */
/* -------------------------------------------------------------------------- */

export type DirectoryQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  departmentId?: number;
  designationId?: number;
  managerId?: number;
  workMode?: WorkMode;
  employmentStatus?: HrEmploymentStatus;
  /** As the API takes it: the string, not a boolean. */
  active?: 'true' | 'false';
  approval?: HrApprovalStatus;
};

export type EmployeeCreateInput = {
  name: string;
  email: string;
  phone: string | null;
  password: string;
  role: HrRole;
  departmentId: number | null;
  designationId: number | null;
  managerId: number | null;
  joiningDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
};

/** An edit. Absent leaves a field alone; `null` clears a nullable one. */
export type EmployeePatch = Partial<{
  name: string;
  phone: string | null;
  role: HrRole;
  departmentId: number | null;
  designationId: number | null;
  managerId: number | null;
  joiningDate: string | null;
  exitDate: string | null;
  employmentType: HrEmploymentType;
  employmentStatus: HrEmploymentStatus;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}>;

export type EmployeePatchResult = {
  employee: HrEmployee;
  /** The fields that actually moved. A field sent with its current value is not listed. */
  changed: string[];
  /** Something the administrator should know, e.g. a role change applies at next refresh. */
  notice: string | null;
};

export const peopleApi = {
  /* ---- departments (a bounded list) ---- */
  listDepartments: (signal?: AbortSignal) =>
    adminRequest<{ items: Department[] }>(`${BASE}/departments`, { signal }).then((r) => r.items),

  createDepartment: (body: { name: string; code: string | null }) =>
    adminRequest<{ department: Department }>(`${BASE}/departments`, { method: 'POST', body }).then(
      (r) => r.department,
    ),

  updateDepartment: (id: number, body: { name?: string; code?: string | null; isActive?: boolean }) =>
    adminRequest<{ department: Department }>(`${BASE}/departments/${id}`, {
      method: 'PATCH',
      body,
    }).then((r) => r.department),

  /* ---- designations (a bounded list) ---- */
  listDesignations: (signal?: AbortSignal) =>
    adminRequest<{ items: Designation[] }>(`${BASE}/designations`, { signal }).then((r) => r.items),

  createDesignation: (body: { name: string }) =>
    adminRequest<{ designation: Designation }>(`${BASE}/designations`, {
      method: 'POST',
      body,
    }).then((r) => r.designation),

  updateDesignation: (id: number, body: { name?: string; isActive?: boolean }) =>
    adminRequest<{ designation: Designation }>(`${BASE}/designations/${id}`, {
      method: 'PATCH',
      body,
    }).then((r) => r.designation),

  /* ---- the directory ---- */

  /** Alphabetical, one page at a time, every approval state unless `approval` narrows it. */
  directory: (query: DirectoryQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<HrEmployee>>(`${BASE}/employees${qs(query)}`, { signal }),

  employee: (id: number, signal?: AbortSignal) =>
    adminRequest<{ employee: HrEmployee; directReports: number }>(`${BASE}/employees/${id}`, {
      signal,
    }),

  /** Creates an approved, active, verified account — the administrator vouches for it. */
  createEmployee: (body: EmployeeCreateInput) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/employees`, { method: 'POST', body }).then(
      (r) => r.employee,
    ),

  updateEmployee: (id: number, body: EmployeePatch) =>
    adminRequest<EmployeePatchResult>(`${BASE}/employees/${id}`, { method: 'PATCH', body }),

  /** One employee's recorded days, newest first. Defaults to the current company month. */
  employeeAttendance: (
    id: number,
    query: { from?: string; to?: string; page?: number; pageSize?: number },
    signal?: AbortSignal,
  ) =>
    adminRequest<HrPaginated<AttendanceDay> & { from: string; to: string }>(
      `${BASE}/employees/${id}/attendance${qs(query)}`,
      { signal },
    ),

  /** One month as the classifier sees it — bounded at 31 days, so unpaginated. */
  employeeCalendar: (id: number, month: string | undefined, signal?: AbortSignal) =>
    adminRequest<{ month: string; days: CalendarDay[] }>(
      `${BASE}/employees/${id}/calendar${qs({ month })}`,
      { signal },
    ),

  /** That employee's balances for a year — every active leave type, read-only here. */
  leaveBalances: (userId: number, year: number, signal?: AbortSignal) =>
    adminRequest<{ userId: number; year: number; items: HrLeaveBalance[] }>(
      `${BASE}/leave-allocations${qs({ userId, year })}`,
      { signal },
    ),

  /* ---- company HR settings ---- */
  settings: (signal?: AbortSignal) =>
    adminRequest<{ settings: HrSettings }>(`${BASE}/settings`, { signal }).then((r) => r.settings),

  updateSettings: (body: Partial<HrSettings>) =>
    adminRequest<{ settings: HrSettings }>(`${BASE}/settings`, { method: 'PATCH', body }).then(
      (r) => r.settings,
    ),
};

/* -------------------------------------------------------------------------- */
/* Attendance API                                                              */
/* -------------------------------------------------------------------------- */

export type RegisterQuery = {
  /** Empty means "whatever the server calls today". */
  date?: string;
  userId?: number;
  q?: string;
  departmentId?: number;
  /** The employee's ASSIGNED site, not where a punch happened to be made. */
  locationId?: number;
  status?: RegisterStatusFilter;
  page?: number;
  pageSize?: number;
};

export type ExceptionQuery = {
  type?: 'missing_punch' | 'flagged';
  reviewed?: 'true' | 'false';
  from?: string;
  to?: string;
  userId?: number;
  page?: number;
  pageSize?: number;
};

/** A corrected session as company wall-clock times on the corrected date. */
export type CorrectionSession = { startAt: string; endAt: string | null };

export type ShiftInput = Omit<Shift, 'id' | 'isActive'>;

export const attendanceAdminApi = {
  /* ---- work locations ---- */
  listLocations: (signal?: AbortSignal) =>
    adminRequest<{ items: WorkLocation[] }>(`${BASE}/locations`, { signal }).then((r) => r.items),

  createLocation: (body: {
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    radiusMetres: number;
  }) =>
    adminRequest<{ location: WorkLocation }>(`${BASE}/locations`, {
      method: 'POST',
      body,
    }).then((r) => r.location),

  updateLocation: (id: number, body: Partial<Omit<WorkLocation, 'id'>>) =>
    adminRequest<{ location: WorkLocation }>(`${BASE}/locations/${id}`, {
      method: 'PATCH',
      body,
    }).then((r) => r.location),

  /* ---- shifts ---- */
  listShifts: (signal?: AbortSignal) =>
    adminRequest<{ items: Shift[] }>(`${BASE}/shifts`, { signal }).then((r) => r.items),

  createShift: (body: ShiftInput) =>
    adminRequest<{ shift: Shift }>(`${BASE}/shifts`, { method: 'POST', body }).then(
      (r) => r.shift,
    ),

  updateShift: (id: number, body: Partial<ShiftInput> & { isActive?: boolean }) =>
    adminRequest<{ shift: Shift }>(`${BASE}/shifts/${id}`, { method: 'PATCH', body }).then(
      (r) => r.shift,
    ),

  /* ---- assignment ---- */
  assign: (
    userId: number,
    body: { workLocationId: number | null; shiftId: number | null; workMode: WorkMode },
  ) =>
    adminRequest<{ success: true }>(`${BASE}/users/${userId}/assignment`, {
      method: 'PATCH',
      body,
    }),

  /* ---- the register ---- */
  register: (query: RegisterQuery, signal?: AbortSignal) =>
    adminRequest<RegisterPage>(`${BASE}/attendance${qs(query)}`, { signal }),

  /**
   * Replaces one employee's day with the sessions given. ADMIN ONLY, audited, and the day
   * stays marked as corrected by an administrator with `reason` as its note.
   */
  correctDay: (userId: number, date: string, body: { sessions: CorrectionSession[]; reason: string }) =>
    adminRequest<{ day: AttendanceDay | null }>(`${BASE}/attendance/${userId}/${date}`, {
      method: 'PUT',
      body,
    }).then((r) => r.day),

  /* ---- exceptions ---- */
  exceptions: (query: ExceptionQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<AttendanceException>>(
      `${BASE}/attendance/exceptions${qs(query)}`,
      { signal },
    ),

  reviewException: (attendanceId: number, note: string | null) =>
    adminRequest<{ exception: AttendanceException | null }>(
      `${BASE}/attendance/exceptions/${attendanceId}/review`,
      { method: 'POST', body: note ? { note } : {} },
    ).then((r) => r.exception),

  /* ---- corrections requested by employees ---- */
  listRegularisations: (
    query: {
      status: 'pending' | 'approved' | 'rejected' | 'all';
      page?: number;
      pageSize?: number;
    },
    signal?: AbortSignal,
  ) => {
    /*
     * `status` is sent even when it is `all`: the server's default is `pending`, so the
     * usual `qs` rule of dropping `all` would silently turn "All" into "Waiting".
     */
    const search = new URLSearchParams({ status: query.status });
    if (query.page) search.set('page', String(query.page));
    if (query.pageSize) search.set('pageSize', String(query.pageSize));
    return adminRequest<HrPaginated<Regularisation>>(`${BASE}/regularisations?${search}`, {
      signal,
    });
  },

  regularisationCount: (signal?: AbortSignal) =>
    adminRequest<{ pending: number }>(`${BASE}/regularisations/count`, { signal }).then(
      (r) => r.pending,
    ),

  approveRegularisation: (id: number, note: string | null) =>
    adminRequest<{ request: Regularisation }>(`${BASE}/regularisations/${id}/approve`, {
      method: 'POST',
      body: { note },
    }).then((r) => r.request),

  rejectRegularisation: (id: number, note: string | null) =>
    adminRequest<{ request: Regularisation }>(`${BASE}/regularisations/${id}/reject`, {
      method: 'POST',
      body: { note },
    }).then((r) => r.request),
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** Minutes as "7h 20m". Durations always arrive from the server already reduced. */
export function minutesAsHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

const COMPANY_ZONE = 'Asia/Kolkata';

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: COMPANY_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * An instant as the company's 24-hour wall clock, `HH:MM` — the form a time input and the
 * correction endpoint both use.
 *
 * In the company zone, not the browser's: an administrator travelling abroad must still
 * see (and send back) the times the employee actually punched in India.
 */
export function companyClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  return clockFormat.format(instant);
}

/** `YYYY-MM` plus or minus whole months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) return month;
  const index = year * 12 + (mon - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

/** "October 2026" from `2026-10`. Built at noon UTC so no zone can move it a month. */
export function formatMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) return month;
  return new Date(Date.UTC(year, mon - 1, 1, 12)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

/** A day count with at most one decimal: 1, 1.5, 12. */
export function formatDays(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
