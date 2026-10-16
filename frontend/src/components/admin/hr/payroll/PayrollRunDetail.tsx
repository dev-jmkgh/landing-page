'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ButtonSpinner, LoaderBlock } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  formatInr,
  formatPeriodRange,
  longCalendarDate,
  monthLabel,
  payrollApi,
  type PayrollRun,
} from '@/lib/hrPayroll';
import { formatDateTime, todayIso } from '@/lib/telecalling';
import { StatCard, StatGrid } from '../../telecalling/shared';
import { PayslipsTable } from './PayslipsTable';
import { ConfirmDialog, RunStatusTag, isAbort, plural, readFailure } from './shared';

/**
 * One payroll run: its totals, where it is in draft → processed → approved, the actions
 * that move it along, and its payslips.
 *
 * THE ORDER OF THINGS IS THE SERVER'S. A run may be processed only once its month is
 * over (`processableFrom`, the day after the period), any number of times until it is
 * approved, and approval freezes it and publishes the payslips. The buttons here mirror
 * that so the administrator sees what is possible before clicking, but the server is the
 * one that decides — every refusal it sends is shown as it wrote it.
 *
 * `formatDateTime` / `todayIso` come from the telecalling lib: they are IST formatters,
 * not telecalling vocabulary (the same reasoning as HrEmployeesPanel). "Today" is the
 * company's IST date, which is the date the server compares `processableFrom` against.
 */

type Confirming = 'approve' | 'delete' | 'reprocess';

