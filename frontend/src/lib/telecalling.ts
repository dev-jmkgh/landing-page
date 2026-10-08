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

import { ApiError, adminRequest, apiBaseUrl } from './api';

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
  /*
   * The customer came to the office.
   *
   * Appended, not inserted where it belongs semantically (between `interested` and
   * `converted`), because MySQL stores an ENUM as an index into its value list — moving
   * an existing value would change the meaning of every row already stored. Display
   * order is decided by the UI, which is free to put it wherever it reads best.
   */
  'walked_in',
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
  walked_in: 'Walked in',
};

/**
 * Grouped so the UI can colour a status without an eleven-branch conditional.
 *
 * `accent` is the fifth tone, and it exists for exactly one status. A walk-in is the
 * strongest signal in the vocabulary short of a sale, and colouring it `good` would make
 * it indistinguishable from `interested` and `converted` in a list where telling those
 * three apart is the whole point of looking.
 */
export const LEAD_STATUS_TONE: Record<
  LeadStatus,
  'neutral' | 'progress' | 'good' | 'bad' | 'accent'
> = {
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
  walked_in: 'accent',
};

/** For values that only might be a status — a URL parameter, a spreadsheet cell. */
export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

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

/** Outcomes where the customer was not actually spoken to. Mirrors the server's set. */
export const UNANSWERED_OUTCOMES: readonly CallOutcome[] = [
  'missed',
  'rejected',
  'busy',
  'unreachable',
  'no_answer',
];

/**
 * What the call list's outcome filter accepts: one outcome, or `unanswered` for all five
 * of UNANSWERED_OUTCOMES at once.
 *
 * The group value exists because the dashboard's "Not answered" tile counts every
 * unanswered outcome. Opening that tile onto `outcome=missed` would list a fraction of
 * what it counted, and a tile whose list disagrees with it is worse than no link at all.
 */
export const CALL_OUTCOME_FILTERS = [...CALL_OUTCOMES, 'unanswered'] as const;
export type CallOutcomeFilter = (typeof CALL_OUTCOME_FILTERS)[number];

export const CALL_OUTCOME_FILTER_LABELS: Record<CallOutcomeFilter, string> = {
  ...CALL_OUTCOME_LABELS,
  unanswered: 'Not answered (any)',
};

export const CALL_DIRECTIONS = ['outgoing', 'incoming'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/**
 * Where a call's figures came from: read from the Android call log, typed in by the
 * telecaller (the only option on iOS), or reported by a telephony provider.
 */
export const CALL_SOURCES = ['call_log', 'manual', 'provider'] as const;
export type CallSource = (typeof CALL_SOURCES)[number];

/**
 * Labels that say how far a duration can be trusted, which is what a manager comparing
 * two telecallers on different phones actually needs to know.
 */
export const CALL_SOURCE_LABELS: Record<CallSource, string> = {
  call_log: 'Measured',
  manual: 'Self-reported',
  provider: 'Provider',
};

/**
 * Which incoming calls a list shows, by how the receiving line was checked.
 *
 * `company` (the server's default) is outgoing calls plus incoming calls verified as
 * received on the employee's company SIM. `unverified` is the incoming calls recorded
 * before that check existed, kept for audit and cleanup rather than counted.
 */
export const CALL_LINES = ['company', 'unverified', 'all'] as const;
export type CallLine = (typeof CALL_LINES)[number];

export const CALL_LINE_LABELS: Record<CallLine, string> = {
  company: 'Company SIM (verified)',
  unverified: 'Not verified (older)',
  all: 'All',
};

/** How an incoming call was matched to the company SIM. Null on outgoing calls. */
export const SIM_MATCHES = ['number', 'confirmed', 'single_sim', 'provider'] as const;
export type SimMatch = (typeof SIM_MATCHES)[number];

export const SIM_MATCH_LABELS: Record<SimMatch, string> = {
  number: 'Number matched',
  confirmed: 'Confirmed SIM',
  single_sim: 'Only SIM in phone',
  provider: 'Telephony provider',
};

export const EMPLOYEE_ROLES = ['admin', 'manager', 'supervisor', 'telecaller'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const EMPLOYEE_ROLE_LABELS: Record<EmployeeRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  supervisor: 'Supervisor',
  telecaller: 'Telecaller',
};

/**
 * Slices of the follow-up list. `overdue`, `today` and `completed_today` are not stored
 * states but windows the server computes — `today` and `completed_today` on the IST
 * calendar day — so there is no flag to go stale.
 */
export const FOLLOW_UP_SCOPES = [
  'today',
  'upcoming',
  'overdue',
  'pending',
  'completed',
  'completed_today',
  'all',
] as const;
export type FollowUpScope = (typeof FOLLOW_UP_SCOPES)[number];

/** `system` notes are the server's own bookkeeping, not something a person wrote. */
export const NOTE_KINDS = ['note', 'requirement', 'call_note', 'system'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  note: 'Note',
  requirement: 'Requirement',
  call_note: 'Call note',
  system: 'System',
};

export const LEAD_SORTS = [
  'recent',
  'oldest',
  'name',
  'follow_up',
  'last_contacted',
  'never_contacted',
] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The employee's company SIM as their phone last reported it.
 *
 * Null until the app has checked: a new employee, an older app, or a company number that
 * was just changed (which clears it). `declined` means the employee said the company SIM
 * is not in this phone, so incoming calls cannot be read from it.
 */
export type CompanySim = {
  status: 'confirmed' | 'declined';
  /** How the SIM was identified. Null when declined. */
  method: 'number' | 'confirmed' | 'single_sim' | null;
  /** The SIM's display name on the handset, e.g. the carrier. */
  label: string | null;
  /** Zero-based slot; show it as `slot + 1`. */
  slot: number | null;
  device: string | null;
  at: string;
};

export type Employee = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  /** Personal phone, optional. Not the number incoming calls are matched against. */
  phone: string | null;
  /**
   * The company SIM number, canonical `+91XXXXXXXXXX`.
   *
   * Incoming calls count only when they reached this line, so a telecaller without one
   * has no incoming calls recorded at all. Required for telecallers on creation and
   * before approval; unique among current staff.
   */
  companyPhone: string | null;
  companySim: CompanySim | null;
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
  /**
   * When the person confirmed their email address. The server refuses to approve a
   * registration while this is null, so the approval queue can say so up front.
   */
  emailVerifiedAt: string | null;
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

/**
 * The newest thing written about a lead, for the lead list's "Notes / remarks" column.
 *
 * `source: 'note'` is the newest lead note that is not a system note. When the lead has
 * none, the server falls back to the lead's own summary note (`source: 'summary'`), which
 * has no author, kind or time. `body` is a preview of at most 300 characters; `truncated`
 * says whether there is more in the Lead View.
 */
export type LatestLeadNote = {
  source: 'note' | 'summary';
  noteId: number | null;
  kind: 'note' | 'requirement' | 'call_note' | null;
  body: string;
  truncated: boolean;
  userName: string | null;
  callId: number | null;
  createdAt: string | null;
};
/** The same type under the name the Lead View analysis used. */
export type LeadLatestNote = LatestLeadNote;

/** A row of the admin lead list. The mobile list has no `latestNote`. */
export type LeadListItem = Lead & { latestNote: LatestLeadNote | null };

/** A lead as the Lead View loads it: the record plus who created and assigned it. */
export type LeadDetailLead = Lead & {
  createdByName: string | null;
  assignedBy: number | null;
  assignedByName: string | null;
};

/**
 * One call, as every call endpoint returns it.
 *
 * `Call` below is the admin call list's row, which adds the latest note. A Lead View
 * history entry (`CallHistoryEntry`) adds the call's own notes instead, so the two are
 * built on this rather than on each other.
 */
export type CallRecord = {
  id: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  /** The lead's current status, carried on the call. Null when the call has no lead. */
  leadStatus: LeadStatus | null;
  userId: number;
  userName: string | null;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: 'device' | 'cloud';
  /** Whether the figures were measured, confirmed by the telecaller, or provider-supplied. */
  source: CallSource;
  durationSeconds: number;
  startedAt: string;
  endedAt: string | null;
  followedUp: boolean;
  /**
   * When a telecaller wrote the call up, or null if nobody has. Not the same question as
   * `followedUp`: a call can be called back without anyone recording what was said.
   */
  recordedAt: string | null;
  /** The company number an incoming call reached, when the handset could tell. */
  receivedOnPhone: string | null;
  /** How an incoming call was verified as reaching the company SIM. Null on outgoing calls. */
  simMatch: SimMatch | null;
  hasRecording: boolean;
  recordingId: number | null;
  recordingDuration: number | null;
  createdAt: string;
};

/** The newest note written against one call, for the call list's Notes column. */
export type CallNoteSummary = {
  id: number;
  kind: 'call_note' | 'note' | 'requirement';
  body: string;
  authorName: string | null;
  createdAt: string;
};

/**
 * A row of the admin call list.
 *
 * One call can be written up more than once, so "the call's note" is the newest one plus
 * a count of the rest. `telecallingApi.listCalls` fills in null and 0 when talking to a
 * server that predates the Notes column, so a screen can rely on both being present.
 */
export type Call = CallRecord & {
  latestNote: CallNoteSummary | null;
  noteCount: number;
};

/**
 * The call list's figures for the whole filtered set, not just the page shown.
 *
 * Computed with the same filter as `total`, which is what lets the Calls screen show the
 * same talk time and answer rate as the dashboard tile it was opened from.
 */
export type CallListSummary = {
  answered: number;
  unanswered: number;
  talkTimeSeconds: number;
};

/** `summary` is null only when the server predates it. */
export type CallList = Paginated<Call> & { summary: CallListSummary | null };

/** GET /calls as sent. A server from before the Notes column leaves these fields out. */
type CallListResponse = Paginated<
  CallRecord & { latestNote?: CallNoteSummary | null; noteCount?: number }
> & { summary?: CallListSummary };

export type FollowUp = {
  id: number;
  leadId: number;
  /** The call this follow-up was booked on, or null when it was booked any other way. */
  callId: number | null;
  leadReference: string;
  leadName: string;
  leadPhone: string;
  leadStatus: LeadStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  /**
   * Who owns the lead, which need not be who holds the follow-up.
   *
   * When they differ, the follow-up's holder will see it in the app but cannot open the
   * lead or log calls against it — worth warning about before a move creates that state.
   */
  leadAssignedTo: number | null;
  leadAssignedToName: string | null;
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
  kind: NoteKind;
  body: string;
  callId: number | null;
  createdAt: string;
};

/** A note written against one call. The same record as any other lead note. */
export type CallNote = LeadNote;

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
  /**
   * The split of `calls` by direction, and incoming calls nobody answered.
   *
   * The dashboard and the performance report compute their rows with the same query and
   * both send these; they are optional only because a server from before them does not.
   * Incoming counts cover the company SIM only, like every other call figure.
   */
  outgoing?: number;
  incoming?: number;
  incomingMissed?: number;
};

