'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ButtonSpinner, Loader } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { formatDateTime } from '@/lib/telecalling';
import {
  HALF_DAY_LABELS,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUS_TONE,
  formatDayCount,
  formatDays,
  formatLeaveRange,
  leaveAdminApi,
  type LeaveBalance,
  type LeaveRequest,
} from '@/lib/hrLeave';
import { Tag } from '../../telecalling/shared';
import { HrDialog, isAbort, writeFailure } from './shared';

/**
 * One leave request: everything about it, and — while it is pending — the decision.
 *
 * The same dialog serves "View", "Approve" and "Reject" from the queue, opened on the
 * step that was asked for. A decision is always made with the request in front of the
 * administrator (dates, days, reason) and the employee's balance for that type, so an
 * approval that would overdraw is visible before the click rather than as a refusal
 * after it. The server re-checks the balance with the employee row locked either way.
 *
 * A note is optional for both decisions, but a rejection without one asks once more:
 * the note is the only explanation the employee gets in the app.
 */

const NOTE_MAX = 500;

export type LeaveDecisionIntent = 'view' | 'approve' | 'reject';

export function LeaveRequestDialog({
  request,
  intent,
  onClose,
  onDecided,
  onUnauthorized,
}: {
  request: LeaveRequest;
  intent: LeaveDecisionIntent;
  onClose: () => void;
  onDecided: (decided: LeaveRequest, message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [step, setStep] = useState<LeaveDecisionIntent>(
    request.status === 'pending' ? intent : 'view',
  );
  const [note, setNote] = useState('');
  const [confirmBlankReject, setConfirmBlankReject] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  /* The employee's balance for this type, in the year the leave starts. Advice only. */
  const year = Number(request.startDate.slice(0, 4));
  const [balance, setBalance] = useState<LeaveBalance | null | 'none'>(null);

  useEffect(() => {
    if (request.leaveType.kind !== 'leave') {
      setBalance('none');
      return undefined;
    }
    const controller = new AbortController();
    leaveAdminApi
      .allocations(request.userId, year, controller.signal)
      .then((result) =>
        setBalance(result.items.find((item) => item.leaveType.id === request.leaveType.id) ?? 'none'),
      )
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        // Without the balance the decision can still be made; the server checks it anyway.
        setBalance('none');
      });
    return () => controller.abort();
  }, [request.userId, request.leaveType.id, request.leaveType.kind, year]);

  useEffect(() => {
    if (step !== 'view') noteRef.current?.focus();
  }, [step]);

  const pending = request.status === 'pending';
  const trimmed = note.trim();

  const decide = async (decision: 'approve' | 'reject') => {
    if (trimmed.length > NOTE_MAX) {
      setError(`Keep the note to ${NOTE_MAX} characters or fewer.`);
      return;
    }
    if (decision === 'reject' && !trimmed && !confirmBlankReject) {
      setConfirmBlankReject(true);
      noteRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const decided =
        decision === 'approve'
          ? await leaveAdminApi.approve(request.id, trimmed)
          : await leaveAdminApi.reject(request.id, trimmed);
      onDecided(
        decided,
        decision === 'approve'
          ? `${request.employeeName}'s ${request.leaveType.name.toLowerCase()} (${formatLeaveRange(
              request.startDate,
              request.endDate,
            )}) is approved. They are notified in the HR app.`
          : `${request.employeeName}'s ${request.leaveType.name.toLowerCase()} request was rejected. They are notified in the HR app.`,
      );
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can approve or reject leave. You can see the request, but not decide it.',
        'That decision could not be saved.',
      );
      if (message !== null) setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  /*
   * What approving leaves, computed the way the server checks it: entitlement minus what
   * is already APPROVED minus this request. Other pending requests are not held against
   * an approval — they are checked when they are decided themselves.
   */
  const leftAfterApproval =
    pending && balance !== null && balance !== 'none' && balance.tracked && balance.entitled !== null
      ? Math.round((balance.entitled - balance.used - request.days) * 10) / 10
      : null;

  return (
    <HrDialog
      title={
        step === 'approve' ? 'Approve leave' : step === 'reject' ? 'Reject leave' : 'Leave request'
      }
      eyebrow={`Leave request #${request.id}`}
      sub={`${request.employeeName} · ${request.employeeCode}`}
      label={`Leave request from ${request.employeeName}`}
      onClose={onClose}
    >
      <div className="tc-dialog__body">
        {error ? <FormAlert variant="error">{error}</FormAlert> : null}

        <dl className="tc-facts">
          <dt>Employee</dt>
          <dd>
            <span>{request.employeeName}</span>
            <span className="tc-mono">{request.employeeCode}</span>
          </dd>

          <dt>Type</dt>
          <dd>
            <span>{request.leaveType.name}</span>
            <span className="tc-mono">{request.leaveType.code}</span>
            {request.leaveType.kind !== 'leave' ? (
              <Tag tone="progress">{LEAVE_KIND_LABELS[request.leaveType.kind]}</Tag>
            ) : null}
            {!request.leaveType.isPaid ? <Tag tone="warn">Unpaid</Tag> : null}
          </dd>

          <dt>Dates</dt>
          <dd>
            <span>{formatLeaveRange(request.startDate, request.endDate)}</span>
            {request.halfDay !== 'none' ? <Tag>{HALF_DAY_LABELS[request.halfDay]}</Tag> : null}
          </dd>

          <dt>Working days</dt>
          <dd>{formatDays(request.days)}</dd>

          <dt>Reason</dt>
          <dd>
            <span className="tc-prewrap">{request.reason}</span>
          </dd>

          <dt>Status</dt>
          <dd>
            <Tag tone={LEAVE_STATUS_TONE[request.status]}>{LEAVE_STATUS_LABELS[request.status]}</Tag>
          </dd>

          <dt>Applied</dt>
          <dd>{formatDateTime(request.createdAt)} IST</dd>

          {request.reviewedAt ? (
            <>
              <dt>{request.status === 'rejected' ? 'Rejected by' : 'Decided by'}</dt>
              <dd>
                <span>{request.reviewerName ?? 'Not recorded'}</span>
                {request.reviewerType === 'manager' ? <Tag>Team manager</Tag> : null}
                {request.reviewerType === 'admin' ? <Tag>Admin portal</Tag> : null}
                <span className="tc-muted">{formatDateTime(request.reviewedAt)} IST</span>
              </dd>
            </>
          ) : null}

          {request.reviewNote ? (
            <>
              <dt>Review note</dt>
              <dd>
                <span className="tc-prewrap">{request.reviewNote}</span>
              </dd>
            </>
          ) : null}

          {request.cancelledAt ? (
            <>
              <dt>Cancelled</dt>
              <dd>{formatDateTime(request.cancelledAt)} IST, by the employee</dd>
            </>
          ) : null}
        </dl>

        {request.leaveType.kind === 'leave' ? (
          <section className="tc-dialog__section" aria-labelledby={`${uid}-balance`}>
            <h3 className="tc-dialog__section-title" id={`${uid}-balance`}>
              {request.leaveType.name} balance, {year}
            </h3>
            {balance === null ? (
              <Loader inline size="sm" label="Loading the balance…" />
            ) : balance === 'none' ? (
              <p className="tc-dialog__note">The balance could not be shown for this type.</p>
            ) : !balance.tracked ? (
              <p className="tc-dialog__note">
                Not tracked — {request.leaveType.name} has no annual quota and no allocation for{' '}
                {request.employeeName}, so there is no balance to check against.{' '}
                {formatDays(balance.used)} used and {formatDays(balance.pending)} pending this year.
              </p>
            ) : (
              <>
                <div className="hrl-balance-strip">
                  <BalanceFigure label="Entitled" value={balance.entitled} />
                  <BalanceFigure label="Used" value={balance.used} />
                  <BalanceFigure label="Pending" value={balance.pending} />
                  <BalanceFigure
                    label="Available"
                    value={balance.available}
                    tone={balance.available !== null && balance.available < 0 ? 'bad' : undefined}
                  />
                </div>
                {leftAfterApproval !== null ? (
                  leftAfterApproval < 0 ? (
                    <p className="field__error" role="alert">
                      Approving this would go past the {request.leaveType.name.toLowerCase()}{' '}
                      entitlement by {formatDays(-leftAfterApproval)}, so it will be refused. Raise
                      the allocation on the Balances tab first, or reject it.
                    </p>
                  ) : (
                    <p className="tc-dialog__note">
                      After approving: {formatDays(leftAfterApproval)} left of{' '}
                      {formatDays(balance.entitled ?? 0)}, before any other pending requests.
                    </p>
                  )
                ) : null}
              </>
            )}
          </section>
        ) : null}

        {pending && step !== 'view' ? (
          <div className={`field${confirmBlankReject && !trimmed ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-note`}>
              {step === 'reject' ? 'Reason for rejecting (recommended)' : 'Note to the employee (optional)'}
            </label>
            <textarea
              ref={noteRef}
              id={`${uid}-note`}
              className="textarea tc-textarea--short"
              maxLength={NOTE_MAX}
              value={note}
              disabled={submitting}
              placeholder={
                step === 'reject'
                  ? 'e.g. The team is short that week — could you move it to the week after?'
                  : 'e.g. Enjoy the break.'
              }
              aria-describedby={`${uid}-note-hint`}
              onChange={(event) => {
                setNote(event.target.value);
                setConfirmBlankReject(false);
              }}
            />
            <p className="field__hint" id={`${uid}-note-hint`} aria-live="polite">
              {confirmBlankReject && !trimmed
                ? `${request.employeeName} will see "Rejected" with no explanation. Add a reason, or press "Reject without a note".`
                : `Shown to ${request.employeeName} in the HR app. ${NOTE_MAX - note.length} characters left.`}
            </p>
          </div>
        ) : null}
      </div>

      <div className="tc-dialog__foot">
        {pending ? (
          step === 'view' ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn--outline" onClick={() => setStep('reject')}>
                Reject…
              </button>
              <button type="button" className="btn btn--primary" onClick={() => setStep('approve')}>
                Approve…
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setStep('view');
                  setConfirmBlankReject(false);
                  setError(null);
                }}
                disabled={submitting}
              >
                Back
              </button>
              {step === 'approve' ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void decide('approve')}
                  disabled={submitting}
                  aria-busy={submitting || undefined}
                >
                  {submitting ? <ButtonSpinner /> : null}
                  Approve {formatDayCount(request.days)} {request.days <= 1 ? 'day' : 'days'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void decide('reject')}
                  disabled={submitting}
                  aria-busy={submitting || undefined}
                >
                  {submitting ? <ButtonSpinner /> : null}
                  {confirmBlankReject && !trimmed ? 'Reject without a note' : 'Reject request'}
                </button>
              )}
            </>
          )
        ) : (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </HrDialog>
  );
}

function BalanceFigure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: 'bad';
}) {
  return (
    <div className="hrl-balance-strip__item" data-tone={tone}>
      <span className="hrl-balance-strip__value">{value === null ? '—' : formatDayCount(value)}</span>
      <span className="hrl-balance-strip__label">{label}</span>
    </div>
  );
}
