'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ButtonSpinner, LoaderBlock } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  canApprove,
  dayMonth,
  formatInr,
  formatPeriodRange,
  monthLabel,
  payrollApi,
  runStage,
  shortCalendarDate,
  type PayrollRun,
} from '@/lib/hrPayroll';
import { formatDateTime, todayIso } from '@/lib/telecalling';
import { StatCard, StatGrid } from '../../telecalling/shared';
import { NotIncludedCard } from './NotIncludedCard';
import { PayslipsTable } from './PayslipsTable';
import type { StructuresTarget } from './SalaryStructuresTab';
import { ConfirmDialog, RunStatusTag, isAbort, plural, readFailure } from './shared';

/**
 * One pay period: where it is, the actions that move it along, who it left out, its
 * totals and its payslips. (The API calls a pay period a payroll "run".)
 *
 * THE ORDER OF THINGS IS THE SERVER'S:
 *   - it may be CALCULATED from the day it starts (`processableFrom`), and again any
 *     number of times until it is approved. While it is still running the figures are
 *     PROVISIONAL — they stop at `calculatedThrough` (today), and the days after are
 *     neither paid nor loss of pay yet;
 *   - it may be APPROVED only once it has ended AND been calculated since
 *     (`!provisional && calculatedThrough >= periodEnd`, from `approvableFrom`), so no
 *     published payslip contains a guess. Approval freezes it and publishes the payslips.
 * The buttons mirror that so the administrator sees what is possible — and, when it is
 * not, why — before clicking; the server still decides, and every refusal it sends is
 * shown as it wrote it.
 *
 * `formatDateTime` / `todayIso` come from the telecalling lib: they are IST formatters,
 * not telecalling vocabulary (the same reasoning as HrEmployeesPanel). "Today" is the
 * company's IST date, which is the date the server compares against.
 */

type Confirming = 'approve' | 'delete' | 'recalculate';

/** Why Approve is not available on a calculated period, in one line. */
function approveBlockedReason(run: PayrollRun, today: string): string {
  if (today < run.approvableFrom) {
    return `You can approve once the period has ended: recalculate on or after ${shortCalendarDate(run.approvableFrom)}, then approve.`;
  }
  if (run.provisional || run.calculatedThrough === null || run.calculatedThrough < run.periodEnd) {
    return run.calculatedThrough
      ? `The figures stop at ${shortCalendarDate(run.calculatedThrough)}. Recalculate to count the whole period, then approve.`
      : 'Recalculate to count the whole period, then approve.';
  }
  return run.exclusions.length > 0
    ? 'There are no payslips to approve. Give the people under “Not included” a salary structure, then recalculate.'
    : 'There are no payslips to approve: nobody was employed during this period.';
}

