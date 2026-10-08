import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { config } from '../../../config/env';
import { withTransaction } from '../../../db/pool';
import { awaitDelivery, type DeliveryStatus } from '../../../services/deliveryStatus';
import {
  dailyTelecallingReportEmail,
  EMAIL_LOGO_CID,
  EMAIL_LOGO_PNG,
  formatReportDay,
  type EmailDocument,
} from '../../../services/email';
import {
  maskAddresses,
  sendToEach,
  type AdminNotificationInput,
  type FanOutResult,
} from '../../../services/mailer';
import { badRequest } from '../../../utils/httpError';
import { describeError, logger } from '../../../utils/logger';
import { actorLabel, type Actor } from '../actor';
import { recordAudit } from '../activity/activity.repository';
import {
  addDays,
  COMPANY_TIME_ZONE,
  companyDate,
  companyDayEnd,
  companyDayStart,
  companyInstant,
} from '../companyTime';
import {
  employeePerformance,
  leadBreakdown,
  overdueByEmployee,
} from '../dashboard/dashboard.repository';
import { countPendingRegistrations } from '../employees/employee.repository';
import { listLeadSources } from '../leads/lead.repository';
import {
  readBooleanSetting,
  readNumberSetting,
  readSetting,
} from '../settings/settings.repository';
import type { Pagination } from '../shared.schema';
import {
  closeAbandonedManualRuns,
  dailyCallTotals,
  dailyFollowUpTotals,
  dailyLeadTotals,
  databaseNow,
  findReportRun,
  findScheduledRun,
  finishRun,
  insertManualRunTx,
  insertScheduledClaim,
  listReportRuns,
  liveBacklog,
  lockRecentManualRunsTx,
  markRunInterrupted,
  markRunSending,
  reclaimRun,
  toReportRunRecord,
  type ReportWindow,
  type RunClaim,
  type RunFinish,
  type StoredReportRun,
} from './dailyReport.repository';
import {
  CATCH_UP_HOURS,
  DAILY_REPORT_TYPE,
  DEFAULT_SEND_TIME,
  LEASE_MINUTES,
  MANUAL_RESEND_GUARD_MINUTES,
  MANUAL_SEND_WAIT_MS,
  MAX_REPORT_AGE_DAYS,
  MAX_SCHEDULED_ATTEMPTS,
  RETRY_GAP_MINUTES,
  RETRYABLE_FAILURES,
  SEND_TIME_PATTERN,
  type DailyReport,
  type DailyReportStatus,
  type ManualSendResult,
  type ReportAudience,
  type ReportRunRecord,
  type ReportTrigger,
  type RunOutcome,
} from './dailyReport.schema';

/**
 * The daily telecalling report: what it says, when it is due, and sending it exactly
 * once.
 *
 * DELIVERY IS AT MOST ONCE. A scheduled day is one `report_runs` row, claimed by
 * inserting it (the unique key refuses a second) and leased. The owner moves it to
 * 'sending' — a compare-and-swap on its claim token — before it talks to the mail server,
 * and only then. From 'sending' a run can be finished by its owner or, if the owner died,
 * closed as interrupted; it is never sent again, because nobody can know whether the
 * first attempt arrived. A missing email can be sent by hand from the admin screen; a
 * duplicate cannot be unsent.
 *
 * Everything time-dependent reads one clock, injectable for tests: by default the
 * database's, so two servers with skewed clocks agree on what is due.
 */

/** Who holds a claim, for the diagnostics column only — never used to decide anything. */
const CLAIMED_BY = `${os.hostname()}:${process.pid}`.slice(0, 120);

const MINUTE_MS = 60_000;

/** The same shape `config/env.ts` accepts for a recipient. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                       */
/* -------------------------------------------------------------------------- */

/** Delivers one message per recipient and says how many the mail server accepted. */
export type ReportSender = (
  recipients: readonly string[],
  input: AdminNotificationInput,
) => Promise<FanOutResult>;

const sendThroughMailer: ReportSender = (recipients, input) =>
  sendToEach(recipients, input, 'Daily telecalling report');

/**
 * What a caller may replace — the e2e harness, which must never reach a real mail
 * server and must be able to stand at 08:01 on any day it likes.
 */
