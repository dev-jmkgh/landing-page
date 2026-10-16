'use client';

import { useId, useState, type FormEvent } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { MONTH_NAMES, RUN_NOTE_LENGTH, monthLabel, payrollApi, type PayrollRun } from '@/lib/hrPayroll';
import { todayIso } from '@/lib/telecalling';
import { useRestoreFocus } from './shared';

/**
 * Starts a payroll run for one month, as a draft.
 *
 * MONTH AND YEAR ARE TWO SELECTS, not `<input type="month">`. Firefox and Safari render a
 * month input as a bare text box, which would leave half the administrators typing
 * "2026-09" by hand; two selects work the same everywhere and cannot hold an impossible
 * month.
 *
 * The default is LAST month — the run an administrator usually creates, since a month
 * can only be processed once it is over. The current month is allowed (a draft can be
 * prepared early); a future one is refused by the server, and its sentence is shown here
 * rather than re-implemented.
 */
export function NewRunDialog({
  onClose,
  onCreated,
  onUnauthorized,
}: {
  onClose: () => void;
  onCreated: (run: PayrollRun) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useRestoreFocus(opener);

  // Read once, when the dialog opens: the IST date, which is the server's calendar.
  const [defaults] = useState(() => {
    const [year, month] = todayIso().split('-').map(Number) as [number, number];
    const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    return { currentYear: year, ...previous };
  });

  const [month, setMonth] = useState(String(defaults.month).padStart(2, '0'));
  const [year, setYear] = useState(String(defaults.year));
  const [note, setNote] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // This year and the ten before it. The server accepts any month from 2000 onwards,
  // but a run for a month more than a decade old is not something anyone creates here.
  const years = Array.from({ length: 11 }, (_, index) => defaults.currentYear - index);

  const period = `${year}-${month}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const run = await payrollApi.createRun({ period, note: note.trim() || null });
      onCreated(run);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && Object.keys(caught.fieldErrors).length > 0) {
        setFieldErrors(caught.fieldErrors);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not create the payroll run.');
      }
    } finally {
      setSaving(false);
    }
  };

  const periodError = fieldErrors.period;
  const noteError = fieldErrors.note;

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="New payroll run"
      className="tc-dialog hr-pay-dialog--narrow"
      dismissOnBackdrop={false}
    >
      <form className="hr-pay-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="tc-dialog__head">
          <p className="tc-dialog__eyebrow">Payroll</p>
          <h2 className="tc-dialog__title">New payroll run</h2>
          <p className="tc-dialog__sub">
            Creates a draft. Process it once the month is over to compute the payslips.
          </p>
        </div>

        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <fieldset
            className={`hr-pay-fieldset${periodError ? ' field--invalid' : ''}`}
            aria-describedby={periodError ? `${uid}-period-error` : `${uid}-period-hint`}
          >
            <legend className="field__label">Pay period</legend>
            <div className="hr-pay-period">
              <div className="field">
                <label className="field__label hr-pay-sublabel" htmlFor={`${uid}-month`}>
                  Month
                </label>
                <select
                  id={`${uid}-month`}
                  className="select"
                  value={month}
                  disabled={saving}
                  aria-invalid={periodError ? true : undefined}
                  onChange={(event) => setMonth(event.target.value)}
                >
                  {MONTH_NAMES.map((name, index) => (
                    <option key={name} value={String(index + 1).padStart(2, '0')}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label hr-pay-sublabel" htmlFor={`${uid}-year`}>
                  Year
                </label>
                <select
                  id={`${uid}-year`}
                  className="select"
                  value={year}
                  disabled={saving}
                  aria-invalid={periodError ? true : undefined}
                  onChange={(event) => setYear(event.target.value)}
                >
                  {years.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {periodError ? (
              <p className="field__error" id={`${uid}-period-error`} role="alert">
                <Icon name="alert" size={14} />
                {periodError}
              </p>
            ) : (
              <p className="field__hint" id={`${uid}-period-hint`}>
                {monthLabel(period)}. One run per month; this month or an earlier one.
              </p>
            )}
          </fieldset>

          <div className={`field${noteError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={`${uid}-note`}>
              Note (optional)
            </label>
            <input
              id={`${uid}-note`}
              className="input"
              value={note}
              maxLength={RUN_NOTE_LENGTH}
              disabled={saving}
              placeholder="e.g. Includes the festival bonus month"
              aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? `${uid}-note-error` : undefined}
              onChange={(event) => setNote(event.target.value)}
            />
            {noteError ? (
              <p className="field__error" id={`${uid}-note-error`} role="alert">
                <Icon name="alert" size={14} />
                {noteError}
              </p>
            ) : (
              <p className="field__hint">Shown on the run for administrators. Employees do not see it.</p>
            )}
          </div>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--outline" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving} aria-busy={saving || undefined}>
            {saving ? <ButtonSpinner /> : <Icon name="add" size={16} />}
            {saving ? 'Creating…' : 'Create draft run'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
