'use client';

import { useId, useRef, useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/telecalling';
import {
  formatDayCount,
  formatDays,
  isHalfStep,
  leaveAdminApi,
  type HrEmployeeOption,
  type LeaveBalance,
} from '@/lib/hrLeave';
import { HrDialog, writeFailure } from './shared';

/**
 * Sets one employee's entitlement for one leave type and year — a pro-rated joiner, a
 * carried-forward balance, a one-off grant.
 *
 * An override replaces the type's annual quota for that person and year; removing it
 * (`days: null`) puts the quota back. For an untracked type (no quota) an override is
 * what STARTS tracking it for this person — and removing it makes it untracked again,
 * which the dialog says in so many words, because the balance then disappears rather
 * than dropping to zero.
 */

const NOTE_MAX = 255;

export function AllocationDialog({
  employee,
  year,
  balance,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  employee: HrEmployeeOption;
  year: number;
  balance: LeaveBalance;
  onClose: () => void;
  onSaved: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const type = balance.leaveType;
  const quota = type.annualQuota;

  const [days, setDays] = useState(
    balance.allocation ? String(balance.allocation.days) : quota !== null ? String(quota) : '',
  );
  const [note, setNote] = useState(balance.allocation?.note ?? '');
  const [saving, setSaving] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const daysRef = useRef<HTMLInputElement | null>(null);

  const parsed = days.trim() === '' ? NaN : Number(days);
  const daysError =
    days.trim() === ''
      ? 'Enter the number of days.'
      : !Number.isFinite(parsed) || parsed < 0 || parsed > 365
        ? 'Use a number of days from 0 to 365.'
        : !isHalfStep(parsed)
          ? 'Use whole or half days, e.g. 7 or 7.5.'
          : null;

  const submit = async (reset: boolean) => {
    if (!reset && daysError) {
      setError(daysError);
      daysRef.current?.focus();
      return;
    }
    if (note.trim().length > NOTE_MAX) {
      setError(`Keep the note to ${NOTE_MAX} characters or fewer.`);
      return;
    }

    setSaving(reset ? 'reset' : 'save');
    setError(null);
    setFieldErrors({});

    try {
      const saved = await leaveAdminApi.setAllocation({
        userId: employee.id,
        leaveTypeId: type.id,
        year,
        days: reset ? null : parsed,
        note: reset ? null : note.trim() || null,
      });
      onSaved(
        reset
          ? saved.tracked
            ? `${employee.name}'s ${type.name} for ${year} is back to the type's quota of ${formatDays(
                saved.entitled ?? 0,
              )}.`
            : `${employee.name}'s ${type.name} for ${year} is no longer tracked — there is no quota for this type.`
          : `${employee.name} now has ${formatDays(parsed)} of ${type.name} for ${year}.`,
      );
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can change leave allocations.',
        'The allocation could not be saved.',
      );
      if (message === null) return;
      setError(message);
      if (caught instanceof ApiError) setFieldErrors(caught.fieldErrors);
    } finally {
      setSaving(null);
    }
  };

  const shownDaysError = fieldErrors.days ?? null;

  return (
    <HrDialog
      title={`${type.name}, ${year}`}
      eyebrow="Leave allocation"
      sub={`${employee.name} · ${employee.employeeCode}`}
      label={`${type.name} allocation for ${employee.name}, ${year}`}
      onClose={onClose}
      initialFocus={daysRef}
    >
      <div className="tc-dialog__body">
        {error ? <FormAlert variant="error">{error}</FormAlert> : null}

        <dl className="tc-facts">
          <dt>Type quota</dt>
          <dd>
            {quota !== null
              ? `${formatDays(quota)} a year`
              : 'No quota — untracked unless an allocation is set'}
          </dd>

          <dt>Now</dt>
          <dd>
            {balance.tracked && balance.entitled !== null
              ? `${formatDays(balance.entitled)} entitled · ${formatDayCount(balance.used)} used · ${formatDayCount(
                  balance.pending,
                )} pending`
              : `Not tracked · ${formatDayCount(balance.used)} used · ${formatDayCount(balance.pending)} pending`}
          </dd>

          <dt>Source</dt>
          <dd>
            {balance.allocation
              ? `Allocation for ${employee.name}${
                  balance.allocation.updatedAt ? `, set ${formatDateTime(balance.allocation.updatedAt)}` : ''
                }`
              : quota !== null
                ? 'The type quota'
                : 'None'}
          </dd>
        </dl>

        <div className="tc-form__grid">
          <div className={`field${shownDaysError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-days`}>
              Days for {year}
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              ref={daysRef}
              id={`${uid}-days`}
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              max={365}
              step={0.5}
              required
              value={days}
              disabled={saving !== null}
              aria-invalid={shownDaysError || (days !== '' && daysError) ? true : undefined}
              aria-describedby={`${uid}-days-hint`}
              onChange={(event) => setDays(event.target.value)}
            />
            <p className={shownDaysError ? 'field__error' : 'field__hint'} id={`${uid}-days-hint`}>
              {shownDaysError ??
                (days !== '' && daysError
                  ? daysError
                  : 'Whole or half days. Replaces the type quota for this person and year.')}
            </p>
          </div>

          <div className={`field${fieldErrors.note ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-note`}>
              Note (optional)
            </label>
            <input
              id={`${uid}-note`}
              className="input"
              maxLength={NOTE_MAX}
              value={note}
              disabled={saving !== null}
              placeholder="e.g. Pro-rated from the joining date"
              aria-describedby={`${uid}-note-hint`}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className={fieldErrors.note ? 'field__error' : 'field__hint'} id={`${uid}-note-hint`}>
              {fieldErrors.note ?? 'Kept with the allocation and in the audit log.'}
            </p>
          </div>
        </div>

        {!Number.isNaN(parsed) && !daysError && parsed < balance.used + balance.pending ? (
          <ul className="tc-advice" aria-label="Before you save">
            <li>
              {formatDays(parsed)} is less than the {formatDays(balance.used + balance.pending)}{' '}
              already used or pending. The balance will show as overdrawn, and pending requests
              that do not fit can no longer be approved.
            </li>
          </ul>
        ) : null}
      </div>

      <div className="tc-dialog__foot">
        {balance.allocation ? (
          <button
            type="button"
            className="btn btn--outline hrl-foot-start"
            onClick={() => void submit(true)}
            disabled={saving !== null}
            aria-busy={saving === 'reset' || undefined}
          >
            {saving === 'reset' ? <ButtonSpinner /> : null}
            {quota !== null ? `Reset to the quota (${formatDays(quota)})` : 'Remove the allocation'}
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving !== null}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void submit(false)}
          disabled={saving !== null}
          aria-busy={saving === 'save' || undefined}
        >
          {saving === 'save' ? <ButtonSpinner /> : null}
          Save allocation
        </button>
      </div>
    </HrDialog>
  );
}