export type ReportRunOptions = {
  /** One fixed instant for every "now" in the call. Default: the database clock. */
  now?: Date;
  /** Default: one message per recipient through the configured transport. */
  send?: ReportSender;
  /**
   * Whether this process can deliver mail. Default: whether a transport is configured.
   * Decides only one thing — whether a day another server skipped (no mail there) is
   * picked up here.
   */
  mailConfigured?: boolean;
  /** Default: ADMIN_EMAILS. */
  recipients?: readonly string[];
};

type Clock = () => Promise<Date>;

function clockFor(now: Date | undefined): Clock {
  if (now) {
    const fixed = new Date(now.getTime());
    return async () => fixed;
  }
  return databaseNow;
}

/* -------------------------------------------------------------------------- */
/* Whether this process runs the schedule                                      */
/* -------------------------------------------------------------------------- */

let schedulerRunning = false;

/**
 * Set by the scheduler as it starts and stops. Kept here rather than read from the
 * configuration so the status screen reports what this process is actually doing — a
 * process can have the switch on and never have started the clock (a script, the test
 * harness).
 */
export function setDailyReportSchedulerRunning(running: boolean): void {
  schedulerRunning = running;
}

export function isDailyReportSchedulerRunning(): boolean {
  return schedulerRunning;
}

/* -------------------------------------------------------------------------- */
/* Settings and the schedule                                                   */
/* -------------------------------------------------------------------------- */

export type DailyReportSettings = { enabled: boolean; sendAt: string };

/**
 * Read on every tick, so a change on the Settings screen applies without a restart. The
 * claim is keyed by report date, not by time, so moving the send time after a day was
 * sent cannot send it again.
 */
export async function readDailyReportSettings(): Promise<DailyReportSettings> {
  const [enabled, time] = await Promise.all([
    readBooleanSetting('report.daily_email_enabled'),
    readSetting<unknown>('report.daily_email_time'),
  ]);

  // The settings screen refuses anything else; a hand-edited row falls back to the
  // default rather than stopping the report.
  const sendAt =
    typeof time === 'string' && SEND_TIME_PATTERN.test(time.trim()) ? time.trim() : DEFAULT_SEND_TIME;

  return { enabled, sendAt };
}

export type DueReport = { reportDate: string; dueAt: Date };

/**
 * The day whose report is due at `now`, if any.
 *
 * Day D's report is due at `sendAt` IST on D+1 and stays due for `catchUpHours`. Only the
 * two most recent days can qualify: the windows are 24 hours apart and 12 long, so at
 * most one is ever open, and looking two days back covers a late send time whose window
 * runs past midnight.
 */
export function dueScheduledDate(
  now: Date,
  sendAt: string,
  catchUpHours = CATCH_UP_HOURS,
): DueReport | null {
  const today = companyDate(now);

  for (const daysBack of [1, 2]) {
    const reportDate = addDays(today, -daysBack);
    const dueAt = companyInstant(addDays(reportDate, 1), sendAt);
    const closesAt = dueAt.getTime() + catchUpHours * 60 * MINUTE_MS;

    if (dueAt.getTime() <= now.getTime() && now.getTime() < closesAt) {
      return { reportDate, dueAt };
    }
  }

  return null;
}

/** The next send after `now`: yesterday's report later today, else today's tomorrow. */
export function nextScheduledRun(now: Date, sendAt: string): DueReport {
  const today = companyDate(now);
  const dueToday = companyInstant(today, sendAt);

  return now.getTime() < dueToday.getTime()
    ? { reportDate: addDays(today, -1), dueAt: dueToday }
    : { reportDate: today, dueAt: companyInstant(addDays(today, 1), sendAt) };
}

/**
 * What the schedule should do about a day that already has a run.
 *
 *   done       finished for good — sent, partly sent, or failed in a way not worth
 *              repeating (or repeated enough)
 *   busy       another process holds a live lease
 *   later      failed safely, and will be tried again after the retry gap
 *   reclaim    take it over: its owner died before sending, it failed safely and the gap
 *              has passed, or it was skipped for want of mail and this process has mail
 *   interrupt  its sender died mid-send; close it, never resend
 */
export type ScheduledDecision = 'done' | 'busy' | 'later' | 'reclaim' | 'interrupt';

