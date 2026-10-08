import { z } from 'zod';
import type { DeliveryStatus } from '../../../services/deliveryStatus';
import type { EmployeePerformance, OverdueGroup } from '../dashboard/dashboard.repository';
import type { Paginated } from '../shared.schema';

/**
 * The daily telecalling report email (Requirement 1): its vocabulary, its tuning, its
 * request shapes and the report it sends.
 *
 * Every morning the previous complete IST day is summarised and emailed to the
 * administrators. Several API processes may be running and any of them may restart
 * mid-send, so whether a day's report has gone out is decided by the database — one
 * `report_runs` row per scheduled day, claimed and leased (migration 023) — and never by
 * a process remembering that it sent something.
 */

/** `report_runs.report_type` for this report. A string so a weekly one needs no ALTER. */
export const DAILY_REPORT_TYPE = 'telecalling_daily';

export const REPORT_RUN_STATUSES = ['claimed', 'sending', 'sent', 'partial', 'failed', 'skipped'] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

export const REPORT_TRIGGERS = ['scheduled', 'manual'] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

/**
 * Why a run did not reach everyone.
 *
 *   generation_failed    the figures could not be read — retried, nothing was sent
 *   mail_rejected        the mail server refused every recipient — retried, nobody got it
 *   no_recipients        nobody is configured to receive it — retried, the list may be fixed
 *   mail_not_configured  this server has no mail transport — picked up by a server that has
 *                        one, because nobody received anything
 *   interrupted          stopped part-way through sending — it may have arrived, so it is
 *                        NEVER retried: a missing email is better than a duplicate
 */
export const REPORT_FAILURE_REASONS = [
  'generation_failed',
  'mail_rejected',
  'no_recipients',
  'mail_not_configured',
  'interrupted',
] as const;
export type ReportFailureReason = (typeof REPORT_FAILURE_REASONS)[number];

/** The failures after which the scheduled run may try again — nobody has received it. */
export const RETRYABLE_FAILURES: readonly ReportFailureReason[] = [
  'generation_failed',
  'mail_rejected',
  'no_recipients',
];

/**
 * Who a run was addressed to: the configured recipients, or only the administrator who
 * pressed "send a test to me". Kept in the run's `summary` JSON — the table predates the
 * test send and the distinction only matters to the history screen and the resend guard.
 */
export const REPORT_AUDIENCES = ['recipients', 'requester'] as const;
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];

/** `report.daily_email_time`: 24-hour IST wall-clock time, `HH:MM`. */
export const SEND_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const DEFAULT_SEND_TIME = '08:00';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long after its send time a day's report may still go out.
 *
 * A server that was down at 08:00 sends when it comes back, but not at midnight with
 * figures nobody will act on: past the window the day is left unsent — visible in the
 * history, and sendable by hand. Twelve hours keeps consecutive days' windows 12 hours
 * apart, so at most one report is ever due.
 */
export const CATCH_UP_HOURS = 12;

/**
 * How long a claim holds before another process may take the run over.
 *
 * Generating and sending take seconds; ten minutes is far beyond a healthy run and short
 * enough that a crashed owner delays the report by one or two scheduler ticks.
 */
export const LEASE_MINUTES = 10;

/** A scheduled day is attempted at most this often, retries included. */
export const MAX_SCHEDULED_ATTEMPTS = 3;

/** The wait before a failed scheduled run is tried again. */
export const RETRY_GAP_MINUTES = 30;

/**
 * A manual send for the same day and audience inside this window is refused as a double
 * submission — two tabs, two administrators, an impatient second click.
 */
export const MANUAL_RESEND_GUARD_MINUTES = 5;

/** How far back a manual send may reach. Older days can still be previewed. */
export const MAX_REPORT_AGE_DAYS = 366;

/**
 * How long a manual send's request waits for the mail server before answering
 * "still sending". The send carries on in the background and the history settles it.
 */
export const MANUAL_SEND_WAIT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** An IST calendar day. `2026-02-30` is refused, not rolled over into March. */
const reportDateField = z.string().date('Expected YYYY-MM-DD.');

/**
 * The status screen. The run history is a list that grows by a row a day for ever, so it
 * is paged on the server like every other list — a small first page, and a hard ceiling
 * the repository can interpolate into LIMIT safely.
 */
export const dailyReportStatusQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

/** Left out, the day is yesterday (IST). Today is allowed and comes back `partial`. */
export const dailyReportPreviewQuerySchema = z.object({
  date: reportDateField.optional(),
});

/**
 * A manual send. `toMe` sends a test to the requesting administrator's own address and
 * to nobody else — still recorded as a run and still audited.
 */