/** What a calculation just did, said once, straight after it. */
function calculatedNotice(run: PayrollRun, missingStructure: number): string {
  const label = monthLabel(run.period);
  const leftOut =
    missingStructure > 0
      ? ` ${plural(missingStructure, 'person', 'people')} ${missingStructure === 1 ? 'was' : 'were'} left out — see “Not included”.`
      : '';

  if (run.employeeCount === 0) {
    return missingStructure > 0 || run.exclusions.length > 0
      ? `${label} calculated, but nobody could be included. “Not included” shows who was left out and why.`
      : `${label} calculated, but nobody was employed during this period.`;
  }
  if (run.provisional && run.calculatedThrough) {
    return `${label} calculated up to ${shortCalendarDate(run.calculatedThrough)}: ${plural(run.employeeCount, 'payslip')}, net pay so far ${formatInr(run.totalNet)}. Nothing is published until you approve.${leftOut}`;
  }
  return `${label} calculated for the whole period: ${plural(run.employeeCount, 'payslip')}, net pay ${formatInr(run.totalNet)}. Check the payslips, then approve to publish them.${leftOut}`;
}

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
  /** A message carried over from the step that opened this period ("opened"). */
  initialNotice: string | null;
  onBack: () => void;
  onDeleted: (run: PayrollRun) => void;
  /** Opens Salary structures — on one employee, from "Not included". */
  onOpenStructures: (target?: StructuresTarget) => void;
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
  const [slipsRefresh, setSlipsRefresh] = useState(0);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Opening a period moves focus to its heading, so a keyboard or screen-reader user
  // lands on what just opened rather than on a list that is no longer there.
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
      setLoadError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load this pay period.'));
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
   * A write's failure: the session, else the server's own sentence — and the period read
   * again, because the usual reason for a refusal is that it moved on (another
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
      setSlipsRefresh((value) => value + 1);
      setConfirming(null);
      setNotice(calculatedNotice(result.run, result.missingStructure));
    } catch (caught) {
      writeFailed(caught, 'Could not calculate the payslips.');
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
      setNotice(
        result.notified > 0
          ? `${monthLabel(result.run.period)} is approved. ${plural(result.notified, 'employee')} ${result.notified === 1 ? 'was' : 'were'} told their payslip is ready in the HR app.`
          : `${monthLabel(result.run.period)} is approved and its payslips are published in the HR app.`,
      );
      // The Approve button that opened the dialog is gone from an approved period.
      headingRef.current?.focus();
    } catch (caught) {
      writeFailed(caught, 'Could not approve this pay period.');
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
      writeFailed(caught, 'Could not delete this pay period.');
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
      All pay periods
    </button>
  );

  if (!run) {
    return (
      <>
        <div className="hr-pay-detail-nav">{backButton}</div>
        <h2 className="tc-section-title" ref={headingRef} tabIndex={-1}>
          Pay period
        </h2>
        {loadError ? <FormAlert variant="error">{loadError}</FormAlert> : null}
        {loading ? <LoaderBlock label="Loading the pay period…" /> : null}
      </>
    );
  }

  const label = monthLabel(run.period);
  const today = todayIso();
  const stage = runStage(run);
  /** Started: it may be calculated. */
  const started = today >= run.processableFrom;
  /** Ended: the day after its last day has come. */
  const ended = today >= run.approvableFrom;
  const editable = run.status !== 'approved';
  const approvable = canApprove(run, today);
  const soFar = stage === 'so_far';
  const finalDone = stage === 'ready' || stage === 'nobody' || stage === 'approved';
  const hasPayslips = run.status !== 'draft' && run.employeeCount > 0;
  const approveBlocked = run.status === 'processed' && !approvable ? approveBlockedReason(run, today) : null;
  /** The next step is to calculate (again): primary. Otherwise recalculating is a side action. */
  const calculateIsNext = run.status === 'draft' || (soFar && ended);

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
            {label} pay period
          </h2>
          <RunStatusTag run={run} />
        </div>
        <p className="tc-muted hr-pay-run-head__sub">
          {formatPeriodRange(run.periodStart, run.periodEnd)}
          {run.note ? ` · ${run.note}` : ''}
        </p>
      </header>

      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}
      {actionError && confirming === null ? <FormAlert variant="error">{actionError}</FormAlert> : null}
      {loadError ? <FormAlert variant="error">{loadError}</FormAlert> : null}

      {soFar && run.calculatedThrough ? (
        <div className="alert alert--info hr-pay-banner" role="status">
          <Icon className="alert__icon" name="clock" size={18} />
          <p>
            <strong>Figures so far</strong> — calculated up to {shortCalendarDate(run.calculatedThrough)}.{' '}
            {ended
              ? `This period ended on ${shortCalendarDate(run.periodEnd)}; days after the calculation are not counted yet. Recalculate now to count every day, then approve.`
              : `This period runs until ${shortCalendarDate(run.periodEnd)}; days after the calculation are not counted yet. Recalculate on or after ${shortCalendarDate(run.approvableFrom)} to approve.`}
          </p>
        </div>
      ) : null}

      {/* ----------------------------------------------------------- actions */}
      <div className="hr-pay-actions" role="group" aria-label={`Actions for the ${label} pay period`}>
        {editable ? (
          <button
            type="button"
            className={calculateIsNext ? 'btn btn--primary' : 'btn btn--outline'}
            disabled={!started || busy !== null}
            aria-busy={busy === 'process' || undefined}
            aria-describedby={!started ? 'hr-pay-process-hint' : undefined}
            onClick={() => (run.status === 'processed' ? openConfirm('recalculate') : void process())}
          >
            {busy === 'process' && confirming === null ? <ButtonSpinner /> : <Icon name="refresh" size={16} />}
            {run.status === 'processed' ? 'Recalculate' : 'Calculate payslips'}
          </button>
        ) : null}

        {run.status === 'processed' ? (
          <button
            type="button"
            className={approvable ? 'btn btn--primary' : 'btn btn--outline'}
            disabled={!approvable || busy !== null}
            aria-describedby={approveBlocked ? 'hr-pay-approve-hint' : undefined}
            onClick={() => openConfirm('approve')}
          >
            <Icon name="check" size={16} />
            Approve and publish payslips
          </button>
        ) : null}

        {hasPayslips ? (
          /*
           * Built by the server — every payslip of the period, which this screen only
           * ever holds a page of. A new tab, like the lead import's CSV: the file
           * downloads and this period stays open.
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
            Delete pay period
          </button>
        ) : null}
      </div>

      {editable && !started ? (
        <p className="hr-pay-hint" id="hr-pay-process-hint">
          <Icon name="clock" size={15} />
          This period starts on {shortCalendarDate(run.processableFrom)}; payslips can be calculated
          from then.
        </p>
      ) : null}
      {run.status === 'draft' && started ? (
        <p className="hr-pay-hint">
          <Icon name="info" size={15} />
          {ended
            ? 'This period has ended: calculate the payslips, check them, then approve.'
            : 'Calculate any time to see the figures so far. Nothing is published until you approve.'}
        </p>
      ) : null}
      {approveBlocked ? (
        <p className="hr-pay-hint" id="hr-pay-approve-hint">
          <Icon name="info" size={15} />
          {approveBlocked}
        </p>
      ) : null}
      {run.status === 'approved' ? (
        <p className="hr-pay-hint">
          <Icon name="shield" size={15} />
          Approved pay periods are the record of what was paid: they cannot be recalculated or
          deleted.
        </p>
      ) : null}

      {/* ------------------------------------------------------ not included */}
      {run.status !== 'draft' && run.exclusions.length > 0 ? (
        <NotIncludedCard
          key={run.processedAt ?? 'none'}
          run={run}
          onOpenEmployee={(person) =>
            onOpenStructures({
              // Back from that employee lands on everyone still without a structure.
              setUp: person.reason === 'no_structure' ? 'false' : 'all',
              employee: { userId: person.userId, employeeCode: person.employeeCode },
            })
          }
        />
      ) : null}

      {/* ------------------------------------------------------------ totals */}
      <h3 className="tc-section-title">Totals{soFar ? ' so far' : ''}</h3>
      {run.status === 'draft' ? (
        <div className="tc-card hr-pay-empty-figures">
          <p>
            No figures yet. Calculating works out every payslip from attendance, leave and salary
            structures, and totals them here.
          </p>
        </div>
      ) : (
        <div className="hr-pay-stats">
          <StatGrid>
            <StatCard
              value={run.employeeCount.toLocaleString('en-IN')}
              label={soFar ? 'Employees included' : 'Employees paid'}
              icon="users"
            />
            <StatCard value={formatInr(run.totalGross)} label={soFar ? 'Gross so far' : 'Gross earnings'} icon="wallet" />
            <StatCard value={formatInr(run.totalDeductions)} label="Deductions" icon="ledger" />
            <StatCard
              value={formatInr(run.totalNet)}
              label={soFar ? 'Net pay so far' : 'Net pay'}
              icon="wallet"
              tone="good"
            />
          </StatGrid>
          {soFar && run.calculatedThrough ? (
            <p className="hr-pay-hint">
              <Icon name="info" size={15} />
              Earnings cover the days up to {dayMonth(run.calculatedThrough)}; deductions are counted in
              full, so net pay grows as the period goes on.
            </p>
          ) : null}
        </div>
      )}

      {/* ---------------------------------------------------------- timeline */}
      <h3 className="tc-section-title">Progress</h3>
      <ol className="hr-pay-timeline tc-card">
        <TimelineStep state="done" title="Opened" detail={formatDateTime(run.createdAt)} />
        <TimelineStep
          state={run.processedAt ? 'done' : started ? 'next' : 'todo'}
          title="Calculated"
          detail={
            run.processedAt
              ? `${formatDateTime(run.processedAt)}${run.calculatedThrough ? ` · up to ${dayMonth(run.calculatedThrough)}` : ''}`
              : started
                ? 'Not yet. Calculate any time to see the figures so far.'
                : `From ${shortCalendarDate(run.processableFrom)}`
          }
        />
        <TimelineStep
          state={finalDone ? 'done' : ended && run.processedAt ? 'next' : 'todo'}
          title="Final calculation"
          detail={
            finalDone
              ? `Covers every day to ${shortCalendarDate(run.periodEnd)}`
              : !ended
                ? `On or after ${shortCalendarDate(run.approvableFrom)}, once the period has ended`
                : run.processedAt
                  ? `The period ended on ${shortCalendarDate(run.periodEnd)}. Recalculate to count every day.`
                  : 'The period has ended, so the first calculation covers every day.'
          }
        />
        <TimelineStep
          state={run.approvedAt ? 'done' : approvable ? 'next' : 'todo'}
          title="Approved · published"
          detail={
            run.approvedAt
              ? `${formatDateTime(run.approvedAt)}${run.approvedByName ? ` · ${run.approvedByName}` : ''}`
              : 'Not yet. Approving publishes the payslips to employees in the HR app and freezes the period.'
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
          title={`Approve and publish ${label}?`}
          confirmLabel="Approve and publish payslips"
          busyLabel="Approving…"
          busy={busy === 'approve'}
          error={actionError}
          onConfirm={() => void approve()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            Approving publishes {plural(run.employeeCount, 'payslip')} to employees in the HR app
            and tells each of them it is ready. Net pay for the period is{' '}
            <strong>{formatInr(run.totalNet)}</strong>.
          </p>
          <p className="dialog__text">
            The pay period is then frozen: it can no longer be recalculated or deleted.
          </p>
        </ConfirmDialog>
      ) : null}

      {confirming === 'recalculate' ? (
        <ConfirmDialog
          title={`Recalculate ${label}?`}
          confirmLabel="Recalculate"
          busyLabel="Calculating…"
          busy={busy === 'process'}
          error={actionError}
          onConfirm={() => void process()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            {ended
              ? 'Every payslip is worked out again from the attendance, leave and salary structures as they are now, covering every day of the period. The new figures replace the ones shown now.'
              : `Every payslip is worked out again up to today, ${shortCalendarDate(today)}, from the attendance, leave and salary structures as they are now. Days after today are not counted yet.`}
          </p>
          <p className="dialog__text tc-muted">Nothing is published until you approve.</p>
        </ConfirmDialog>
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title={`Delete the ${label} pay period?`}
          confirmLabel="Delete pay period"
          busyLabel="Deleting…"
          danger
          busy={busy === 'delete'}
          error={actionError}
          onConfirm={() => void remove()}
          onCancel={closeConfirm}
        >
          <p className="dialog__text">
            {run.status === 'processed' && run.employeeCount > 0
              ? `The pay period and its ${plural(run.employeeCount, 'payslip')} are removed. Employees have not seen them — payslips are only published on approval.`
              : 'The pay period is removed.'}
          </p>
          <p className="dialog__text tc-muted">
            You can open {label} again later; it will take its dates from the pay cycle as it is
            then.
          </p>
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