export function decideScheduledRun(
  run: Pick<
    StoredReportRun,
    'status' | 'attempts' | 'failureReason' | 'leaseExpiresAt' | 'finishedAt' | 'claimedAt'
  >,
  now: Date,
  mailUsable: boolean,
): ScheduledDecision {
  switch (run.status) {
    case 'sent':
    case 'partial':
      // Someone received it. Sending again could only duplicate.
      return 'done';

    case 'skipped':
      // Nobody received anything, so a server that can send may still deliver it.
      return mailUsable && run.attempts < MAX_SCHEDULED_ATTEMPTS ? 'reclaim' : 'done';

    case 'failed': {
      if (
        run.failureReason === null ||
        !RETRYABLE_FAILURES.includes(run.failureReason) ||
        run.attempts >= MAX_SCHEDULED_ATTEMPTS
      ) {
        return 'done';
      }
      const failedAt = run.finishedAt ?? run.claimedAt;
      return now.getTime() - failedAt.getTime() >= RETRY_GAP_MINUTES * MINUTE_MS ? 'reclaim' : 'later';
    }

    case 'claimed':
      // A claimed run has not reached the mail server, so a dead owner is safe to replace.
      return run.leaseExpiresAt.getTime() < now.getTime() ? 'reclaim' : 'busy';

    case 'sending':
      return run.leaseExpiresAt.getTime() < now.getTime() ? 'interrupt' : 'busy';
  }
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** `hard_copy` → `Hard copy`, for a source no longer in the sources table. */
function humanise(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : slug;
}

/**
 * Builds the report for one IST day, as at `now`.
 *
 * Day figures cover exactly the instants of that day. The per-employee rows and the
 * source breakdown come from the dashboard's own queries, given the same instant window,
 * so the email and the screens share one definition of every figure — including that a
 * call counts only on the company line.
 */
export async function generateDailyReport(
  reportDate: string,
  options: { now?: Date } = {},
): Promise<DailyReport> {
  const now = options.now ?? (await databaseNow());
  const window: ReportWindow = { start: companyDayStart(reportDate), end: companyDayEnd(reportDate) };

  // The dashboard banner's threshold, so the email and the banner flag the same people.
  const alertHours = await readNumberSetting('followup.overdue_alert_hours', 24);

  const [calls, leads, followUps, backlog, pendingRegistrations, performance, bySource, sources, overdue] =
    await Promise.all([
      dailyCallTotals(window),
      dailyLeadTotals(window),
      dailyFollowUpTotals(window, now),
      liveBacklog(),
      countPendingRegistrations(),
      employeePerformance(window),
      leadBreakdown('source', window),
      listLeadSources(false),
      overdueByEmployee(alertHours, now),
    ]);

  const labels = new Map(sources.map((source) => [source.slug, source.label]));

  /*
   * Active telecallers always — a quiet day must be visible, not absent — and anyone else
   * only when they did something that day: a deactivated employee's empty row, or a
   * manager who made no calls, is noise.
   */
  const employees = performance
    .filter(
      (row) =>
        (row.isActive && row.role === 'telecaller') ||
        row.calls > 0 ||
        row.followUpsCompleted > 0 ||
        row.leadsConverted > 0,
    )
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    reportDate,
    partial: now.getTime() < window.end.getTime(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      timeZone: COMPANY_TIME_ZONE,
    },
    generatedAt: now.toISOString(),
    calls: {
      total: calls.total,
      answered: calls.answered,
      notAnswered: calls.notAnswered,
      outgoing: calls.outgoing,
      incoming: calls.incoming,
      incomingMissed: calls.incomingMissed,
      talkTimeSeconds: calls.talkTimeSeconds,
      // Over answered calls only: unanswered calls have no talk time to average.
      averageAnsweredSeconds:
        calls.answered > 0 ? Math.round(calls.talkTimeSeconds / calls.answered) : 0,
      answerRate: calls.total > 0 ? Math.round((calls.answered / calls.total) * 100) : 0,
    },
    leads: {
      created: leads.created,
      contacted: calls.leadsContacted,
      attempted: calls.leadsAttempted,
      converted: leads.converted,
      bySource: bySource.map((row) => ({
        key: row.key,
        label: labels.get(row.key) ?? humanise(row.key),
        total: row.total,
        converted: row.converted,
        conversionRate: row.conversionRate,
      })),
    },
    followUps,
    backlog: {
      unassignedLeads: backlog.unassignedLeads,
      pendingCallbacks: backlog.pendingCallbacks,
      pendingRegistrations,
      activeEmployees: backlog.activeEmployees,
      openLeads: backlog.openLeads,
    },
    employees,
    overdueAlertHours: alertHours,
    overdueByEmployee: overdue,
  };
}

