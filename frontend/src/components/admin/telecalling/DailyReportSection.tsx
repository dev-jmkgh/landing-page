'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  daysAgoIso,
  formatDate,
  formatDateTime,
  isIsoDate,
  telecallingApi,
  todayIso,
  type DailyEmailDelivery,
  type DailyEmailStatus,
  type ReportRun,
  type ReportRunStatus,
} from '@/lib/telecalling';
import { EmptyPanel, Pager, StatGridSkeleton, TableSkeleton, Tag } from './shared';

/**
 * Settings → Daily report: the morning email that summarises the previous day.
 *
 * What is on, when it goes and to whom; a preview of exactly what would be sent; a way to
 * send a finished day by hand — to everyone, or as a test to the signed-in administrator
 * alone; and the history of every attempt, scheduled or manual.
 *
 * Administrator only, server-side: it shows where every employee's figures are sent. A
 * manager who opens the tab gets a sentence saying so rather than a broken screen.
 */

/** Runs per page of the history. The server allows up to 50. */
const RUNS_PAGE_SIZE = 10;

/** The oldest day the server will send by hand. Older ones can still be previewed. */
const SEND_LIMIT_DAYS = 366;

const RUN_STATUS: Record<ReportRunStatus, { label: string; tone: 'neutral' | 'progress' | 'good' | 'warn' | 'bad' }> = {
  sent: { label: 'Sent', tone: 'good' },
  partial: { label: 'Partly sent', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Not sent', tone: 'neutral' },
  claimed: { label: 'Starting', tone: 'progress' },
  sending: { label: 'Sending', tone: 'progress' },
};

/** A report's day, written like every other date in the admin. Noon IST, so no zone can move it. */
function reportDay(date: string): string {
  return formatDate(`${date}T12:00:00+05:30`);
}

function recipientsText(count: number): string {
  return count === 1 ? '1 recipient' : `${count} recipients`;
}

type Outcome = { variant: 'success' | 'error' | 'info'; message: string };

/** What a send did, in a sentence for the person who pressed the button. */
function describeDelivery(delivery: DailyEmailDelivery, run: ReportRun, toMe: boolean): Outcome {
  const day = reportDay(run.reportDate);

  switch (delivery) {
    case 'sent':
      return {
        variant: 'success',
        message: toMe
          ? `The report for ${day} was sent to you.`
          : `The report for ${day} was sent to ${run.deliveredCount} of ${recipientsText(run.recipientCount)}.`,
      };
    case 'partial':
      return {
        variant: 'error',
        message: `The report for ${day} reached ${run.deliveredCount} of ${recipientsText(run.recipientCount)}. ${run.error ?? 'The rest were refused.'}`,
      };
    case 'failed':
      return {
        variant: 'error',
        message: `The report for ${day} was not delivered. ${run.error ?? 'The email server refused it.'}`,
      };
    case 'skipped':
      return {
        variant: 'info',
        message: 'Email is not configured on the server, so nothing was sent. The attempt is in the history below.',
      };
    case 'pending':
      return {
        variant: 'info',
        message: `The report for ${day} is still being sent. Check the history in a minute.`,
      };
  }
}

export function DailyReportSection({
  onUnauthorized,
  page,
  onPageChange,
  onOpenSettings,
  refreshToken,
}: {
  onUnauthorized: () => void;
  /** The history page, kept in the address by the Settings panel. */
  page: number;
  onPageChange: (page: number) => void;
  /** Switches to the Settings tab, where the two report switches live. */
  onOpenSettings: () => void;
  /** Bumped by the panel's Refresh button. */
  refreshToken: number;
}) {
  const dateId = useId();

  /* ------------------------------------------------------------------ status */

  const [status, setStatus] = useState<DailyEmailStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const statusAbort = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    statusAbort.current?.abort();
    const controller = new AbortController();
    statusAbort.current = controller;

    setStatusLoading(true);
    setStatusError(null);

    try {
      setStatus(await telecallingApi.dailyEmailStatus({ page, pageSize: RUNS_PAGE_SIZE }, controller.signal));
      setForbidden(false);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && caught.status === 403) {
        setForbidden(true);
        return;
      }
      setStatusError(caught instanceof ApiError ? caught.message : 'Could not load the daily report settings.');
    } finally {
      if (statusAbort.current === controller) setStatusLoading(false);
    }
  }, [page, onUnauthorized]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, refreshToken]);

  // A page past the end — a hand-edited address, or a stale one — goes back to the first
  // page rather than claiming nothing was ever sent.
  useEffect(() => {
    if (status && status.runs.items.length === 0 && status.runs.total > 0 && page > 1) onPageChange(1);
  }, [status, page, onPageChange]);

  /* ----------------------------------------------------------------- preview */

  const [date, setDate] = useState(() => daysAgoIso(1));
  const [preview, setPreview] = useState<{ date: string; subject: string; html: string; partial: boolean } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);

  const today = todayIso();
  const oldestSendable = daysAgoIso(SEND_LIMIT_DAYS);
  const validDate = isIsoDate(date) && date <= today;
  const sendable = validDate && date < today && date >= oldestSendable;

  const loadPreview = async () => {
    if (!validDate) return;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const result = await telecallingApi.dailyEmailPreview(date, controller.signal);
      setPreview({
        date: result.report.reportDate,
        subject: result.email.subject,
        html: result.email.html,
        partial: result.report.partial,
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setPreviewError(caught instanceof ApiError ? caught.message : 'Could not build the preview.');
    } finally {
      if (previewAbort.current === controller) setPreviewLoading(false);
    }
  };

  useEffect(
    () => () => {
      statusAbort.current?.abort();
      previewAbort.current?.abort();
    },
    [],
  );

  /* -------------------------------------------------------------------- send */

  const [confirming, setConfirming] = useState<'everyone' | 'me' | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const send = async () => {
    if (!confirming || !sendable) return;
    const toMe = confirming === 'me';

    setSending(true);
    setOutcome(null);

    try {
      const result = await telecallingApi.sendDailyEmail(date, { toMe });
      setOutcome(describeDelivery(result.delivery, result.run, toMe));
      setConfirming(null);
      // The new run is the newest, at the top of the first page.
      if (page !== 1) onPageChange(1);
      else void loadStatus();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setConfirming(null);
      setOutcome({
        variant: 'error',
        message:
          caught instanceof ApiError && caught.status === 403
            ? 'Only an administrator can send the daily report.'
            : caught instanceof ApiError
              ? caught.message
              : 'Could not send the report.',
      });
    } finally {
      setSending(false);
    }
  };

  /* ------------------------------------------------------------------ render */

  if (forbidden) {
    return <FormAlert variant="error">Only an administrator can manage the daily report email.</FormAlert>;
  }

  if (!status) {
    if (statusLoading) {
      return (
        <>
          <StatGridSkeleton count={4} />
          <div style={{ marginTop: '1.25rem' }}>
            <TableSkeleton rows={4} />
          </div>
        </>
      );
    }

    return (
      <>
        {statusError ? <FormAlert variant="error">{statusError}</FormAlert> : null}
        <EmptyPanel
          title="Nothing to show"
          message="The daily report settings could not be loaded."
          actionLabel="Try again"
          onAction={() => void loadStatus()}
        />
      </>
    );
  }

  const { config, next, runs } = status;

  return (
    <div className="tc-report">
      {statusError ? <FormAlert variant="error">{statusError}</FormAlert> : null}

      {/* What would stop the report arriving, most serious first. */}
      {!config.mailConfigured ? (
        <FormAlert variant="error">
          Email is not configured on the server, so reports are recorded but not sent.
        </FormAlert>
      ) : null}
      {config.recipientCount === 0 ? (
        <FormAlert variant="error">No recipients are set up, so there is nobody to send the report to.</FormAlert>
      ) : null}
      {!config.enabled ? (
        <FormAlert variant="info">
          The daily email is off. Switch on <span className="tc-mono">report.daily_email_enabled</span> in the{' '}
          <button type="button" className="tc-alert-action" onClick={onOpenSettings}>
            Settings tab
          </button>{' '}
          to send it every morning.
        </FormAlert>
      ) : !config.schedulerActive ? (
        <FormAlert variant="info">
          Automatic sending is switched off on this server, so the report goes out only when someone sends it from
          here.
        </FormAlert>
      ) : null}

      <LoadingOverlay busy={statusLoading} label="Updating…">
        <div className="tc-card tc-report-meta">
          <div className="tc-report-meta__item">
            <span className="tc-report-meta__label">Daily email</span>
            <span className="tc-report-meta__value">
              <Tag tone={config.enabled ? 'good' : 'neutral'}>{config.enabled ? 'On' : 'Off'}</Tag>
            </span>
            <span className="tc-report-meta__hint">
              Change it in the{' '}
              <button type="button" className="tc-report-meta__action" onClick={onOpenSettings}>
                Settings tab
              </button>
              .
            </span>
          </div>

          <div className="tc-report-meta__item">
            <span className="tc-report-meta__label">Sends at</span>
            <span className="tc-report-meta__value">{config.sendAt} IST</span>
            <span className="tc-report-meta__hint">Covers the whole previous day.</span>
          </div>

          <div className="tc-report-meta__item">
            <span className="tc-report-meta__label">Next report</span>
            <span className="tc-report-meta__value">{next ? reportDay(next.reportDate) : 'Not scheduled'}</span>
            <span className="tc-report-meta__hint">
              {next ? `Due ${formatDateTime(next.dueAt)}` : 'Nothing is sent while the daily email is off.'}
            </span>
          </div>

          <div className="tc-report-meta__item">
            <span className="tc-report-meta__label">Recipients</span>
            <span className="tc-report-meta__value">{config.recipientCount}</span>
            <span className="tc-report-meta__hint">
              {config.recipients.length > 0 ? config.recipients.join(', ') : 'None'}
              {' · the administrators’ notification list (ADMIN_EMAILS)'}
            </span>
          </div>
        </div>
      </LoadingOverlay>

      {/* ------------------------------------------------------------- actions */}

      <section className="tc-card tc-report-actions" aria-labelledby={`${dateId}-heading`}>
        <h3 id={`${dateId}-heading`} className="tc-report-actions__title">
          Preview or send a day’s report
        </h3>

        <div className="tc-report-actions__row">
          <div className="field">
            <label className="field__label" htmlFor={dateId}>
              Day
            </label>
            <input
              id={dateId}
              type="date"
              className="input input--sm"
              value={date}
              max={today}
              onChange={(event) => {
                setDate(event.target.value);
                setOutcome(null);
              }}
            />
          </div>

          <div className="tc-report-actions__buttons">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={!validDate || previewLoading}
              aria-busy={previewLoading || undefined}
              onClick={() => void loadPreview()}
            >
              {previewLoading ? <ButtonSpinner /> : <Icon name="file" size={15} />}
              Preview
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!sendable || sending || config.recipientCount === 0}
              onClick={() => setConfirming('everyone')}
            >
              <Icon name="mail" size={15} />
              Send now
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={!sendable || sending}
              onClick={() => setConfirming('me')}
            >
              Send a test to me only
            </button>
          </div>
        </div>

        <p className="field__hint tc-report-actions__hint">
          {!isIsoDate(date)
            ? 'Choose a day.'
            : date > today
              ? 'That day has not started yet.'
              : date === today
                ? 'Today’s report can be previewed, but sent only once the day is over.'
                : date < oldestSendable
                  ? 'Reports more than a year old can be previewed but not sent.'
                  : 'Sending by hand does not replace the scheduled email for that day.'}
        </p>

        {outcome ? <FormAlert variant={outcome.variant}>{outcome.message}</FormAlert> : null}
        {previewError ? <FormAlert variant="error">{previewError}</FormAlert> : null}

        {preview ? (
          <LoadingOverlay busy={previewLoading} label="Building the preview…">
            <div className="tc-email-preview-wrap">
              <p className="tc-email-preview__subject">
                <span className="tc-muted">Subject</span> {preview.subject}
              </p>
              {preview.partial ? (
                <p className="tc-muted">The day is not over yet, so these are the figures so far.</p>
              ) : null}
              {/*
                srcDoc, not a URL: the API's own CSP forbids framing its responses. The
                empty sandbox runs no script and treats the email as a foreign origin, so
                even a report that somehow carried markup could do nothing here.
              */}
              <iframe
                className="tc-email-preview"
                sandbox=""
                srcDoc={preview.html}
                title={`Daily report email for ${reportDay(preview.date)}`}
              />
            </div>
          </LoadingOverlay>
        ) : previewLoading ? (
          <LoaderBlock label="Building the preview…" minHeight="20rem" />
        ) : null}
      </section>

      {/* ------------------------------------------------------------- history */}

      <h3 className="tc-section-title">History</h3>
      {runs.items.length === 0 ? (
        <EmptyPanel
          title="Nothing sent yet"
          message="Every scheduled or manual send is recorded here, with whether it arrived."
        />
      ) : (
        <LoadingOverlay busy={statusLoading} label="Updating…">
          <div>
            <DataTable
              rows={runs.items}
              rowKey={(run) => run.id}
              minWidth="48rem"
              caption="Daily report sends, newest first"
              columns={[
                {
                  key: 'date',
                  header: 'Report for',
                  width: '9rem',
                  nowrap: true,
                  render: (run) => reportDay(run.reportDate),
                },
                {
                  key: 'trigger',
                  header: 'Sent by',
                  width: '14rem',
                  render: (run) => (
                    <CellStack
                      primary={run.trigger === 'scheduled' ? 'Schedule' : 'By hand'}
                      // Stored with the run, so it reads correctly after the account is gone.
                      secondary={run.trigger === 'manual' ? run.requestedByLabel : null}
                    >
                      {/* A test went to its sender alone; "1/1 delivered" must not read as the team's copy. */}
                      {run.toMe ? <Tag>Test to sender only</Tag> : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '8rem',
                  render: (run) => <Tag tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Tag>,
                },
                {
                  key: 'delivered',
                  header: 'Delivered',
                  width: '6.5rem',
                  align: 'end',
                  render: (run) => `${run.deliveredCount}/${run.recipientCount}`,
                },
                {
                  key: 'attempts',
                  header: 'Attempts',
                  width: '6rem',
                  align: 'end',
                  render: (run) => run.attempts,
                },
                {
                  key: 'finished',
                  header: 'Finished',
                  width: '11rem',
                  nowrap: true,
                  render: (run) => formatDateTime(run.finishedAt),
                },
                {
                  key: 'note',
                  header: 'Note',
                  // A sentence the server wrote for people; raw errors stay in its log.
                  render: (run) => (run.error ? <span className="tc-muted">{run.error}</span> : null),
                },
              ]}
            />
            <Pager
              page={runs.page}
              totalPages={runs.totalPages}
              total={runs.total}
              noun="send"
              busy={statusLoading}
              onChange={onPageChange}
            />
          </div>
        </LoadingOverlay>
      )}

      <Dialog
        open={confirming !== null}
        onClose={() => {
          if (!sending) setConfirming(null);
        }}
        title={confirming === 'me' ? 'Send a test to yourself' : 'Send the daily report'}
        className="tc-confirm-dialog"
        dismissOnBackdrop={!sending}
      >
        <div className="dialog__body">
          <h2 className="dialog__title tc-confirm-dialog__title">
            {confirming === 'me' ? 'Send a test to yourself?' : 'Send the daily report now?'}
          </h2>
          <p className="dialog__text">
            {confirming === 'me'
              ? `The report for ${isIsoDate(date) ? reportDay(date) : 'this day'} goes only to the email address you sign in with. Nobody else receives it.`
              : `The report for ${isIsoDate(date) ? reportDay(date) : 'this day'} goes to ${recipientsText(config.recipientCount)}${config.recipients.length > 0 ? ` (${config.recipients.join(', ')})` : ''}.`}
          </p>
          <p className="dialog__text tc-muted">
            It is recorded in the history. The scheduled email for that day still goes out as usual.
          </p>
          <div className="tc-confirm-dialog__actions">
            <button
              type="button"
              className="btn btn--outline"
              disabled={sending}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={sending}
              aria-busy={sending || undefined}
              onClick={() => void send()}
            >
              {sending ? <ButtonSpinner /> : null}
              {sending ? 'Sending…' : confirming === 'me' ? 'Send to me' : 'Send now'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