/** Approved accounts, and how many of them are active. Not bound by the date range. */
export type Headcount = { total: number; active: number };

export type AdminDashboard = {
  leads: {
    total: number;
    new: number;
    assigned: number;
    unassigned: number;
    converted: number;
    lost: number;
    /** Customers who came to the office. Added with migration 012. */
    walkedIn: number;
  };
  calls: {
    total: number;
    answered: number;
    missed: number;
    talkTimeSeconds: number;
    /** A subset of `total`, not an addition to it: calls the customer made to us. */
    incoming: number;
    incomingMissed: number;
  };
  followUps: { today: number; overdue: number; completed: number };
  /** The headcount tile. The server sends it as `headcount`; see `telecallingApi.dashboard`. */
  employees: Headcount;
  conversionRate: number;
  /** Per-employee performance, returned with the dashboard so one request fills the screen. */
  employeeRows: EmployeePerformance[];
  overdueByEmployee: { userId: number; name: string; overdue: number; oldestDueAt: string }[];
  /** Self-registrations waiting for an administrator's decision. */
  pendingRegistrations: number;
};

/**
 * GET /dashboard as the server sends it, before `telecallingApi.dashboard` renames it.
 *
 * The per-employee rows arrive as `employees` — the name the headcount tile also wants —
 * and the headcount arrives as `headcount`. An older API sent only the rows, under that
 * same name, which is how the "Active employees" tile came to render an array. The old
 * client type was AdminDashboard with one key swapped by an intersection, which made
 * `employees` both shapes at once and hid that. Spelling the wire shape out field by
 * field is what lets the compiler catch a repeat.
 */