export function PayrollRunDetail({
  runId,
  initialRun,
  initialNotice,
  onBack,
  onDeleted,
  onOpenStructures,
  onUnauthorized,
  onRestricted,
}: {
  runId: number;
  /** The row the list already had, shown at once while the fresh copy loads. */
  initialRun: PayrollRun | null;
  /** A message carried over from the step that opened this run ("created"). */
  initialNotice: string | null;
  onBack: () => void;
  onDeleted: (run: PayrollRun) => void;
  /** Opens Salary structures filtered to the employees who have none. */
  onOpenStructures: () => void;
  onUnauthorized: () => void;
  onRestricted: () => void;
}) {
  const [run, setRun] = useState<PayrollRun | null>(initialRun);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'process' | 'approve' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /**
   * How many employed people the last processing left out for want of a structure.
   * Only the process response carries it, so it is known for this visit only.
   */
  const [missingStructure, setMissingStructure] = useState<number | null>(null);
  const [slipsRefresh, setSlipsRefresh] = useState(0);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Opening a run moves focus to its heading, so a keyboard or screen-reader user lands
  // on what just opened rather than on a list that is no longer there.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setLoadError(null);

    try {
      setRun(await payrollApi.getRun(runId, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      setLoadError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load this payroll run.'));
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [runId, onUnauthorized, onRestricted]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const refresh = () => {
    setNotice(null);
    void load();
    setSlipsRefresh((value) => value + 1);
  };

  /**
   * A write's failure: the session, else the server's own sentence — and the run read
   * again, because the usual reason for a refusal is that the run moved on (another
   * administrator approved it, or deleted it) and the buttons on screen are out of date.
   */
  const writeFailed = (caught: unknown, fallback: string) => {
    if (caught instanceof ApiError && caught.status === 401) {
      onUnauthorized();
      return;
    }
    setActionError(caught instanceof ApiError ? caught.message : fallback);
    if (caught instanceof ApiError && caught.status !== 0) void load();
  };

  /* ------------------------------------------------------------------ actions */

  const process = async () => {
    if (!run) return;
    setBusy('process');
    setActionError(null);
    setNotice(null);

    try {
      const result = await payrollApi.processRun(run.id);
      setRun(result.run);
      setMissingStructure(result.missingStructure);
      setSlipsRefresh((value) => value + 1);
      setConfirming(null);
      setNotice(
        result.run.employeeCount > 0
          ? `${monthLabel(result.run.period)} processed: ${plural(result.run.employeeCount, 'payslip')}, net pay ${formatInr(result.run.totalNet)}. Nothing is published until you approve it.`
          : `${monthLabel(result.run.period)} processed, but nobody could be paid: no one employed in this period has a salary structure.`,
      );
    } catch (caught) {
      writeFailed(caught, 'Could not process this run.');
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!run) return;
    setBusy('approve');
    setActionError(null);
    setNotice(null);

    try {
      const result = await payrollApi.approveRun(run.id);
      setRun(result.run);
      setConfirming(null);
      setMissingStructure(null);
      setNotice(
        result.notified > 0
          ? `${monthLabel(result.run.period)} is approved. ${plural(result.notified, 'employee')} ${result.notified === 1 ? 'was' : 'were'} told their payslip is ready in the HR app.`
          : `${monthLabel(result.run.period)} is approved and its payslips are published in the HR app.`,
      );
      // The Approve button that opened the dialog is gone from an approved run.
      headingRef.current?.focus();
    } catch (caught) {
      writeFailed(caught, 'Could not approve this run.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!run) return;
    setBusy('delete');
    setActionError(null);

    try {
      await payrollApi.deleteRun(run.id);
      setConfirming(null);
      onDeleted(run);
    } catch (caught) {
      writeFailed(caught, 'Could not delete this run.');
      setBusy(null);
    }
  };

  const openConfirm = (which: Confirming) => {
    setActionError(null);
    setConfirming(which);
  };

  // A refusal shown inside the dialog belongs to it, and goes when it closes.
  const closeConfirm = () => {
    setConfirming(null);
    setActionError(null);
  };

  /* -------------------------------------------------------------------- view */

  const backButton = (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
      <Icon name="arrowLeft" size={15} />
      All payroll runs
    </button>
  );

  if (!run) {
    return (
      <>
        <div className="hr-pay-detail-nav">{backButton}</div>
        <h2 className="tc-section-title" ref={headingRef} tabIndex={-1}>
          Payroll run
        </h2>
        {loadError ? <FormAlert variant="error">{loadError}</FormAlert> : null}
        {loading ? <LoaderBlock label="Loading the payroll run…" /> : null}
      </>
    );
  }

  const label = monthLabel(run.period);
  const today = todayIso();
  const processable = today >= run.processableFrom;
  const editable = run.status !== 'approved';
  const hasPayslips = run.status !== 'draft' && run.employeeCount > 0;

  return (
    <>
      <div className="hr-pay-detail-nav">
        {backButton}
        <button type="button" className="btn btn--outline btn--sm" onClick={refresh} disabled={loading}>
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </div>

      <header className="hr-pay-run-head">
        <div className="hr-pay-run-head__title">
          <h2 className="hr-pay-run-head__heading" ref={headingRef} tabIndex={-1}>
            Payroll for {label}
          </h2>
          <RunStatusTag status={run.status} />
        </div>
        <p className="tc-muted hr-pay-run-head__sub">
          {formatPeriodRange(run.periodStart, run.periodEnd)}
          {run.note ? ` · ${run.note}` : ''}
        </p>
      </header>

      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}
      {actionError && confirming === null ? <FormAlert variant="error">{actionError}</FormAlert> : null}
      {loadError ? <FormAlert variant="error">{loadError}</FormAlert> : null}

      {missingStructure !== null && missingStructure > 0 ? (
        <div className="alert alert--info hr-pay-missing" role="status">
          <Icon className="alert__icon" name="info" size={18} />
          <div>
            <p>
              {missingStructure === 1
                ? '1 employed person has no salary structure and was left out of this run.'
                : `${missingStructure.toLocaleString('en-IN')} employed people have no salary structure and were left out of this run.`}{' '}
              Add their structures, then process the run again.
            </p>
            <button type="button" className="tc-text-button" onClick={onOpenStructures}>
              Open Salary structures
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {/* ----------------------------------------------------------- actions */}
      <div className="hr-pay-actions" role="group" aria-label={`Actions for ${label}`}>
        {editable ? (
          <button
            type="button"
            className={run.status === 'draft' ? 'btn btn--primary' : 'btn btn--outline'}
            disabled={!processable || busy !== null}
            aria-busy={busy === 'process' || undefined}
            aria-describedby={!processable ? 'hr-pay-process-hint' : undefined}
            onClick={() => (run.status === 'processed' ? openConfirm('reprocess') : void process())}
          >
            {busy === 'process' && confirming === null ? <ButtonSpinner /> : <Icon name="refresh" size={16} />}
            {run.status === 'processed' ? 'Process again' : 'Process payroll'}
          </button>
        ) : null}

        {run.status === 'processed' ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={run.employeeCount === 0 || busy !== null}
            aria-describedby={run.employeeCount === 0 ? 'hr-pay-approve-hint' : undefined}
            onClick={() => openConfirm('approve')}
          >
            <Icon name="check" size={16} />
            Approve
          </button>
        ) : null}

        {hasPayslips ? (
          /*
           * Built by the server — every payslip of the run, which this screen only ever
           * holds a page of. A new tab, like the lead import's CSV: the file downloads
           * and this run stays open.
           */
          <a
            className="btn btn--outline"
            href={payrollApi.runCsvUrl(run.id)}
            target="_blank"
            rel="noopener"
          >
            <Icon name="download" size={16} />
            Export CSV
          </a>
        ) : null}

        {editable ? (
          <button
            type="button"
            className="btn btn--ghost hr-pay-btn--danger-text"
            disabled={busy !== null}
            onClick={() => openConfirm('delete')}
          >
            Delete run
          </button>
        ) : null}
      </div>

      {editable && !processable ? (
        <p className="hr-pay-hint" id="hr-pay-process-hint">
          <Icon name="clock" size={15} />
          {label} can be processed from {longCalendarDate(run.processableFrom)}, once the month is
          over.
        </p>
      ) : null}
      {run.status === 'processed' && run.employeeCount === 0 ? (
        <p className="hr-pay-hint" id="hr-pay-approve-hint">
          <Icon name="info" size={15} />
          There are no payslips to approve. Add salary structures and process the run again.
        </p>
      ) : null}
      {run.status === 'approved' ? (
        <p className="hr-pay-hint">
          <Icon name="shield" size={15} />
          Approved runs are the record of what was paid: they cannot be processed again or
          deleted.
        </p>
      ) : null}

      {/* ------------------------------------------------------------ totals */}
      <h3 className="tc-section-title">Totals</h3>
      {run.status === 'draft' ? (
        <div className="tc-card hr-pay-empty-figures">
          <p>
            No figures yet. Processing computes every payslip from the month’s attendance,
            leave and salary structures, and totals them here.
          </p>
        </div>
      ) : (
        <div className="hr-pay-stats">
          <StatGrid>
            <StatCard value={run.employeeCount.toLocaleString('en-IN')} label="Employees paid" icon="users" />
            <StatCard value={formatInr(run.totalGross)} label="Gross earnings" icon="wallet" />
            <StatCard value={formatInr(run.totalDeductions)} label="Deductions" icon="ledger" />
            <StatCard value={formatInr(run.totalNet)} label="Net pay" icon="wallet" tone="good" />
          </StatGrid>
        </div>
      )}

      {/* ---------------------------------------------------------- timeline */}
      <h3 className="tc-section-title">Status</h3>
      <ol className="hr-pay-timeline tc-card">
        <TimelineStep state="done" title="Created" detail={formatDateTime(run.createdAt)} />
        <TimelineStep
          state={run.processedAt ? 'done' : 'next'}
          title="Processed"
          detail={
            run.processedAt
              ? formatDateTime(run.processedAt)
              : processable
                ? 'Ready to process'
                : `Can be processed from ${longCalendarDate(run.processableFrom)}`
          }
        />
        <TimelineStep
          state={run.approvedAt ? 'done' : run.status === 'processed' ? 'next' : 'todo'}
          title="Approved"
          detail={
            run.approvedAt
              ? `${formatDateTime(run.approvedAt)}${run.approvedByName ? ` · ${run.approvedByName}` : ''}`
              : 'Not yet. Approving publishes the payslips to employees and freezes the run.'
          }
        />
      </ol>

      {/* ---------------------------------------------------------- payslips */}
      {run.status === 'draft' ? null : (
        <PayslipsTable
          run={run}
          refreshToken={slipsRefresh}
          onUnauthorized={onUnauthorized}
          onRestricted={onRestricted}
        />
      )}

      {/* ----------------------------------------------------------- dialogs */}
      {confirming === 'approve' ? (
        <ConfirmDialog
          title={`Approve payroll for ${label}?`}
          confirmLabel="Approve and publish"
          busyLabel="Approving…"
          busy={busy === 'approve'}
          error={actionError}
          onConfirm={() => void approve()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            Approving publishes {plural(run.employeeCount, 'payslip')} to employees in the HR app
            and tells each of them it is ready. Net pay for the month is{' '}
            <strong>{formatInr(run.totalNet)}</strong>.
          </p>
          <p className="dialog__text">
            The run is then frozen: it can no longer be processed again or deleted.
          </p>
        </ConfirmDialog>
      ) : null}

      {confirming === 'reprocess' ? (
        <ConfirmDialog
          title={`Process ${label} again?`}
          confirmLabel="Process again"
          busyLabel="Processing…"
          busy={busy === 'process'}
          error={actionError}
          onConfirm={() => void process()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            Every payslip in this run is computed again from the current attendance, leave and
            salary structures, and replaces the figures shown now.
          </p>
          <p className="dialog__text tc-muted">Nothing is published until the run is approved.</p>
        </ConfirmDialog>
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title={`Delete the ${label} run?`}
          confirmLabel="Delete run"
          busyLabel="Deleting…"
          danger
          busy={busy === 'delete'}
          error={actionError}
          onConfirm={() => void remove()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            {run.status === 'processed' && run.employeeCount > 0
              ? `The run and its ${plural(run.employeeCount, 'payslip')} are removed. Employees have not seen them — payslips are only published on approval.`
              : 'The draft run is removed.'}
          </p>
          <p className="dialog__text tc-muted">You can create a run for {label} again later.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function TimelineStep({
  state,
  title,
  detail,
}: {
  state: 'done' | 'next' | 'todo';
  title: string;
  detail: string;
}) {
  return (
    <li className="hr-pay-timeline__step" data-state={state}>
      <span className="hr-pay-timeline__marker" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={13} strokeWidth={2.4} /> : null}
      </span>
      <span className="hr-pay-timeline__text">
        <span className="hr-pay-timeline__title">
          {title}
          <span className="sr-only">
            {state === 'done' ? ' (done)' : state === 'next' ? ' (next step)' : ' (not yet)'}
          </span>
        </span>
        <span className="hr-pay-timeline__detail">{detail}</span>
      </span>
    </li>
  );
}
