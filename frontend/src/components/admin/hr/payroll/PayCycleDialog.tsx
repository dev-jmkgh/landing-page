'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRestoreFocus, useStableClose } from '@/components/admin/ConfirmDialog';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { CYCLE_START_DAYS, cycleExample, describeCycle, ordinal, payrollApi } from '@/lib/hrPayroll';
import { todayIso } from '@/lib/telecalling';

/**
 * Sets the pay cycle: the day of the month every pay period starts on (1 to 28).
 *
 * A select, not a number box: there are 28 possible answers and a select cannot hold a
 * 29th. The example beneath it is worked out live with the server's own rule
 * (`payPeriodBounds`, mirrored in hrPayroll.ts) for the period running today, so the
 * administrator sees what "26" means — "October 2026 would be 26 Sep – 25 Oct 2026" —
 * before saving.
 *
 * Pay periods already opened keep the dates they were opened with (the server stores
 * them on the period); the dialog says so, because otherwise changing the cycle in the
 * middle of a period looks as if it would move that period.
 *
 * The same value is editable in Organisation → HR settings.
 */
export function PayCycleDialog({
  startDay,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  startDay: number;
  onClose: () => void;
  onSaved: (startDay: number) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useRestoreFocus(opener);

  // The IST date, read once when the dialog opens.
  const [today] = useState(todayIso);
  const [day, setDay] = useState(String(startDay));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const close = useStableClose(() => {
    if (!saving) onClose();
  });

  const chosen = Number(day);
  const unchanged = chosen === startDay;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || unchanged) return;

    setSaving(true);
    setError(null);
    setFieldError(null);

    try {
      onSaved(await payrollApi.setCycleStartDay(chosen));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      const fields = caught instanceof ApiError ? caught.fieldErrors : {};
      if (fields.payrollCycleStartDay) {
        setFieldError(fields.payrollCycleStartDay);
      } else {
        setError(
          fields.form ?? (caught instanceof ApiError ? caught.message : 'Could not save the pay cycle.'),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const selectId = `${uid}-day`;
  const describedBy = [fieldError ? `${uid}-error` : `${uid}-hint`, `${uid}-example`].join(' ');

  return (
    <Dialog
      open
      onClose={close}
      title="Pay cycle"
      className="tc-dialog hr-pay-dialog--narrow"
      dismissOnBackdrop={false}
    >
      <form className="hr-pay-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="tc-dialog__head">
          <p className="tc-dialog__eyebrow">Payroll</p>
          <h2 className="tc-dialog__title">Pay cycle</h2>
          <p className="tc-dialog__sub">The same dates for everyone: the day each pay period starts on.</p>
        </div>

        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <div className={`field${fieldError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={selectId}>
              Each pay period starts on the
            </label>
            <select
              id={selectId}
              className="select"
              value={day}
              disabled={saving}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => setDay(event.target.value)}
            >
              {CYCLE_START_DAYS.map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? '1st (calendar month)' : `${ordinal(value)} of the month`}
                </option>
              ))}
            </select>
            {fieldError ? (
              <p className="field__error" id={`${uid}-error`} role="alert">
                <Icon name="alert" size={14} />
                {fieldError}
              </p>
            ) : (
              <p className="field__hint" id={`${uid}-hint`}>
                {describeCycle(chosen)}. A pay period is named after the month it ends in.
              </p>
            )}
          </div>

          <p className="hr-pay-preview" id={`${uid}-example`} aria-live="polite">
            <Icon name="calendar" size={16} />
            <span>For example, {cycleExample(chosen, today)}.</span>
          </p>

          <p className="tc-dialog__note">
            Pay periods you have already opened keep their dates. The new cycle applies to the
            pay periods you open after saving.
          </p>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--outline" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving || unchanged}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : <Icon name="check" size={16} />}
            {saving ? 'Saving…' : 'Save pay cycle'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