type AdminDashboardResponse = {
  leads: AdminDashboard['leads'];
  calls: AdminDashboard['calls'];
  followUps: AdminDashboard['followUps'];
  /** Absent only from an API that predates it. */
  headcount?: Headcount;
  employees: EmployeePerformance[];
  conversionRate: number;
  overdueByEmployee: AdminDashboard['overdueByEmployee'];
  pendingRegistrations?: number;
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type DateRange = { from?: string; to?: string };

/** A page of a list, without the rows. */
export type PageInfo = { page: number; pageSize: number; total: number; totalPages: number };

/* -------------------------------------------------------------------------- */
/* Lead View                                                                   */
/* -------------------------------------------------------------------------- */

/** What the signed-in admin may do from the Lead View, decided by the server from their role. */
export type LeadViewer = {
  role: Exclude<EmployeeRole, 'telecaller'>;
  canPlayRecordings: boolean;
  canArchive: boolean;
  canDelete: boolean;
};

/** Figures over every call on the lead, not just the page of history loaded. */
export type LeadCallSummary = {
  total: number;
  answered: number;
  unanswered: number;
  incoming: number;
  outgoing: number;
  talkTimeSeconds: number;
  /** Unanswered calls nobody has called back yet. */
  pendingCallbacks: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
};

/** The status change made on a call, read back from the lead's history. */
export type CallStatusChange = {
  from: LeadStatus;
  to: LeadStatus;
  at: string;
  userName: string | null;
};

/** One call in the Lead View's history, with what was recorded against it. */
export type CallHistoryEntry = CallRecord & {
  /** Oldest first, in the order they were written. */
  notes: CallNote[];
  /** Follow-ups booked on this call. */
  followUps: FollowUp[];
  statusChange: CallStatusChange | null;
};

/**
 * Whole-lead totals. `notes` leaves out system notes; `followUps` counts every state.
 * `pendingFollowUps` is the true open count — the one that says whether the capped
 * `followUps.pending` list is all of them.
 */
export type LeadHistoryCounts = {
  notes: number;
  followUps: number;
  pendingFollowUps: number;
  activities: number;
};

/**
 * How many entries one page of a Lead View history holds — the first page `leadDetail`
 * carries, and every page after it. The server allows up to 50.
 */
export const LEAD_VIEW_PAGE_SIZE = 20;

export type LeadFollowUps = {
  /**
   * Every pending follow-up, soonest due first. Not paged: a lead rarely has more than a
   * handful, and the server stops at 100 — `counts.followUps` says when it has.
   */
  pending: FollowUp[];
  /** Completed and cancelled, newest first. Further pages from `leadClosedFollowUps`. */
  closed: Paginated<FollowUp>;
};

/**
 * The Lead View, as GET /leads/:id sends it: the lead and its figures, plus the FIRST page
 * of each history. Never a whole history — each card turns its own pages through the
 * matching `lead*` method, so a lead with years of calls opens as fast as a new one.
 */
export type LeadDetailResponse = {
  lead: LeadDetailLead;
  viewer: LeadViewer;
  callSummary: LeadCallSummary;
  counts: LeadHistoryCounts;
  /** Newest first, each with its notes, follow-ups and status change. */
  calls: Paginated<CallHistoryEntry>;
  /** Newest first, every kind — system notes included, for the screen to mute. */
  notes: Paginated<LeadNote>;
  followUps: LeadFollowUps;
  /** Newest first. Unknown types are possible; render their summary. */
  timeline: Paginated<ActivityEntry>;
};

/** A page of one of the Lead View's histories. */
export type LeadHistoryQuery = { page?: number; pageSize?: number };

/* -------------------------------------------------------------------------- */
/* Moving follow-ups and deactivating employees                                */
/* -------------------------------------------------------------------------- */

/**
 * A move: any of a new time, a new lead and a new employee. Fields left out stay as they
 * are, and at least one must be sent.
 *
 * `dueAt` is an ISO instant — build it with `istToIso` from the IST date and time the
 * admin typed, never from the browser's own clock. `expected` is what the dialog showed
 * as current: if someone else changed the follow-up since, the server refuses with 409
 * `follow_up_changed` instead of silently overwriting their change.
 */
export type MoveFollowUpBody = {
  dueAt?: string;
  leadId?: number;
  assignedTo?: number;
  /** Null keeps the current note. */
  note?: string | null;
  /** Kept in the audit log. */
  reason?: string | null;
  /** Also make the new employee the owner of the lead. */
  transferLead?: boolean;
  expected?: { dueAt: string; assignedTo: number | null; leadId: number };
};

export type MoveFollowUpChanges = {
  dueAt?: { from: string; to: string };
  assignedTo?: { from: number | null; fromName: string | null; to: number; toName: string };
  leadId?: {
    from: number;
    fromReference: string;
    fromName: string;
    to: number;
    toReference: string;
    toName: string;
  };
};

export type MoveFollowUpResult = {
  followUp: FollowUp;
  /** False when the follow-up already matched, so a retried move changes nothing. */
  changed: boolean;
  changes: MoveFollowUpChanges;
  leadTransferred: boolean;
  /** Pending follow-ups left on the lead the follow-up moved away from. */
  sourceLeadPendingFollowUps: number;
};

/** `details` of a 409 `duplicate_follow_up`: the follow-up the move would have doubled. */
export type DuplicateFollowUpDetails = {
  conflict: {
    id: number;
    dueAt: string;
    assignedTo: number | null;
    assignedToName: string | null;
    leadId: number;
  };
};

/** `details` of a 409 `follow_up_changed`: the follow-up as it is now. */
export type FollowUpChangedDetails = { current: FollowUp };

/**
 * When handed-over follow-ups fall due. `keep` leaves every time alone, `overdue_to`
 * re-dates only the overdue ones and `all_to` re-dates all of them. `dueAt` is an ISO
 * instant in the future.
 */
export type HandoverSchedule = { mode: 'keep' } | { mode: 'overdue_to' | 'all_to'; dueAt: string };

export type HandoverBody = {
  toEmployeeId: number;
  /** Left out, every pending follow-up the employee holds is moved. */
  followUpIds?: number[];
  schedule?: HandoverSchedule;
  /** Also transfer the leads behind the moved follow-ups that the employee owns. */
  transferLeads?: boolean;
  reason?: string | null;
};

export type HandoverSkipReason =
  | 'duplicate'
  | 'not_pending'
  | 'not_assigned_to_employee'
  | 'not_found';

/** A follow-up the handover left where it was, and why. */
export type HandoverSkippedRow = {
  followUpId: number;
  leadId: number | null;
  leadName: string | null;
  dueAt: string | null;
  reason: HandoverSkipReason;
  /** For `duplicate`: the target's own follow-up it would have doubled. */
  conflictWithId?: number;
};

export type HandoverResult = {
  moved: number;
  /** Shared by every row this handover moved, in the move history. */
  batchId: string;
  skipped: HandoverSkippedRow[];
  /** Still pending on the employee the follow-ups were moved away from. */
  remainingPending: number;
  leadsTransferred: number;
};

/** Pending follow-ups split by when they fall due. The three buckets add up to `total`. */
export type PendingFollowUpCounts = {
  total: number;
  overdue: number;
  dueToday: number;
  upcoming: number;
};

export type PendingFollowUpBreakdown = PendingFollowUpCounts & {
  onArchivedLeads: number;
  earliestDueAt: string | null;
};

/** `details` of a 409 `pending_follow_ups`, which refuses a deactivation. */
export type PendingFollowUpsDetails = {
  pendingFollowUps: PendingFollowUpCounts;
  skipped?: HandoverSkippedRow[];
};

export type DeactivationBlocker = {
  code: 'pending_follow_ups' | 'self' | 'already_inactive' | 'not_approved';
  message: string;
  count?: number;
};

/**
 * Whether an employee can be deactivated now, and what stands in the way.
 *
 * Advice for the dialog, not the guard: the deactivation itself re-checks inside its
 * transaction, so a follow-up booked after this was read still refuses it with a 409.
 */
export type DeactivationCheck = {
  employee: Employee;
  pendingFollowUps: PendingFollowUpBreakdown;
  openLeads: number;
  canDeactivate: boolean;
  blockers: DeactivationBlocker[];
};

export type DeactivateEmployeeBody = {
  /** Move the pending follow-ups first, in the same transaction as the deactivation. */
  handover?: Omit<HandoverBody, 'followUpIds'>;
  reason?: string | null;
};

export type DeactivateEmployeeResult = {
  employee: Employee;
  handedOver: number;
  leadsTransferred: number;
  sessionsRevoked: number;
  batchId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Daily report email                                                          */
/* -------------------------------------------------------------------------- */

export type ReportRunStatus = 'claimed' | 'sending' | 'sent' | 'partial' | 'failed' | 'skipped';
export type ReportRunTrigger = 'scheduled' | 'manual';

/** One attempt to send a day's report, on the schedule or by hand. */
export type ReportRun = {
  id: number;
  reportDate: string;
  trigger: ReportRunTrigger;
  status: ReportRunStatus;
  attempts: number;
  recipientCount: number;
  deliveredCount: number;
  failureReason: string | null;
  /** A sentence the server wrote for people, safe to show as it is. */
  error: string | null;
  /** `Name <email>` of the administrator who sent it by hand; null for scheduled runs. */
  requestedByLabel: string | null;
  /** A test sent only to the administrator who asked for it. */
  toMe: boolean;
  claimedAt: string;
  finishedAt: string | null;
};

export type DailyEmailStatus = {
  config: {
    enabled: boolean;
    /** 24-hour IST time, HH:MM. */
    sendAt: string;
    timeZone: 'Asia/Kolkata';
    covers: 'previous_day';
    /** Whether the server that answered runs the schedule. It is a per-server switch. */
    schedulerActive: boolean;
    mailConfigured: boolean;
    recipientCount: number;
    /** Masked, e.g. "ow***@example.com". Always the ADMIN_EMAILS list. */
    recipients: string[];
  };
  next: { reportDate: string; dueAt: string } | null;
  /** One page of the run history, newest first. */
  runs: Paginated<ReportRun>;
};

export type DailyReport = {
  reportDate: string;
  /** True for a day that has not finished — a preview of today. */
  partial: boolean;
  window: { start: string; end: string; timeZone: 'Asia/Kolkata' };
  generatedAt: string;
  calls: {
    total: number;
    answered: number;
    notAnswered: number;
    outgoing: number;
    incoming: number;
    incomingMissed: number;
    talkTimeSeconds: number;
    averageAnsweredSeconds: number;
    answerRate: number;
  };
  leads: {
    created: number;
    /** Distinct leads with an answered call. */
    contacted: number;
    /** Distinct leads called at all. */
    attempted: number;
    converted: number;
    walkedIn?: number;
    /** New leads that day by source, with the source's display label. */
    bySource: { key: string; label: string; total: number; converted: number; conversionRate: number }[];
  };
  followUps: {
    /** Booked that day. */
    scheduled: number;
    due: number;
    completed: number;
    completedOnTime: number;
    completedLate: number;
    /** As at `generatedAt`, not as at the end of the day. */
    pending: number;
    overdue: number;
  };
  backlog: {
    unassignedLeads: number;
    pendingCallbacks: number;
    pendingRegistrations: number;
    activeEmployees: number;
    openLeads?: number;
  };
  employees: (EmployeePerformance & { outgoing: number; incoming: number; incomingMissed: number })[];
  /** `followup.overdue_alert_hours`: what `overdueByEmployee` counts as overdue. */
  overdueAlertHours: number;
  overdueByEmployee: { userId: number; name: string; overdue: number; oldestDueAt: string }[];
};

export type DailyEmailPreview = {
  report: DailyReport;
  /** `html` has the logo inlined, so it renders inside a sandboxed iframe. */
  email: { subject: string; html: string; text: string };
};

/** `pending`: delivery was still running after 20 seconds, and the history will settle it. */
export type DailyEmailDelivery = 'sent' | 'partial' | 'failed' | 'skipped' | 'pending';

/* -------------------------------------------------------------------------- */
/* Lead import                                                                 */
/* -------------------------------------------------------------------------- */

/** The server's limits, mirrored for feedback before an upload. The server decides. */
export const LEAD_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const LEAD_IMPORT_MAX_ROWS = 2000;
export const LEAD_IMPORT_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const;

/** The lead fields a spreadsheet column can be read into. */
export const LEAD_IMPORT_FIELDS = [
  'customerName',
  'firstName',
  'lastName',
  'phone',
  'alternatePhone',
  'email',
  'address',
  'city',
  'source',
  'productInterest',
  'status',
  'summaryNote',
  'assignedTo',
] as const;
export type LeadImportField = (typeof LEAD_IMPORT_FIELDS)[number];

export const LEAD_IMPORT_STATES = ['ready', 'committing', 'completed', 'cancelled', 'expired'] as const;
export type LeadImportState = (typeof LEAD_IMPORT_STATES)[number];

/** What the check found in a row, before anything was imported. */
export const LEAD_IMPORT_ROW_OUTCOMES = [
  'ready',
  'warning',
  'error',
  'duplicate_in_file',
  'duplicate_existing',
] as const;
export type LeadImportRowOutcome = (typeof LEAD_IMPORT_ROW_OUTCOMES)[number];

/** Rows per page of an import's row table. The server's default; it allows up to 100. */
export const LEAD_IMPORT_ROWS_PAGE_SIZE = 50;

/** What has happened to the row since. Errors and duplicates start as `not_imported`. */
export const LEAD_IMPORT_ROW_STATES = ['pending', 'not_imported', 'created', 'skipped', 'failed'] as const;
export type LeadImportRowState = (typeof LEAD_IMPORT_ROW_STATES)[number];

/** One uploaded file and where its import has got to. */
export type LeadImport = {
  id: number;
  fileName: string;
  fileKind: 'xlsx' | 'xls' | 'csv';
  fileSize: number;
  sheetName: string | null;
  sheetNames: string[];
  /** One-based, as Excel numbers rows. */
  headerRow: number;
  state: LeadImportState;
  defaults: {
    assignedTo: number | null;
    assignedToName: string | null;
    source: string;
    status: LeadStatus;
  };
  /** Facts about the file when it was checked. They do not change afterwards. */
  totals: {
    rows: number;
    ready: number;
    warnings: number;
    errors: number;
    duplicatesInFile: number;
    duplicatesExisting: number;
  };
  /** Live, counted from the rows. */
  progress: {
    pending: number;
    created: number;
    skipped: number;
    failed: number;
    notImported: number;
  };
  createdBy: { id: number | null; name: string | null };
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
  completedAt: string | null;
};
/** The same type under the name the import contract uses. */
export type LeadImportSummary = LeadImport;

export type LeadImportColumn = {
  /** Zero-based. The key `columnMap` uses. */
  index: number;
  /** The column letter Excel shows, e.g. "C". */
  letter: string;
  header: string;
  field: LeadImportField | null;
  matchedBy: 'alias' | 'manual' | null;
  required: boolean;
};

/**
 * A row's values as they would be saved.
 *
 * Plain strings rather than the lead's own types, because a row with errors carries what
 * the sheet said: `status` is a LeadStatus slug on rows that will import (check with
 * `isLeadStatus`) but can be the cell's own text on a row that will not.
 */
export type LeadImportRowValues = {
  customerName: string | null;
  phone: string | null;
  alternatePhone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  source: string | null;
  productInterest: string | null;
  status: string | null;
  summaryNote: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
};

export type LeadImportDuplicateOf =
  | { kind: 'row'; sheetRow: number }
  | {
      kind: 'lead';
      id: number;
      reference: string;
      customerName: string;
      assignedToName: string | null;
    };

export type LeadImportRow = {
  /** The row number Excel shows. */
  sheetRow: number;
  outcome: LeadImportRowOutcome;
  state: LeadImportRowState;
  values: LeadImportRowValues;
  /** Field name → message, in the same words the lead form uses. */
  errors: Record<string, string>;
  warnings: Record<string, string>;
  duplicateOf: LeadImportDuplicateOf | null;
  leadId: number | null;
  leadReference: string | null;
  /** Why a row was skipped or failed at import time. */
  resultMessage: string | null;
  /** The original cells, aligned with the columns. Only on rows that will not import. */
  raw: (string | null)[] | null;
};

/**
 * What checking a file found. `rows` is the FIRST page only, in sheet order; the rest, and
 * any filtered view, come from `leadImport` one page at a time — a 2,000-row file is never
 * sent to the browser whole.
 */
export type LeadImportPreview = {
  import: LeadImport;
  columns: LeadImportColumn[];
  rows: LeadImportRow[];
  rowsPage: PageInfo;
  notices: string[];
};

export type LeadImportDetail = {
  import: LeadImport;
  columns: LeadImportColumn[];
  /** One page of the rows matching the query, in sheet order. */
  rows: LeadImportRow[];
  rowsPage: PageInfo;
  /** True once the staged rows were cleared after the retention period. */
  rowsPurged?: boolean;
};

/**
 * A page of an import's rows. `outcome` is what the check found; `state` is what has
 * happened since — `not_imported` is every error and duplicate at once.
 */
export type LeadImportRowQuery = {
  page?: number;
  pageSize?: number;
  outcome?: LeadImportRowOutcome;
  state?: LeadImportRowState;
};

export type LeadImportCommitResult = {
  import: LeadImport;
  processed: number;
  remaining: number;
  done: boolean;
  /** Only the rows handled by this call. */
  rows: LeadImportRow[];
};

/** The choices sent with a file to be checked. See `leadImportFormData`. */
export type LeadImportPreviewOptions = {
  /** Who gets rows with no "Assigned to" value. Null or left out: nobody. */
  defaultAssignedTo?: number | null;
  /** A lead source slug, for rows with no source. */
  defaultSource?: string;
  defaultStatus?: LeadStatus;
  /** The sheet to read. Left out, the first visible sheet. */
  sheet?: string;
  /** Overrides the automatic column matching, keyed by zero-based column index. */
  columnMap?: Partial<Record<number, LeadImportField | 'ignore'>>;
  /** `notes` keeps columns that match no field, appended to the lead's notes. */
  extraColumns?: 'ignore' | 'notes';
  /** This user's earlier unfinished check of the same import, to be replaced. */
  replaces?: number;
};

/* -------------------------------------------------------------------------- */
/* Dashboard analytics                                                         */
/* -------------------------------------------------------------------------- */

export const ANALYTICS_GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];
/** What a screen asks for. `auto` lets the server choose from the length of the range. */
export type AnalyticsGranularityChoice = 'auto' | AnalyticsGranularity;

/**
 * One time bucket of a chart.
 *
 * `bucket` is its key — `YYYY-MM-DDTHH:00` for an hour, the date for a day, the Monday for
 * a week, the first of the month for a month. `from` and `to` are the IST dates it covers,
 * clamped to the requested range: the dates to open the list behind the bucket with.
 */
export type AnalyticsFrame = { bucket: string; from: string; to: string };

export type CallBucket = AnalyticsFrame & {
  total: number;
  answered: number;
  notAnswered: number;
  outgoing: number;
  incoming: number;
  incomingNotAnswered: number;
  /** Answered calls only. */
  talkTimeSeconds: number;
  averageDurationSeconds: number;
};

export type LeadBucket = AnalyticsFrame & {
  /** Non-archived leads created in the bucket. */
  created: number;
  /** Leads marked converted in the bucket, whenever they were created. */
  converted: number;
};

/** Follow-ups that fell due in the requested range, by what became of them. */
export type FollowUpDueSummary = {
  total: number;
  completed: number;
  completedOnTime: number;
  completedLate: number;
  overdue: number;
  upcoming: number;
  cancelled: number;
};

export type DashboardAnalytics = {
  /** The offset every bucket is computed in, '+05:30'. */
  timezone: string;
  /** The effective range, after the server filled in a missing end. */
  range: { from: string; to: string };
  /** The effective granularity, which `auto` resolves to. */
  granularity: AnalyticsGranularity;
  /** One zero-filled entry per frame, oldest first. */
  calls: CallBucket[];
  leads: LeadBucket[];
  /** Every status, in LEAD_STATUSES order, zeros included. */
  leadsByStatus: { status: LeadStatus; count: number }[];
  followUps: FollowUpDueSummary;
};

export type AnalyticsQuery = DateRange & {
  granularity?: AnalyticsGranularityChoice;
  userId?: number;
};

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

/**
 * Every date in these queries is an inclusive IST calendar day, `YYYY-MM-DD` — the same
 * strings `rangeFor` and `todayIso` produce. The server turns them into IST day bounds,
 * so a tile, a chart and the list it opens count the same rows.
 */
export type LeadQuery = {
  page?: number;
  pageSize?: number;
  status?: LeadStatus | 'all';
  source?: string;
  /** `assigned` is anyone at all — the dashboard's "Assigned" tile. */
  assignedTo?: number | 'unassigned' | 'assigned' | 'all';
  /** `never`: not one answered call yet. `any`: spoken to at least once. */
  contacted?: 'never' | 'any' | 'all';
  q?: string;
  sort?: LeadSort;
  archived?: boolean;
  /** On the date the lead was created. */
  from?: string;
  to?: string;
  /** On the date the lead was marked converted. */
  convertedFrom?: string;
  convertedTo?: string;
};

export type CallQuery = {
  page?: number;
  pageSize?: number;
  userId?: number | 'all';
  leadId?: number;
  direction?: CallDirection | 'all';
  outcome?: CallOutcomeFilter | 'all';
  /** Left out, the server uses `company`: outgoing plus verified incoming calls. */
  line?: CallLine;
  withRecording?: boolean;
  pendingCallback?: boolean;
  q?: string;
  from?: string;
  to?: string;
};

export type FollowUpQuery = {
  scope: FollowUpScope;
  page?: number;
  pageSize?: number;
  assignedTo?: number | 'all';
  leadId?: number;
  q?: string;
  /** On the due date. */
  from?: string;
  to?: string;
};

export type EmployeeQuery = {
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
  /** `missing`: telecallers with no company number, or whose phone has not confirmed the SIM. */
  companySim?: 'missing';
  q?: string;
};

export const telecallingApi = {
  /* ------------------------------------------------------------- dashboard */

  dashboard: (range: DateRange, signal?: AbortSignal) =>
    adminRequest<AdminDashboardResponse>(`${BASE}/dashboard${qs({ ...range })}`, {
      signal,
    }).then(
      (body): AdminDashboard => ({
        leads: body.leads,
        calls: body.calls,
        followUps: body.followUps,
        /*
         * The endpoint returns per-employee rows under `employees`, which collides with the
         * headcount tile of the same name, so the two are renamed here once rather than in
         * every component that reads them.
         *
         * Field by field rather than `...body`: a spread would carry the rows into
         * `employees` whenever `headcount` was missing. Zeros are wrong for an API that
         * predates `headcount`, but visibly so, where the array rendered as a blank tile.
         */
        employees: body.headcount ?? { total: 0, active: 0 },
        employeeRows: body.employees,
        conversionRate: body.conversionRate,
        overdueByEmployee: body.overdueByEmployee,
        pendingRegistrations: body.pendingRegistrations ?? 0,
      }),
    ),

  /**
   * The dashboard's trend charts: calls and leads per time bucket, leads by status, and
   * follow-ups due in the range.
   *
   * A separate request from `dashboard`, so changing the granularity refetches only the
   * charts and a chart failure cannot blank the tiles. Buckets are IST and zero-filled.
   */
  dashboardAnalytics: (query: AnalyticsQuery, signal?: AbortSignal) =>
    adminRequest<DashboardAnalytics>(`${BASE}/dashboard/analytics${qs({ ...query })}`, {
      signal,
    }),

  /* ------------------------------------------------------------- employees */

  listEmployees: (query: EmployeeQuery, signal?: AbortSignal) =>
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
        /** `calls` by direction. Optional: an older server does not send them. */
        outgoingCalls?: number;
        incomingCalls?: number;
      };
      openLeads: number;
      activity: ActivityEntry[];
    }>(`${BASE}/employees/${id}${qs({ ...range })}`, { signal }),

  createEmployee: (body: {
    name: string;
    email: string;
    /** Personal phone, optional. */
    phone?: string | null;
    /** The company SIM number. Required by the server when `role` is telecaller. */
    companyPhone?: string | null;
    password: string;
    role: EmployeeRole;
    employeeCode?: string;
  }) =>
    adminRequest<{ employee: Employee }>(`${BASE}/employees`, {
      method: 'POST',
      body,
    }).then((r) => r.employee),

  /**
   * Partial update: a key left out is left unchanged, and only an explicit null clears.
   *
   * Changing `companyPhone` clears the employee's confirmed SIM, so their phone asks them
   * to choose it again. `isActive: false` is refused with 409 `pending_follow_ups` while
   * they still hold pending follow-ups (`PendingFollowUpsDetails` in the error's
   * `details`), and then nothing in the body is saved.
   */
  updateEmployee: (
    id: number,
    body: Partial<{
      name: string;
      email: string;
      phone: string | null;
      companyPhone: string | null;
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

  /**
   * Moves an employee's pending follow-ups to someone else, in one transaction.
   *
   * Pass an employee id to move every pending follow-up with its date kept — the original
   * behaviour, still what that body means — or a HandoverBody to move a selection,
   * re-date them or transfer the leads too. Same-day duplicates for the target are left in
   * place and listed in `skipped` rather than doubled up.
   */
  handoverFollowUps: (fromId: number, target: number | HandoverBody) =>
    adminRequest<HandoverResult>(`${BASE}/employees/${fromId}/handover-follow-ups`, {
      method: 'POST',
      body: typeof target === 'number' ? { toEmployeeId: target } : target,
    }),

  /** Manager and above. Read-only: see DeactivationCheck for why it is advice, not the guard. */
  deactivationCheck: (id: number, signal?: AbortSignal) =>
    adminRequest<DeactivationCheck>(`${BASE}/employees/${id}/deactivation-check`, { signal }),

  /**
   * Deactivates an employee, first moving their pending follow-ups when `handover` is
   * given — all in one transaction, so nothing can be booked onto them in between.
   *
   * Administrator only. Refused with 409 `pending_follow_ups` if anything would remain
   * pending (a skipped same-day duplicate, say); then nothing was moved or changed.
   */
  deactivateEmployee: (id: number, body: DeactivateEmployeeBody = {}) =>
    adminRequest<DeactivateEmployeeResult>(`${BASE}/employees/${id}/deactivate`, {
      method: 'POST',
      body,
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
   *
   * `companyPhone` is required when the applicant has none on record (older app builds
   * did not ask for it); the server refuses with 400 until one is given, and saves it in
   * the same update as the approval.
   */
  approveRegistration: (id: number, companyPhone?: string) =>
    adminRequest<{ employee: Employee }>(`${BASE}/registrations/${id}/approve`, {
      method: 'POST',
      body: companyPhone === undefined ? undefined : { companyPhone },
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

  /**
   * The admin lead list. Each row carries its newest note, which the mobile list does not.
   *
   * The row-level actions (`assignLead`, `setLeadStatus`) answer with a plain Lead, so a
   * screen updating a row in place must merge the answer into the row it has — replacing
   * the row would drop `latestNote`.
   */
  listLeads: (query: LeadQuery, signal?: AbortSignal) =>
    adminRequest<Paginated<LeadListItem>>(
      `${BASE}/leads${qs({ ...query, archived: query.archived ? 'true' : undefined })}`,
      { signal },
    ),

  /**
   * The Lead View in one request: the lead, its figures, every pending follow-up, and the
   * first page of each history — calls (with their notes, follow-ups and status change),
   * notes, closed follow-ups and activity. 404 for a lead that is gone or out of reach.
   */
  leadDetail: (id: number, signal?: AbortSignal) =>
    adminRequest<LeadDetailResponse>(`${BASE}/leads/${id}`, { signal }).then(expectLeadDetail),

  /*
   * One more page of a Lead View history each, newest first; `pageSize` defaults to 20 and
   * is at most 50. Paged by offset, so a call logged while someone reads moves every row
   * down by one — a page turned afterwards repeats a row rather than skipping one. A page
   * past the end is answered with the last page.
   */

  leadCalls: (id: number, query: LeadHistoryQuery = {}, signal?: AbortSignal) =>
    adminRequest<Paginated<CallHistoryEntry>>(`${BASE}/leads/${id}/calls${qs({ ...query })}`, {
      signal,
    }).then(expectPage),

  /** Every kind, system notes included. */
  leadNotes: (id: number, query: LeadHistoryQuery = {}, signal?: AbortSignal) =>
    adminRequest<Paginated<LeadNote>>(`${BASE}/leads/${id}/notes${qs({ ...query })}`, {
      signal,
    }).then(expectPage),

  /** Completed and cancelled follow-ups. The pending ones all come with `leadDetail`. */
  leadClosedFollowUps: (id: number, query: LeadHistoryQuery = {}, signal?: AbortSignal) =>
    adminRequest<Paginated<FollowUp>>(`${BASE}/leads/${id}/follow-ups${qs({ ...query })}`, {
      signal,
    }).then(expectPage),

  leadActivity: (id: number, query: LeadHistoryQuery = {}, signal?: AbortSignal) =>
    adminRequest<Paginated<ActivityEntry>>(`${BASE}/leads/${id}/activity${qs({ ...query })}`, {
      signal,
    }).then(expectPage),

  /**
   * Creates a lead.
   *
   * Typed rather than `Record<string, unknown>`, which is what this was: an untyped body
   * on the one call with fourteen optional fields meant a misspelled key compiled fine
   * and was silently dropped by the server's Zod schema.
   *
   * `possibleDuplicate` is always null and is kept only so older callers do not break on
   * a missing field. One active lead may hold a number; a second create is refused with
   * the clash named against `phone` in `fieldErrors`, which the form already renders.
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

  /* ----------------------------------------------------------- lead import */

  /**
   * The blank import template, as a direct download that carries the session cookie.
   *
   * A URL rather than a request, like `leadAttachmentUrl`: the response is a file for the
   * browser to save, not JSON for a screen to read. Manager and above.
   */
  leadImportTemplateUrl: () => `${apiBaseUrl()}${BASE}/lead-imports/template`,

  /**
   * The rows of an import that were not imported — errors and duplicates found by the
   * check, and rows refused or failed while importing — as a CSV of the file's own
   * columns plus a Problem column, to fix and import again. Manager and above.
   *
   * Built by the server and fetched as a file, like the template: the screen holds one
   * page of rows at a time and must not gather the whole file to write it out.
   */
  leadImportRowsCsvUrl: (id: number) => `${apiBaseUrl()}${BASE}/lead-imports/${id}/rows.csv`,

  /**
   * Uploads a spreadsheet to be checked. Nothing is imported yet: the answer says what
   * would happen to every row, and `commitLeadImport` does it.
   *
   * Build the form with `leadImportFormData`, which knows the field names the server
   * reads. The transport sends FormData with the CSRF header and no Content-Type, so the
   * browser can set the multipart boundary.
   */
  previewLeadImport: (form: FormData, signal?: AbortSignal) =>
    adminRequest<LeadImportPreview>(`${BASE}/lead-imports`, {
      method: 'POST',
      body: form,
      signal,
    }).then(expectRowsPage),

  /** Imports, newest first. `{ state: 'committing', mine: true }` finds one to resume. */
  listLeadImports: (
    query: { page?: number; pageSize?: number; state?: LeadImportState; mine?: boolean } = {},
    signal?: AbortSignal,
  ) =>
    adminRequest<Paginated<LeadImport>>(`${BASE}/lead-imports${qs({ ...query })}`, { signal }),

  /**
   * One import and a page of its rows — to resume after a reload, to turn the pages of a
   * check, or to show the results. `pageSize` defaults to 50 and is at most 100.
   */
  leadImport: (id: number, query: LeadImportRowQuery = {}, signal?: AbortSignal) =>
    adminRequest<LeadImportDetail>(`${BASE}/lead-imports/${id}${qs({ ...query })}`, {
      signal,
    }).then(expectRowsPage),

  /**
   * Imports the next batch of rows (at most 250). Call it until `done`.
   *
   * Safe to retry after a timeout or a dropped connection: each row is created at most
   * once whatever happens to the response. A 409 `import_busy` means another window is
   * running this import right now.
   */
  commitLeadImport: (id: number, batchSize = 100) =>
    adminRequest<LeadImportCommitResult>(`${BASE}/lead-imports/${id}/commit`, {
      method: 'POST',
      body: { batchSize },
    }),

  /** Stops an import. Leads already created are kept. */
  cancelLeadImport: (id: number) =>
    adminRequest<{ import: LeadImport }>(`${BASE}/lead-imports/${id}/cancel`, {
      method: 'POST',
    }).then((r) => r.import),

  /* ----------------------------------------------------------------- calls */

  /**
   * The admin call list, with each call's newest note and the figures for the whole
   * filtered set.
   *
   * The note fields and `summary` are filled in as null and 0 when the server predates
   * them, so a screen can render them unconditionally. Everything else comes through as
   * sent.
   */
  listCalls: (query: CallQuery, signal?: AbortSignal) =>
    adminRequest<CallListResponse>(
      `${BASE}/calls${qs({
        ...query,
        withRecording: query.withRecording === undefined ? undefined : String(query.withRecording),
        pendingCallback:
          query.pendingCallback === undefined ? undefined : String(query.pendingCallback),
      })}`,
      { signal },
    ).then(
      (body): CallList => ({
        ...body,
        items: body.items.map((call) => ({
          ...call,
          latestNote: call.latestNote ?? null,
          noteCount: call.noteCount ?? 0,
        })),
        summary: body.summary ?? null,
      }),
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

  listFollowUps: (query: FollowUpQuery, signal?: AbortSignal) =>
    adminRequest<Paginated<FollowUp>>(`${BASE}/follow-ups${qs({ ...query })}`, { signal }),

  createFollowUp: (body: { leadId: number; dueAt: string; note?: string | null; assignedTo?: number }) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups`, { method: 'POST', body }),

  /**
   * Edits the note, or reassigns.
   *
   * A reassignment goes through the same rules as `moveFollowUp`: only a pending
   * follow-up can be reassigned (409 `follow_up_not_pending`), and not onto someone who
   * already has one with this customer that day (409 `duplicate_follow_up`). A
   * deactivated employee is still refused with a 400.
   */
  updateFollowUp: (id: number, body: { note?: string | null; assignedTo?: number }) =>
    adminRequest<{ followUp: FollowUp }>(`${BASE}/follow-ups/${id}`, { method: 'PATCH', body }),

  /**
   * Moves a pending follow-up to a new time, lead or employee, in one step.
   *
   * Errors worth handling by `code`: 409 `duplicate_follow_up` (DuplicateFollowUpDetails),
   * 409 `follow_up_changed` (FollowUpChangedDetails), 409 `follow_up_not_pending`, and
   * 422 with field errors on `dueAt`, `leadId` or `assignedTo`. Supervisor and above.
   */
  moveFollowUp: (id: number, body: MoveFollowUpBody) =>
    adminRequest<MoveFollowUpResult>(`${BASE}/follow-ups/${id}/move`, {
      method: 'POST',
      body,
    }),

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
      /** More periods than one response holds; `items` are the newest. */
      truncated?: boolean;
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

  /* ---------------------------------------------------- daily report email */

  /**
   * The daily email's settings, recipients (masked), next run, and one page of its run
   * history — `pageSize` at most 50, 10 when left out.
   *
   * Administrator only: it shows where every employee's figures are being sent.
   */
  dailyEmailStatus: (query: { page?: number; pageSize?: number } = {}, signal?: AbortSignal) =>
    adminRequest<DailyEmailStatus>(`${BASE}/reports/daily-email${qs({ ...query })}`, { signal }),

  /**
   * The report and the email for a day, without sending anything. Left out, the date is
   * yesterday in IST; today is allowed and comes back `partial`.
   */
  dailyEmailPreview: (date: string | undefined, signal?: AbortSignal) =>
    adminRequest<DailyEmailPreview>(`${BASE}/reports/daily-email/preview${qs({ date })}`, {
      signal,
    }),

  /**
   * Sends a finished day's report now, independently of the schedule.
   *
   * To the configured recipients, or with `toMe` only to the signed-in administrator — a
   * test that reaches nobody else. Left out, the date is yesterday in IST. Refused with
   * 400 for today, for a future day, or for a day sent by hand in the last few minutes.
   */
  sendDailyEmail: (date?: string, options: { toMe?: boolean } = {}) =>
    adminRequest<{ delivery: DailyEmailDelivery; run: ReportRun }>(
      `${BASE}/reports/daily-email/send`,
      { method: 'POST', body: { date, toMe: options.toMe } },
    ),

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

/**
 * The multipart form `previewLeadImport` uploads.
 *
 * Built here rather than in the screen so the field names the server reads live next to
 * the call that sends them — a misspelled multipart field is dropped without a word, and
 * the import would quietly fall back to its defaults.
 *
 * The choices go in before the file. The server reads parts in order, so this way they
 * have arrived by the time the file is being looked at.
 */
export function leadImportFormData(file: File, options: LeadImportPreviewOptions = {}): FormData {
  const form = new FormData();

  // Left out rather than sent empty: the server treats a missing default as "leave
  // unassigned", and an empty string would only exercise its tolerance for one.
  if (options.defaultAssignedTo !== undefined && options.defaultAssignedTo !== null) {
    form.append('defaultAssignedTo', String(options.defaultAssignedTo));
  }
  if (options.defaultSource) form.append('defaultSource', options.defaultSource);
  if (options.defaultStatus) form.append('defaultStatus', options.defaultStatus);
  if (options.sheet) form.append('sheet', options.sheet);
  if (options.columnMap && Object.keys(options.columnMap).length > 0) {
    form.append('columnMap', JSON.stringify(options.columnMap));
  }
  if (options.extraColumns) form.append('extraColumns', options.extraColumns);
  if (options.replaces !== undefined) form.append('replaces', String(options.replaces));

  form.append('file', file, file.name);
  return form;
}

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

/**
 * `days` calendar days before today in IST, as YYYY-MM-DD.
 *
 * Plain date arithmetic on today's IST date. This used to step back on the browser's own
 * clock and then read the result in IST, so on a laptop whose zone changes its clocks, a
 * range that crossed the change could start a day early or late near IST midnight.
 */
export function daysAgoIso(days: number): string {
  return addDaysToIsoDate(todayIso(), -days);
}

/* ---------------------------------------------------- IST date and time */

/*
 * These work on IST wall-clock dates and times as strings — `YYYY-MM-DD` and `HH:mm` —
 * whatever zone the browser is in. An admin types IST into a date and a time input, and a
 * timeline groups by the IST day. Going through the browser's own clock for either would
 * move a 00:30 call onto the previous day for anyone not sitting in India.
 */

/**
 * IST calendar parts of an instant.
 *
 * `hourCycle: 'h23'`, never `hour12: false`: the latter can format midnight as "24:00",
 * which then fails every comparison with a time input's "00:00".
 */
const IST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOURS_MINUTES = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A calendar date as numbers, or null when the string is not a real date. */
function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Date.UTC rolls an impossible date over — 30 February becomes 2 March — so the date is
  // read back and compared rather than trusted.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/** Whether a string is a real `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** The IST date and 24-hour time of an instant, or null for an unreadable timestamp. */
export function istParts(value: string | Date): { date: string; time: string } | null {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) return null;

  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of IST_PARTS.formatToParts(instant)) parts[part.type] = part.value;

  const { year, month, day, hour, minute } = parts;
  if (!year || !month || !day || !hour || !minute) return null;
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

/**
 * The instant an admin means by an IST date and time, as an ISO string for the API.
 *
 * Null for anything that is not a real date and time. The browser's parser accepts
 * "2026-02-30" by rolling it over to 2 March, and "24:00" as the next midnight, so the
 * result is converted back and compared: a moment the admin did not type is never sent.
 */
export function istToIso(date: string, time: string): string | null {
  if (!ISO_DATE.test(date) || !HOURS_MINUTES.test(time)) return null;

  const instant = new Date(`${date}T${time}:00+05:30`);
  const back = istParts(instant);
  return back !== null && back.date === date && back.time === time ? instant.toISOString() : null;
}

/** A `YYYY-MM-DD` date moved by whole days. Calendar arithmetic only — no clock involved. */
export function addDaysToIsoDate(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed || !Number.isFinite(days)) {
    throw new RangeError(
      `addDaysToIsoDate needs a YYYY-MM-DD date and a number of days, not "${date}" and ${days}.`,
    );
  }

  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + Math.trunc(days)))
    .toISOString()
    .slice(0, 10);
}

/**
 * The IST calendar day of an instant, as YYYY-MM-DD: the key to group a timeline by.
 *
 * Never `iso.slice(0, 10)`, which is the UTC day and puts everything between midnight
 * and 05:30 IST on the day before. Empty for an unreadable timestamp.
 */
export function istDayKey(value: string | Date): string {
  return istParts(value)?.date ?? '';
}

/** The IST time of day, e.g. "02:30 pm" — the clock half of `formatDateTime`. */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  return instant.toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
}

/**
 * The heading for one IST day of a timeline — "Today", "Yesterday" or "Mon, 05 Oct 2026" —
 * from a key made by `istDayKey`.
 */
export function formatDayHeading(dayKey: string): string {
  const parsed = parseIsoDate(dayKey);
  if (!parsed) return '—';

  const today = todayIso();
  if (dayKey === today) return 'Today';
  if (dayKey === addDaysToIsoDate(today, -1)) return 'Yesterday';

  // Noon UTC on that date, formatted in UTC: the calendar date itself, with no zone left
  // to move it.
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12)).toLocaleDateString(
    'en-IN',
    { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' },
  );
}

/* --------------------------------------------------- counts and charts */

/** A count with Indian digit grouping, e.g. 1,23,456. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-IN') : '—';
}

/** A length of time as a clock, e.g. "3:24", or "1:02:05" from an hour up. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * The parts of a calendar date as words.
 *
 * Formatted in UTC from noon UTC on the date, so the parts are that date's own whatever
 * zone the browser is in. Month names follow the browser's `en-IN` data, the same source
 * `formatDate` uses, so the two always agree on how a month is written.
 */
const CALENDAR_PARTS = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

type CalendarParts = { weekday: string; day: string; month: string; year: string };

function calendarParts(value: string): CalendarParts | null {
  const parsed = parseIsoDate(value);
  if (!parsed) return null;

  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const noon = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12));
  for (const part of CALENDAR_PARTS.formatToParts(noon)) parts[part.type] = part.value;

  return {
    weekday: parts.weekday ?? '',
    day: parts.day ?? '',
    month: parts.month ?? '',
    year: parts.year ?? '',
  };
}