export const dailyReportSendSchema = z.object({
  date: reportDateField.nullish().transform((value) => value ?? undefined),
  toMe: z
    .boolean({ invalid_type_error: 'toMe must be true or false.' })
    .nullish()
    .transform((value) => value ?? false),
});

export type DailyReportStatusQuery = z.infer<typeof dailyReportStatusQuerySchema>;
export type DailyReportPreviewQuery = z.infer<typeof dailyReportPreviewQuerySchema>;
export type DailyReportSendInput = z.infer<typeof dailyReportSendSchema>;

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** One attempt to send a day's report, as the API shows it. */
export type ReportRunRecord = {
  id: number;
  reportDate: string;
  trigger: ReportTrigger;
  status: ReportRunStatus;
  attempts: number;
  recipientCount: number;
  deliveredCount: number;
  failureReason: ReportFailureReason | null;
  /** A sentence written by this service for people to read — never raw driver text. */
  error: string | null;
  /** `Name <email>` of the administrator who sent it by hand; null for scheduled runs. */
  requestedByLabel: string | null;
  /** A test sent only to the administrator who asked for it. */
  toMe: boolean;
  claimedAt: string;
  finishedAt: string | null;
};

/** A row of the team table: the dashboard's own per-employee figures, split by direction. */
export type ReportEmployeeRow = EmployeePerformance & {
  outgoing: number;
  incoming: number;
  incomingMissed: number;
};

/**
 * Everything the email says, as data. Returned by the preview so the admin screen can
 * show the figures beside the rendered email, and stored with each run as a record of
 * what was sent.
 *
 * Day figures cover `window` — one whole IST day, half-open. Figures named "now"
 * (`followUps.pending`, `followUps.overdue`, `backlog`) are as at `generatedAt`: "how much
 * is still owed" does not change meaning because the report is about yesterday. Every
 * call figure counts the company line only — outgoing calls, and incoming calls verified
 * as arriving on the employee's company SIM.
 */
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
    /** Whole percent of calls answered, rounded as the dashboard rounds it; 0 with no calls. */
    answerRate: number;
  };
  leads: {
    created: number;
    /** Distinct leads with an answered call. */
    contacted: number;
    /** Distinct leads called at all. */
    attempted: number;
    converted: number;
    /** New leads that day by source, with the source's display label. */
    bySource: { key: string; label: string; total: number; converted: number; conversionRate: number }[];
  };
  followUps: {
    /** Booked that day. */
    scheduled: number;
    /** Due that day and not cancelled. */
    due: number;
    completed: number;
    completedOnTime: number;
    completedLate: number;
    pending: number;
    overdue: number;
  };
  backlog: {
    unassignedLeads: number;
    pendingCallbacks: number;
    pendingRegistrations: number;
    activeEmployees: number;
    openLeads: number;
  };
  /**
   * Active telecallers (a quiet day must be visible, not absent) and anyone else with
   * activity that day — busiest first.
   */
  employees: ReportEmployeeRow[];
  /** `followup.overdue_alert_hours`: what `overdueByEmployee` counts as overdue. */
  overdueAlertHours: number;
  overdueByEmployee: OverdueGroup[];
};

/** What one tick of the schedule did. */
export type RunOutcome =
  /** `report.daily_email_enabled` is off. */
  | { kind: 'disabled' }
  /** No day's report is due at this moment. */
  | { kind: 'not_due' }
  /** The day's run is over and will not run again on the schedule. */
  | { kind: 'already_done'; reportDate: string; run: ReportRunRecord }
  /** Another process holds the day's run, or won the race to claim it. */
  | { kind: 'in_progress'; reportDate: string }
  /** It failed and will be tried again after the retry gap. */
  | { kind: 'retry_later'; reportDate: string; run: ReportRunRecord }
  /** Found dead part-way through sending, and closed without resending. */
  | { kind: 'interrupted'; reportDate: string; run: ReportRunRecord }
  /** This call claimed the run and executed it. */
  | { kind: 'ran'; run: ReportRunRecord };

export type DailyReportStatus = {
  config: {
    enabled: boolean;
    sendAt: string;
    timeZone: 'Asia/Kolkata';
    covers: 'previous_day';
    /** Whether the process answering runs the schedule. Each server decides for itself. */
    schedulerActive: boolean;
    mailConfigured: boolean;
    recipientCount: number;
    /** Masked, e.g. `ow***@example.com`. Always the ADMIN_EMAILS list. */
    recipients: string[];
  };
  /** The next report the schedule will send; null while the email is switched off. */
  next: { reportDate: string; dueAt: string } | null;
  /** Newest report day first; one page at a time. */
  runs: Paginated<ReportRunRecord>;
};

/** `pending`: still sending when the request stopped waiting; the history settles it. */
export type ManualSendResult = { delivery: DeliveryStatus; run: ReportRunRecord };