/** The admin dashboard, absolute — the static export serves it with a trailing slash. */
function dashboardUrl(): string {
  return `${config.appUrl}/admin/telecalling/?section=dashboard`;
}

export function renderDailyReportEmail(report: DailyReport): EmailDocument {
  return dailyTelecallingReportEmail(report, { dashboardUrl: dashboardUrl() });
}

/**
 * The email's HTML with the logo inlined as a data URI.
 *
 * A real send attaches the logo as a Content-ID part (`mailer.ts`), which a browser cannot
 * resolve — so the preview, rendered in a sandboxed iframe on the admin screen, swaps the
 * reference for the bytes. The email itself is unchanged.
 */
function inlineLogo(html: string): string {
  return html
    .split(`cid:${EMAIL_LOGO_CID}`)
    .join(`data:image/png;base64,${EMAIL_LOGO_PNG.toString('base64')}`);
}

/* -------------------------------------------------------------------------- */
/* Running a claimed run                                                       */
/* -------------------------------------------------------------------------- */

/*
 * What the history screen shows for each way a run can end. Our own sentences — raw
 * driver and mail-server text goes to the log only.
 */
const RUN_ERRORS = {
  generation: 'The figures could not be read, so nothing was sent.',
  noRecipients: 'No recipient is set up for the daily report, so nothing was sent.',
  notConfigured: 'Email is not set up on the server, so nothing was sent.',
  rejected: 'The email server refused the message for every recipient.',
  interrupted:
    'Sending was interrupted. It may or may not have been delivered, so it was not sent again.',
  abandoned: 'The send was cut off before it reached the email server, so nothing was sent.',
} as const;

type RunTicket = {
  id: number;
  token: string;
  reportDate: string;
  trigger: ReportTrigger;
  audience: ReportAudience;
};

async function currentRun(id: number): Promise<ReportRunRecord> {
  const run = await findReportRun(id);
  if (!run) throw new Error(`Report run ${id} disappeared while it was being sent.`);
  return toReportRunRecord(run);
}

/** Maps what the mail server accepted onto how the run ended. */
function classifyDelivery(
  delivery: FanOutResult,
  attempted: number,
): Omit<RunFinish, 'finishedAt'> {
  const delivered = Math.min(Math.max(Math.trunc(delivery.delivered), 0), attempted);
  const base = { recipientCount: attempted, deliveredCount: delivered };

  if (delivery.result === 'skipped') {
    return {
      ...base,
      status: 'skipped',
      deliveredCount: 0,
      failureReason: 'mail_not_configured',
      error: RUN_ERRORS.notConfigured,
    };
  }
  if (attempted > 0 && delivered >= attempted) {
    return { ...base, status: 'sent', failureReason: null, error: null };
  }
  if (delivered > 0) {
    return {
      ...base,
      status: 'partial',
      failureReason: null,
      error: `Delivered to ${delivered} of ${attempted} recipients; the email server refused the rest.`,
    };
  }
  return { ...base, status: 'failed', failureReason: 'mail_rejected', error: RUN_ERRORS.rejected };
}

/**
 * Generates, renders and sends a run this process has just claimed, and records how it
 * ended. Returns the run as it now stands.
 *
 * The mail server is contacted only after `markRunSending` succeeds — the point of no
 * return. A claim lost before that (another server took the run over) ends here, with
 * nothing sent.
 */