/**
 * A range of IST dates in words: "1–7 Oct", "29 Sep – 5 Oct", "29 Dec 2025 – 4 Jan 2026",
 * "From 5 Oct", "Until 5 Oct", or "All time" with neither end.
 *
 * The year appears only when it is not the current one, or when the range crosses into
 * another. For the custom-range chip and for a chart's period caption.
 */
export function formatDateRange(range: { from?: string | null; to?: string | null }): string {
  const from = range.from ? calendarParts(range.from) : null;
  const to = range.to ? calendarParts(range.to) : null;
  const currentYear = todayIso().slice(0, 4);

  const dayMonth = (parts: CalendarParts) =>
    parts.year === currentYear ? `${parts.day} ${parts.month}` : `${parts.day} ${parts.month} ${parts.year}`;

  if (from && to) {
    if (range.from === range.to) return dayMonth(from);
    if (from.year !== to.year) {
      return `${from.day} ${from.month} ${from.year} – ${to.day} ${to.month} ${to.year}`;
    }

    const year = to.year === currentYear ? '' : ` ${to.year}`;
    if (from.month === to.month) return `${from.day}–${to.day} ${to.month}${year}`;
    return `${from.day} ${from.month} – ${to.day} ${to.month}${year}`;
  }

  if (from) return `From ${dayMonth(from)}`;
  if (to) return `Until ${dayMonth(to)}`;
  return 'All time';
}

