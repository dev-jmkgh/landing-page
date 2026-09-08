/**
 * Telecalling types and admin API surface.
 *
 * A separate module from `api.ts` rather than an addition to it. `api.ts` owns the
 * transport — base URL, CSRF, credential mode, error normalisation — and the telecalling
 * system adds roughly as much surface again as the whole website API. Folding them
 * together would produce one file nobody wants to open.
 *
 * The transport is still shared: everything here goes through `adminRequest`, so there
 * is exactly one place that knows how to talk to the API.
 */

import { adminRequest, apiBaseUrl } from './api';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mirrored by hand from `backend/src/modules/telecalling/shared.schema.ts`.
 *
 * Kept in step by the compiler: when a status is added on the server, add it here and
 * every switch and label map that needs updating stops compiling.
 */
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'interested',
  'not_interested',
  'follow_up',
  'callback_requested',
  'converted',
  'lost',
  'invalid_number',
  'not_reachable',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  not_interested: 'Not interested',
  follow_up: 'Follow-up required',
  callback_requested: 'Callback requested',
  converted: 'Converted',
  lost: 'Lost',
  invalid_number: 'Invalid number',
  not_reachable: 'Not reachable',
};

/** Grouped so the UI can colour a status without a ten-branch conditional. */
export const LEAD_STATUS_TONE: Record<LeadStatus, 'neutral' | 'progress' | 'good' | 'bad'> = {
  new: 'neutral',
  contacted: 'progress',
  interested: 'good',
  not_interested: 'neutral',
  follow_up: 'progress',
  callback_requested: 'progress',
  converted: 'good',
  lost: 'bad',
  invalid_number: 'bad',
  not_reachable: 'neutral',
};

export const CALL_OUTCOMES = [
  'answered',
  'missed',
  'rejected',
  'busy',
  'unreachable',
  'no_answer',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  answered: 'Answered',
  missed: 'Missed',
  rejected: 'Rejected',
  busy: 'Busy',
  unreachable: 'Unreachable',
  no_answer: 'No answer',
};

export const EMPLOYEE_ROLES = ['admin', 'manager', 'supervisor', 'telecaller'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const EMPLOYEE_ROLE_LABELS: Record<EmployeeRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  supervisor: 'Supervisor',
  telecaller: 'Telecaller',
};