async function executeRun(
  ticket: RunTicket,
  recipients: readonly string[],
  clock: Clock,
  send: ReportSender,
): Promise<ReportRunRecord> {
  const context = { runId: ticket.id, reportDate: ticket.reportDate, trigger: ticket.trigger };
  const finish = async (outcome: Omit<RunFinish, 'finishedAt'>) => {
    const applied = await finishRun(ticket.id, ticket.token, { ...outcome, finishedAt: await clock() });
    if (!applied) {
      logger.warn('Daily telecalling report outcome not recorded: the run changed hands', context);
    }
  };

  if (recipients.length === 0) {
    logger.error('Daily telecalling report not sent: no recipients are configured', {
      ...context,
      hint: 'Set ADMIN_EMAILS in the backend .env file.',
    });
    await finish({
      status: 'failed',
      recipientCount: 0,
      deliveredCount: 0,
      failureReason: 'no_recipients',
      error: RUN_ERRORS.noRecipients,
    });
    return currentRun(ticket.id);
  }

  let report: DailyReport;
  let document: EmailDocument;
  try {
    report = await generateDailyReport(ticket.reportDate, { now: await clock() });
    document = renderDailyReportEmail(report);
  } catch (error) {
    logger.error('Daily telecalling report could not be generated', {
      ...context,
      ...describeError(error),
    });
    await finish({
      status: 'failed',
      recipientCount: recipients.length,
      deliveredCount: 0,
      failureReason: 'generation_failed',
      error: RUN_ERRORS.generation,
    });
    return currentRun(ticket.id);
  }

  const sending = await markRunSending(
    ticket.id,
    ticket.token,
    addMinutes(await clock(), LEASE_MINUTES),
    recipients.length,
    JSON.stringify({ audience: ticket.audience, report }),
  );
  if (!sending) {
    logger.warn('Daily telecalling report not sent here: another server took the run over', context);
    return currentRun(ticket.id);
  }

  let delivery: FanOutResult;
  try {
    delivery = await send(recipients, {
      type: 'telecalling-daily-report',
      subject: document.subject,
      html: document.html,
      text: document.text,
    });
  } catch (error) {
    // The mailer never throws; a sender that did may have sent some of it. At most once.
    logger.error('Daily telecalling report stopped while sending', {
      ...context,
      ...describeError(error),
    });
    await finish({
      status: 'failed',
      recipientCount: recipients.length,
      deliveredCount: 0,
      failureReason: 'interrupted',
      error: RUN_ERRORS.interrupted,
    });
    return currentRun(ticket.id);
  }

  const outcome = classifyDelivery(delivery, recipients.length);
  await finish(outcome);

  const detail = {
    ...context,
    status: outcome.status,
    delivered: outcome.deliveredCount,
    recipients: recipients.length,
    to: maskAddresses(recipients),
  };
  if (outcome.status === 'sent') logger.info('Daily telecalling report sent', detail);
  else if (outcome.status === 'failed') logger.error('Daily telecalling report failed', detail);
  else logger.warn('Daily telecalling report not fully delivered', detail);

  return currentRun(ticket.id);
}

/* -------------------------------------------------------------------------- */
/* The schedule                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One tick of the schedule: sends the due day's report if no process has, and otherwise
 * says why not. Safe to call from any number of processes at once.
 */