/**
 * The title of one chart bucket, for a tooltip or a row of the table view: an hour
 * "09:00–10:00", a day "Mon 06 Oct", a week "29 Sep – 5 Oct", a month "Oct 2026".
 *
 * Built from the bucket's own strings, so it never moves with the browser's zone. An hour
 * title carries no date; on a chart spanning two days, put the day's title in front of it.
 * A week is titled by the dates it covers inside the range, so a first or last week the
 * range cuts short says so rather than claiming seven days.
 */
export function formatBucketTitle(frame: AnalyticsFrame, granularity: AnalyticsGranularity): string {
  if (granularity === 'hour') {
    const hour = Number(/T(\d{2}):/.exec(frame.bucket)?.[1]);
    if (!Number.isInteger(hour)) return frame.bucket;
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(hour)}:00–${pad(hour + 1)}:00`;
  }

  if (granularity === 'week') return formatDateRange({ from: frame.from, to: frame.to });

  const parts = calendarParts(frame.bucket);
  if (!parts) return frame.bucket;

  return granularity === 'month'
    ? `${parts.month} ${parts.year}`
    : `${parts.weekday} ${parts.day.padStart(2, '0')} ${parts.month}`;
}

export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Screen-specific additions                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Helpers used by one screen only: the Lead View and lead import, then calls, follow-ups
 * and employees. Anything shared by more than one screen belongs above, not here.
 */

/*
 * Shape checks for the paged Lead View and import responses.
 *
 * These screens index into nested pages (`calls.items`, `followUps.closed.items`) on
 * every render. A response in another shape — an API from before paging sent whole
 * arrays — would throw inside React and blank the entire admin, not just this screen. A
 * failed check is turned into an ordinary error instead, which the screen shows with a
 * Retry, and nothing is guessed: a whole array passed off as "page 1 of 1" would hide the
 * very thing paging is there to prevent.
 */

const UNEXPECTED_RESPONSE =
  'This could not be shown. Refresh the page, and tell your administrator if it keeps happening.';

function unexpectedResponse(): ApiError {
  return new ApiError(UNEXPECTED_RESPONSE, 500, {}, 'unexpected_response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPageInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.page === 'number' &&
    typeof value.pageSize === 'number' &&
    typeof value.total === 'number' &&
    typeof value.totalPages === 'number'
  );
}

function isPage(value: unknown): boolean {
  return isPageInfo(value) && isRecord(value) && Array.isArray(value.items);
}

function expectPage<T>(body: Paginated<T>): Paginated<T> {
  if (!isPage(body)) throw unexpectedResponse();
  return body;
}

function expectLeadDetail(body: LeadDetailResponse): LeadDetailResponse {
  const value: unknown = body;
  const ok =
    isRecord(value) &&
    isRecord(value.lead) &&
    isRecord(value.viewer) &&
    isRecord(value.callSummary) &&
    isRecord(value.counts) &&
    isPage(value.calls) &&
    isPage(value.notes) &&
    isPage(value.timeline) &&
    isRecord(value.followUps) &&
    Array.isArray(value.followUps.pending) &&
    isPage(value.followUps.closed);
  if (!ok) throw unexpectedResponse();
  return body;
}

function expectRowsPage<T extends { rows: LeadImportRow[]; rowsPage: PageInfo }>(body: T): T {
  const value: unknown = body;
  if (!isRecord(value) || !Array.isArray(value.rows) || !isPageInfo(value.rowsPage)) {
    throw unexpectedResponse();
  }
  return body;
}

/**
 * The ten-digit national number of an Indian mobile, or null when the text is not one.
 *
 * Mirrors `companyPhoneKey` in the server's shared.schema.ts — non-digits dropped, then a
 * leading 91 (twelve digits) or 0 (eleven), then 6–9 followed by nine digits — so the
 * employee forms can say "Enter a 10-digit mobile number" before the round trip instead
 * of after it. The server stays the judge: it checks again, stores the canonical
 * `+91XXXXXXXXXX` and refuses a number another employee already holds.
 */
export function companyPhoneKey(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * A company number as people read it aloud: "+91 98765 43210".
 *
 * The server stores `+91XXXXXXXXXX`. Anything not in that shape is shown exactly as it
 * came, rather than reformatted on a guess.
 */
export function formatCompanyPhone(value: string | null): string {
  if (!value) return '—';
  const key = /^\+91([6-9]\d{9})$/.exec(value)?.[1];
  return key ? `+91 ${key.slice(0, 5)} ${key.slice(5)}` : value;
}

/**
 * `telecallingApi.listCalls`, except that `line: 'all'` actually reaches the server.
 *
 * `qs` leaves out every `all`, which is right for the filters where `all` means "no
 * filter" — and wrong for `line`, the one parameter whose server-side default is not
 * "everything". Left out, `line` is `company`, so the unverified incoming calls an admin
 * asked to see by choosing "All" would silently disappear. For any other line this is
 * `listCalls` itself; the mapping below repeats its handling of an older server.
 */
export function listCallsOnLine(query: CallQuery, signal?: AbortSignal): Promise<CallList> {
  if (query.line !== 'all') return telecallingApi.listCalls(query, signal);

  const search = qs({
    ...query,
    line: undefined,
    withRecording: query.withRecording === undefined ? undefined : String(query.withRecording),
    pendingCallback: query.pendingCallback === undefined ? undefined : String(query.pendingCallback),
  });

  return adminRequest<CallListResponse>(`${BASE}/calls${search}${search ? '&' : '?'}line=all`, {
    signal,
  }).then(
    (body): CallList => ({
      ...body,
      items: body.items.map((call) => ({
        ...call,
        latestNote: call.latestNote ?? null,
        noteCount: call.noteCount ?? 0,
      })),
      summary: body.summary ?? null,
    }),
  );
}