export type FollowUpScope = 'today' | 'upcoming' | 'overdue' | 'pending' | 'completed' | 'all';

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type Employee = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: EmployeeRole;
  availability: 'available' | 'busy' | 'on_break' | 'offline';
  isActive: boolean;
  /**
   * Where this account sits in the self-registration flow.
   *
   * Branch on this rather than on `isActive`. A pending applicant and a deactivated
   * ex-employee are BOTH inactive, so `isActive` alone cannot tell "never approved"
   * from "approved, then switched off" — and those need opposite actions.
   */
  approvalStatus: ApprovalStatus;
  /** When the applicant signed up in the mobile app. Null for accounts an admin created. */
  registeredAt: string | null;
  /**
   * When the registration was decided — NOT necessarily approved.
   *
   * The server sets this column on rejection as well, so read it as a decision
   * timestamp and label it accordingly. It is null while the registration is pending,
   * and is cleared again if a rejection is reopened.
   */
  approvedAt: string | null;
  /** Shown to the applicant on their next sign-in attempt. */
  rejectionReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Lead = {
  id: number;
  reference: string;
  customerName: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  source: string;
  productInterest: string | null;
  status: LeadStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  assignedAt: string | null;
  createdBy: number | null;
  enquiryId: number | null;
  hasAttachment: boolean;
  summaryNote: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  convertedAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Call = {
  id: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  userId: number;
  userName: string | null;
  phone: string;
  direction: 'outgoing' | 'incoming';
  outcome: CallOutcome;
  channel: 'device' | 'cloud';
  /** Whether the figures were measured, confirmed by the telecaller, or provider-supplied. */
  source: 'call_log' | 'manual' | 'provider';
  durationSeconds: number;
  startedAt: string;
  endedAt: string | null;
  followedUp: boolean;
  hasRecording: boolean;
  recordingId: number | null;
  recordingDuration: number | null;
  createdAt: string;
};

export type FollowUp = {
  id: number;
  leadId: number;
  leadReference: string;
  leadName: string;
  leadPhone: string;
  leadStatus: LeadStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  dueAt: string;
  note: string | null;
  state: 'pending' | 'completed' | 'cancelled';
  isOverdue: boolean;
  completedAt: string | null;
  completedByName: string | null;
  outcomeNote: string | null;
  rescheduledFrom: string | null;
  rescheduleCount: number;
  createdAt: string;
};

export type LeadNote = {
  id: number;
  leadId: number;
  userId: number | null;
  userName: string | null;
  kind: string;
  body: string;
  callId: number | null;
  createdAt: string;
};

export type ActivityEntry = {
  id: number;
  leadId: number;
  userId: number | null;
  userName: string | null;
  type: string;
  summary: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type Recording = {
  id: number;
  callId: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  userId: number | null;
  userName: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  provider: string | null;
  callStartedAt: string | null;
  createdAt: string;
};

export type AuditEntry = {
  id: number;
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

export type LeadSourceRecord = {
  id: number;
  slug: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
};

export type SettingRecord = {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
};

export type EmployeePerformance = {
  userId: number;
  employeeCode: string;
  name: string;
  role: string;
  isActive: boolean;
  calls: number;
  answered: number;
  missed: number;
  talkTimeSeconds: number;
  averageDurationSeconds: number;
  followUpsCompleted: number;
  followUpsPending: number;
  leadsAssigned: number;
  leadsContacted: number;
  leadsConverted: number;
  conversionRate: number;
};

export type AdminDashboard = {
  leads: {
    total: number;
    new: number;
    assigned: number;
    unassigned: number;
    converted: number;
    lost: number;
  };
  calls: { total: number; answered: number; missed: number; talkTimeSeconds: number };
  followUps: { today: number; overdue: number; completed: number };
  employees: { total: number; active: number };
  conversionRate: number;
  /** Per-employee performance, returned with the dashboard so one request fills the screen. */
  employeeRows: EmployeePerformance[];
  overdueByEmployee: { userId: number; name: string; overdue: number; oldestDueAt: string }[];
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type DateRange = { from?: string; to?: string };

/* -------------------------------------------------------------------------- */
/* Query helpers                                                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/telecalling';

export type LeadQuery = {
  page?: number;
  pageSize?: number;
  status?: LeadStatus | 'all';
  source?: string;
  assignedTo?: number | 'unassigned' | 'all';
  q?: string;
  sort?: 'recent' | 'oldest' | 'name' | 'follow_up' | 'last_contacted' | 'never_contacted';
  archived?: boolean;
  from?: string;
  to?: string;
};

export type CallQuery = {
  page?: number;
  pageSize?: number;
  userId?: number | 'all';
  leadId?: number;
  direction?: 'outgoing' | 'incoming' | 'all';
  outcome?: CallOutcome | 'all';
  withRecording?: boolean;
  pendingCallback?: boolean;
  q?: string;
  from?: string;
  to?: string;
};

export const telecallingApi = {
  /* ------------------------------------------------------------- dashboard */

  dashboard: (range: DateRange, signal?: AbortSignal) =>
    adminRequest<
      Omit<AdminDashboard, 'employeeRows'> & { employees: EmployeePerformance[] }
    >(`${BASE}/dashboard${qs({ ...range })}`, { signal }).then(
      (body): AdminDashboard => ({
        // The endpoint returns per-employee rows under `employees`, which collides with
        // the headcount tile of the same name. Renamed once here rather than in every
        // component that reads it.
        ...body,
        employeeRows: body.employees,
      }),
    ),

  /* ------------------------------------------------------------- employees */

  listEmployees: (
    query: {
      page?: number;
      pageSize?: number;
      role?: EmployeeRole | 'all';
      active?: boolean;
      /**
       * Approval state, which the endpoint has always accepted but this binding never
       * passed on. It is what lets the management screen isolate the signup queue
       * instead of leaving applicants mixed in with ex-employees.
       */
      approval?: ApprovalStatus;
      q?: string;
    },
    signal?: AbortSignal,
  ) =>
    adminRequest<Paginated<Employee>>(
      `${BASE}/employees${qs({ ...query, active: query.active === undefined ? undefined : String(query.active) })}`,
      { signal },
    ),

  assignableEmployees: (signal?: AbortSignal) =>
    adminRequest<{ items: Employee[] }>(`${BASE}/employees/assignable`, { signal }).then(
      (body) => body.items,
    ),

  employeeDetail: (id: number, range: DateRange, signal?: AbortSignal) =>
    adminRequest<{
      employee: Employee;
      summary: {
        calls: number;
        answered: number;
        missed: number;
        talkTimeSeconds: number;
        averageDurationSeconds: number;
        followUpsCompleted: number;
        followUpsPending: number;
        leadsContacted: number;
        leadsConverted: number;
      };
      openLeads: number;
      activity: ActivityEntry[];
    }>(`${BASE}/employees/${id}${qs({ ...range })}`, { signal }),

  createEmployee: (body: {
    name: string;
    email: string;
    phone?: string | null;
    password: string;
    role: EmployeeRole;
    employeeCode?: string;
  }) =>
    adminRequest<{ employee: Employee }>(`${BASE}/employees`, {
      method: 'POST',
      body,
    }).then((r) => r.employee),

  updateEmployee: (
    id: number,
    body: Partial<{
      name: string;
      email: string;
      phone: string | null;
      role: EmployeeRole;
      employeeCode: string;
      isActive: boolean;
    }>,
  ) =>
    adminRequest<{ employee: Employee }>(`${BASE}/employees/${id}`, {
      method: 'PATCH',
      body,
    }).then((r) => r.employee),

  resetEmployeePassword: (id: number, password: string) =>
    adminRequest<{ success: true }>(`${BASE}/employees/${id}/password`, {
      method: 'POST',
      body: { password },
    }),

  handoverFollowUps: (fromId: number, toEmployeeId: number) =>
    adminRequest<{ moved: number }>(`${BASE}/employees/${fromId}/handover-follow-ups`, {
      method: 'POST',
      body: { toEmployeeId },
    }),

  /* ------------------------------------------------- registration approval */

  /**
   * The count of registrations awaiting a decision.
   *
   * A separate, cheap endpoint so the Employees tab can carry a badge without pulling
   * the whole queue. Note the response key is `pending`, not `count` or `total`.
   */
  pendingRegistrationCount: (signal?: AbortSignal) =>
    adminRequest<{ pending: number }>(`${BASE}/registrations/count`, { signal }).then(
      (r) => r.pending,
    ),

  /**
   * The pending queue, oldest first and unpaginated.
   *
   * `listEmployees({ approval: 'pending' })` covers the same rows with paging and
   * search, which is what the management screen uses. This exists because it is the
   * only registration route a supervisor can read, and because its ordering is
   * deliberate — the person who has been waiting longest is at the top.
   */
  listRegistrations: (signal?: AbortSignal) =>
    adminRequest<{ items: Employee[]; total: number }>(`${BASE}/registrations`, { signal }),

  /**
   * Approve a registration: the account becomes active and can sign in.
   *
   * Administrator only, unlike reading the queue — a supervisor can see who is waiting
   * but not grant access. Refused with 400 if the registration was already decided, so
   * reload the list afterwards rather than patching the row optimistically.
   */
  approveRegistration: (id: number) =>
    adminRequest<{ employee: Employee }>(`${BASE}/registrations/${id}/approve`, {
      method: 'POST',
    }).then((r) => r.employee),

  /**
   * Reject a registration, optionally saying why.
   *
   * The reason is shown to the applicant the next time they try to sign in, which is
   * the only channel back to them — there is no email on rejection. Server limit is 255
   * characters after trimming; an empty string is stored as no reason at all.
   */
  rejectRegistration: (id: number, reason: string | null) =>
    adminRequest<{ employee: Employee }>(`${BASE}/registrations/${id}/reject`, {
      method: 'POST',
      body: { reason },
    }).then((r) => r.employee),

  /**
   * Put a rejected registration back in the queue.
   *
   * Only a rejected one: the server refuses with 400 for pending or approved. Approving
   * a rejected registration directly is also refused, so this is the required first
   * step when someone was turned down by mistake.
   */
  reopenRegistration: (id: number) =>
    adminRequest<{ employee: Employee }>(`${BASE}/registrations/${id}/reopen`, {
      method: 'POST',
    }).then((r) => r.employee),

  /* ----------------------------------------------------------------- leads */

  listLeads: (query: LeadQuery, signal?: AbortSignal) =>
    adminRequest<Paginated<Lead>>(
      `${BASE}/leads${qs({ ...query, archived: query.archived ? 'true' : undefined })}`,
      { signal },
    ),

  leadDetail: (id: number, signal?: AbortSignal) =>
    adminRequest<{
      lead: Lead;
      notes: LeadNote[];
      calls: Call[];
      followUps: FollowUp[];
      timeline: ActivityEntry[];
    }>(`${BASE}/leads/${id}`, { signal }),

  /**
   * Creates a lead.
   *
   * Typed rather than `Record<string, unknown>`, which is what this was: an untyped body
   * on the one call with fourteen optional fields meant a misspelled key compiled fine
   * and was silently dropped by the server's Zod schema.
   *
   * `possibleDuplicate` is advisory, not an error. Two leads can legitimately share a
   * number and the server deliberately does not reject one — it returns the existing lead
   * alongside the new one so the person who can see both decides. Show it; do not treat
   * it as a failure.
   */
  createLead: (body: {
    customerName: string;
    phone: string;
    alternatePhone?: string | null;
    email?: string | null;
    address?: string | null;
    city?: string | null;
    /** A `slug` from `listLeadSources`. An unknown value is normalised to 'other', not rejected. */
    source: string;
    productInterest?: string | null;
    status?: LeadStatus;
    summaryNote?: string | null;
    /** Supervisor and above only; a telecaller always gets their own id regardless. */
    assignedTo?: number | null;
    enquiryId?: number | null;
    attachmentKey?: string | null;
    clientUuid?: string;
  }) =>
    adminRequest<{ lead: Lead; possibleDuplicate: Lead | null; deduplicated: boolean }>(
      `${BASE}/leads`,
      { method: 'POST', body },
    ),

  updateLead: (id: number, body: Record<string, unknown>) =>
    adminRequest<{ lead: Lead }>(`${BASE}/leads/${id}`, { method: 'PATCH', body }).then(
      (r) => r.lead,
    ),

  setLeadStatus: (
    id: number,
    body: { status: LeadStatus; note?: string | null; followUpAt?: string | null },
  ) =>
    adminRequest<{ lead: Lead; followUpId: number | null }>(`${BASE}/leads/${id}/status`, {
      method: 'POST',
      body,
    }),

  addLeadNote: (id: number, body: { body: string; kind?: 'note' | 'requirement' }) =>
    adminRequest<{ note: LeadNote }>(`${BASE}/leads/${id}/notes`, { method: 'POST', body }),

  assignLead: (id: number, assignedTo: number | null, reason?: string | null) =>
    adminRequest<{ lead: Lead }>(`${BASE}/leads/${id}/assign`, {
      method: 'POST',
      body: { assignedTo, reason },
    }).then((r) => r.lead),

  bulkAssign: (leadIds: number[], assignedTo: number | null, reason?: string | null) =>
    adminRequest<{ assigned: number; skipped: number; failedIds: number[] }>(
      `${BASE}/leads/bulk-assign`,
      { method: 'POST', body: { leadIds, assignedTo, reason } },
    ),

  archiveLead: (id: number, archived: boolean) =>
    adminRequest<{ lead: Lead }>(`${BASE}/leads/${id}/archive`, {
      method: 'POST',
      body: { archived },
    }).then((r) => r.lead),

  deleteLead: (id: number) =>
    adminRequest<{ success: true }>(`${BASE}/leads/${id}`, { method: 'DELETE' }),

  /** Authenticated URL for the photo of a paper lead. */
  leadAttachmentUrl: (id: number) => `${apiBaseUrl()}${BASE}/leads/${id}/attachment`,

  /* ----------------------------------------------------------------- calls */

  listCalls: (query: CallQuery, signal?: AbortSignal) =>
    adminRequest<Paginated<Call>>(
      `${BASE}/calls${qs({
        ...query,
        withRecording: query.withRecording === undefined ? undefined : String(query.withRecording),
        pendingCallback:
          query.pendingCallback === undefined ? undefined : String(query.pendingCallback),
      })}`,
      { signal },
    ),

  listRecordings: (
    query: { page?: number; pageSize?: number; userId?: number | 'all'; q?: string; from?: string; to?: string },
    signal?: AbortSignal,
  ) => adminRequest<Paginated<Recording>>(`${BASE}/recordings${qs({ ...query })}`, { signal }),

  /**
   * Authenticated playback URL.
   *
   * Every request to it is written to the audit log server-side before the audio is
   * released — a recording is personal data and who listened is a question that gets
   * asked.
   */
  recordingAudioUrl: (id: number) => `${apiBaseUrl()}${BASE}/recordings/${id}/audio`,

  /* ------------------------------------------------------------ follow-ups */

  listFollowUps: (
    query: {
      scope: FollowUpScope;
      page?: number;
      pageSize?: number;
      assignedTo?: number | 'all';
      q?: string;
      from?: string;
      to?: string;
    },
    signal?: AbortSignal,
  ) => adminRequest<Paginated<FollowUp>>(`${BASE}/follow-ups${qs({ ...query })}`, { signal }),

  createFollowUp: (body: { leadId: number; dueAt: string; note?: string | null; assignedTo?: number }) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups`, { method: 'POST', body }),

  updateFollowUp: (id: number, body: { note?: string | null; assignedTo?: number }) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups/${id}`, { method: 'PATCH', body }),

  rescheduleFollowUp: (id: number, dueAt: string, note?: string | null) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups/${id}/reschedule`, {
      method: 'POST',
      body: { dueAt, note },
    }).then((r) => r.followUp),

  completeFollowUp: (id: number) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups/${id}/complete`, {
      method: 'POST',
    }).then((r) => r.followUp),

  cancelFollowUp: (id: number) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups/${id}/cancel`, {
      method: 'POST',
    }).then((r) => r.followUp),

  /* --------------------------------------------------------------- reports */

  callTrend: (
    query: { granularity: 'day' | 'week' | 'month'; userId?: number | 'all' } & DateRange,
    signal?: AbortSignal,
  ) =>
    adminRequest<{
      granularity: string;
      items: {
        period: string;
        calls: number;
        answered: number;
        missed: number;
        talkTimeSeconds: number;
      }[];
    }>(`${BASE}/reports/calls${qs({ ...query })}`, { signal }),

  performance: (range: DateRange, signal?: AbortSignal) =>
    adminRequest<{ items: EmployeePerformance[] }>(`${BASE}/reports/performance${qs({ ...range })}`, {
      signal,
    }).then((r) => r.items),

  leadBreakdown: (
    query: { dimension: 'status' | 'source' | 'employee' } & DateRange,
    signal?: AbortSignal,
  ) =>
    adminRequest<{
      dimension: string;
      items: { key: string; total: number; converted: number; conversionRate: number }[];
    }>(`${BASE}/reports/leads${qs({ ...query })}`, { signal }),

  followUpReport: (query: { userId?: number | 'all' } & DateRange, signal?: AbortSignal) =>
    adminRequest<{
      created: number;
      completed: number;
      pending: number;
      overdue: number;
      cancelled: number;
      completedOnTime: number;
      completedLate: number;
    }>(`${BASE}/reports/follow-ups${qs({ ...query })}`, { signal }),

  /* --------------------------------------------------- sources and settings */

  listLeadSources: (signal?: AbortSignal) =>
    adminRequest<{ items: LeadSourceRecord[] }>(`${BASE}/lead-sources`, { signal }).then(
      (r) => r.items,
    ),

  saveLeadSource: (body: { slug: string; label: string; isActive: boolean; sortOrder: number }) =>
    adminRequest<{ items: LeadSourceRecord[] }>(`${BASE}/lead-sources`, {
      method: 'PUT',
      body,
    }).then((r) => r.items),

  listSettings: (signal?: AbortSignal) =>
    adminRequest<{ items: SettingRecord[] }>(`${BASE}/settings`, { signal }).then((r) => r.items),

  saveSetting: (key: string, value: unknown) =>
    adminRequest<{ items: SettingRecord[] }>(`${BASE}/settings`, {
      method: 'PUT',
      body: { key, value },
    }).then((r) => r.items),

  /* ------------------------------------------------------------- audit log */

  listAuditLogs: (
    query: {
      page?: number;
      pageSize?: number;
      action?: string;
      entityType?: string;
      actorId?: number;
      q?: string;
      from?: string;
      to?: string;
    },
    signal?: AbortSignal,
  ) => adminRequest<Paginated<AuditEntry>>(`${BASE}/audit-logs${qs({ ...query })}`, { signal }),

  /* ------------------------------------------------------------- broadcast */

  broadcast: (body: { title: string; body?: string; employeeIds?: number[] }) =>
    adminRequest<{ recipients: number }>(`${BASE}/broadcast`, { method: 'POST', body }),
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** Talk time, as a manager reads it. */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Dates are rendered in IST regardless of where the browser is.
 *
 * The whole operation works one timezone, and a manager checking last night's calls from
 * a laptop still set to another one should see the same figures the telecaller saw.
 */
const IST = 'Asia/Kolkata';

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Today in IST as YYYY-MM-DD, for seeding a date-range filter. */
export function todayIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

export function daysAgoIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