export async function runDueDailyReport(options: ReportRunOptions = {}): Promise<RunOutcome> {
  const clock = clockFor(options.now);
  const now = await clock();

  const settings = await readDailyReportSettings();
  if (!settings.enabled) return { kind: 'disabled' };

  const due = dueScheduledDate(now, settings.sendAt);
  if (!due) return { kind: 'not_due' };

  const { reportDate } = due;
  const recipients = options.recipients ?? config.telecallingReport.recipients;
  const mailUsable = (options.mailConfigured ?? config.smtp.enabled) && recipients.length > 0;
  const send = options.send ?? sendThroughMailer;

  const claim: RunClaim = {
    token: randomUUID(),
    claimedBy: CLAIMED_BY,
    claimedAt: now,
    leaseUntil: addMinutes(now, LEASE_MINUTES),
  };
  const ticket: RunTicket = {
    id: 0,
    token: claim.token,
    reportDate,
    trigger: 'scheduled',
    audience: 'recipients',
  };

  const existing = await findScheduledRun(DAILY_REPORT_TYPE, reportDate);

  if (!existing) {
    const id = await insertScheduledClaim(DAILY_REPORT_TYPE, reportDate, claim);
    if (id === null) return { kind: 'in_progress', reportDate };
    return { kind: 'ran', run: await executeRun({ ...ticket, id }, recipients, clock, send) };
  }

  switch (decideScheduledRun(existing, now, mailUsable)) {
    case 'done':
      return { kind: 'already_done', reportDate, run: toReportRunRecord(existing) };

    case 'busy':
      return { kind: 'in_progress', reportDate };

    case 'later':
      return { kind: 'retry_later', reportDate, run: toReportRunRecord(existing) };

    case 'interrupt': {
      const closed = await markRunInterrupted(existing.id, existing.claimToken, now, RUN_ERRORS.interrupted);
      if (!closed) return { kind: 'in_progress', reportDate };

      logger.error('Daily telecalling report was interrupted while sending and will not be resent', {
        runId: existing.id,
        reportDate,
        attempts: existing.attempts,
        hint: 'It may have arrived. If it did not, send it by hand from Settings > Daily report.',
      });
      return { kind: 'interrupted', reportDate, run: await currentRun(existing.id) };
    }

    case 'reclaim': {
      const taken = await reclaimRun(
        existing.id,
        { status: existing.status, token: existing.claimToken },
        claim,
      );
      if (!taken) return { kind: 'in_progress', reportDate };
      return {
        kind: 'ran',
        run: await executeRun({ ...ticket, id: existing.id }, recipients, clock, send),
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* By hand                                                                     */
/* -------------------------------------------------------------------------- */

function deliveryOf(run: ReportRunRecord): DeliveryStatus {
  switch (run.status) {
    case 'sent':
    case 'partial':
    case 'failed':
    case 'skipped':
      return run.status;
    default:
      return 'pending';
  }
}

/**
 * Sends a finished day's report now, from the admin screen.
 *
 * Independent of the schedule: it is its own run, so it neither stands in for nor blocks
 * the scheduled email for that day. With `toMe` it goes only to the requesting
 * administrator — a test that reaches nobody else — and is still recorded and audited.
 *
 * Waits up to 20 seconds for the mail server; past that the answer is 'pending' and the
 * send finishes in the background, settling its run row.
 */
export async function sendDailyReportNow(
  input: { date?: string; toMe?: boolean },
  actor: Actor,
  options: ReportRunOptions & { ipAddress?: string | null; waitMs?: number } = {},
): Promise<ManualSendResult> {
  const clock = clockFor(options.now);
  const now = await clock();
  const today = companyDate(now);
  const reportDate = input.date ?? addDays(today, -1);
  const toMe = input.toMe === true;

  if (reportDate >= today) {
    throw badRequest("Choose a day that has finished. Today's figures can be previewed but not sent.");
  }
  if (reportDate < addDays(today, -MAX_REPORT_AGE_DAYS)) {
    throw badRequest('Choose a day within the last year. Older days can still be previewed.');
  }

  let recipients: readonly string[];
  if (toMe) {
    const address = actor.email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      throw badRequest('Your account has no email address to send a test to.');
    }
    recipients = [address];
  } else {
    recipients = options.recipients ?? config.telecallingReport.recipients;
  }

  const audience: ReportAudience = toMe ? 'requester' : 'recipients';
  const day = formatReportDay(reportDate);
  const claim: RunClaim = {
    token: randomUUID(),
    claimedBy: CLAIMED_BY,
    claimedAt: now,
    leaseUntil: addMinutes(now, LEASE_MINUTES),
  };

  /*
   * The resend guard and the insert share a transaction holding row locks on the day's
   * runs (see `lockRecentManualRunsTx`), so two sends racing for the same day cannot both
   * pass the check. A test to oneself and a send to everyone are different audiences and
   * do not block each other — testing first and then sending is the expected order.
   */
  const runId = await withTransaction(async (connection) => {
    const recent = await lockRecentManualRunsTx(
      connection,
      DAILY_REPORT_TYPE,
      reportDate,
      addMinutes(now, -MANUAL_RESEND_GUARD_MINUTES),
    );

    const clash = recent.some((run) =>
      toMe ? run.audience === 'requester' && run.requestedBy === actor.id : run.audience === 'recipients',
    );
    if (clash) {
      throw badRequest(
        toMe
          ? `A test of the report for ${day} was sent to you a moment ago. Wait a few minutes before sending another.`
          : `The report for ${day} was sent a moment ago. Wait a few minutes before sending it again.`,
      );
    }

    return insertManualRunTx(connection, {
      reportType: DAILY_REPORT_TYPE,
      reportDate,
      audience,
      claim,
      requestedBy: actor.id,
      requestedByLabel: actorLabel(actor),
    });
  });

  const work = executeRun(
    { id: runId, token: claim.token, reportDate, trigger: 'manual', audience },
    recipients,
    clock,
    options.send ?? sendThroughMailer,
  );
  // A failure after the request has stopped waiting is logged, never left unhandled.
  work.catch((error: unknown) =>
    logger.error('Daily telecalling report send failed in the background', {
      runId,
      reportDate,
      ...describeError(error),
    }),
  );

  const settled = await awaitDelivery(work, options.waitMs ?? MANUAL_SEND_WAIT_MS);
  const run = settled === 'timeout' ? await currentRun(runId) : settled;
  const delivery = deliveryOf(run);

  await recordAudit({
    actor,
    action: 'daily_report_sent_manually',
    entityType: 'report_run',
    entityId: runId,
    summary: toMe
      ? `Sent a test of the daily telecalling report for ${reportDate} to their own address (${delivery})`
      : `Sent the daily telecalling report for ${reportDate} (${delivery})`,
    meta: {
      reportDate,
      toMe,
      status: run.status,
      delivery,
      delivered: run.deliveredCount,
      recipients: run.recipientCount,
    },
    ipAddress: options.ipAddress ?? null,
  });

  return { delivery, run };
}

/* -------------------------------------------------------------------------- */
/* Preview and status                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The report and its email for a day, without sending or recording anything. Left out,
 * the day is yesterday; today is allowed and comes back `partial`.
 */
export async function previewDailyReport(
  date: string | undefined,
  options: { now?: Date } = {},
): Promise<{ report: DailyReport; email: EmailDocument }> {
  const now = options.now ?? (await databaseNow());
  const today = companyDate(now);
  const reportDate = date ?? addDays(today, -1);

  if (reportDate > today) throw badRequest('That day has not started yet.');

  const report = await generateDailyReport(reportDate, { now });
  const email = renderDailyReportEmail(report);

  return { report, email: { ...email, html: inlineLogo(email.html) } };
}

/**
 * The next report the schedule will send. A day that is due now and has no run yet is
 * still to come — within minutes on a server running the schedule — so it is shown
 * rather than skipped over to tomorrow's.
 */
async function upcomingRun(now: Date, sendAt: string): Promise<{ reportDate: string; dueAt: string }> {
  const due = dueScheduledDate(now, sendAt);
  if (due && !(await findScheduledRun(DAILY_REPORT_TYPE, due.reportDate))) {
    return { reportDate: due.reportDate, dueAt: due.dueAt.toISOString() };
  }

  const next = nextScheduledRun(now, sendAt);
  return { reportDate: next.reportDate, dueAt: next.dueAt.toISOString() };
}

/** Settings, delivery configuration (recipients masked), the next run, and one page of history. */
export async function dailyReportStatus(
  pagination: Pagination,
  options: { now?: Date } = {},
): Promise<DailyReportStatus> {
  const now = options.now ?? (await databaseNow());

  // Settle any "Send now" a restart cut off before showing the history, or it would read
  // as still in progress for ever (a manual run has no scheduler tick to settle it).
  await closeAbandonedManualRuns(DAILY_REPORT_TYPE, now, {
    interrupted: RUN_ERRORS.interrupted,
    abandoned: RUN_ERRORS.abandoned,
  });

  const [settings, runs] = await Promise.all([
    readDailyReportSettings(),
    listReportRuns(DAILY_REPORT_TYPE, pagination),
  ]);
  const recipients = config.telecallingReport.recipients;

  return {
    config: {
      enabled: settings.enabled,
      sendAt: settings.sendAt,
      timeZone: COMPANY_TIME_ZONE,
      covers: 'previous_day',
      schedulerActive: isDailyReportSchedulerRunning(),
      mailConfigured: config.smtp.enabled,
      recipientCount: recipients.length,
      recipients: maskAddresses(recipients),
    },
    next: settings.enabled ? await upcomingRun(now, settings.sendAt) : null,
    runs,
  };
}
