'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRestoreFocus, useStableClose } from '@/components/admin/ConfirmDialog';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  MONTH_NAMES,
  RUN_NOTE_LENGTH,
  describeCycle,
  formatPeriodRange,
  payPeriodBounds,
  payrollApi,
  periodContaining,
  shortCalendarDate,
  type PayrollRun,
} from '@/lib/hrPayroll';
import { todayIso } from '@/lib/telecalling';

/**
 * Opens a pay period for one month (a draft — no figures until it is calculated).
 *
 * MONTH AND YEAR ARE TWO SELECTS, not `<input type="month">`. Firefox and Safari render a
 * month input as a bare text box, which would leave half the administrators typing
 * "2026-09" by hand; two selects work the same everywhere and cannot hold an impossible
 * month.
 *
 * THE DEFAULT IS THE PERIOD RUNNING TODAY. A period can be calculated as soon as it has
 * started, so the one an administrator opens is usually the current one — not last
 * month, as when a period could only be worked on after it ended. Under a 26th cycle
 * "today" can belong to next month's period (27 October is in November's), which is why
 * the default comes from `periodContaining` rather than from the calendar.
 *
 * THE DATES ARE PREVIEWED with the server's own rule (`payPeriodBounds`, mirrored), from
 * the cycle as it was read when the list loaded. The server fixes the real dates when it
 * creates the period, and refuses one that has not started — its sentence is shown under
 * the month rather than re-implemented as a disabled button, so a cycle changed elsewhere
 * since cannot block a period that is in fact valid.
 */
export function NewRunDialog({
  startDay,
  onClose,
  onCreated,
  onUnauthorized,
}: {
  /** The pay cycle's start day, or null when it could not be read (then no preview). */
  startDay: number | null;
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
    const today = todayIso();
    const [year, month] = periodContaining(today, startDay ?? 1).split('-') as [string, string];
    return { today, year, month, currentYear: Number(today.slice(0, 4)) };
  });

  const [month, setMonth] = useState(defaults.month);
  const [year, setYear] = useState(defaults.year);
  const [note, setNote] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const close = useStableClose(() => {
    if (!saving) onClose();
  });

  // This year and the ten before it — plus next year when today already falls in its
  // first period (late December under a 26th cycle). The server accepts any month from
  // 2000 on, but a period more than a decade old is not something anyone opens here.
  const newestYear = Math.max(defaults.currentYear, Number(defaults.year));
  const years = Array.from({ length: newestYear - defaults.currentYear + 11 }, (_, index) => newestYear - index);

  const period = `${year}-${month}`;
  const bounds = startDay !== null ? payPeriodBounds(period, startDay) : null;
  const today = defaults.today;

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
      const fields = caught instanceof ApiError ? caught.fieldErrors : {};
      setFieldErrors(fields);
      // Anything not about the month or the note goes in the banner, so no refusal is lost.
      const unplaced = Object.entries(fields)
        .filter(([key]) => key !== 'period' && key !== 'note')
        .map(([, message]) => message);
      if (unplaced.length > 0) setError(unplaced.join(' '));
      else if (Object.keys(fields).length === 0) {
        setError(caught instanceof ApiError ? caught.message : 'Could not open the pay period.');
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
      onClose={close}
      title="New pay period"
      className="tc-dialog hr-pay-dialog--narrow"
      dismissOnBackdrop={false}
    >
      <form className="hr-pay-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="tc-dialog__head">
          <p className="tc-dialog__eyebrow">Payroll</p>
          <h2 className="tc-dialog__title">New pay period</h2>
          <p className="tc-dialog__sub">
            Once it is open you can calculate payslips any time to see the figures so far, and
            approve them after the period ends.
          </p>
        </div>

        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <fieldset
            className={`hr-pay-fieldset${periodError ? ' field--invalid' : ''}`}
            aria-describedby={`${periodError ? `${uid}-period-error` : `${uid}-period-hint`} ${uid}-preview`}
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
                {startDay !== null ? `${describeCycle(startDay)}. ` : 'The dates follow your pay cycle. '}
                A pay period is named after the month it ends in.
              </p>
            )}

            {/* What the chosen month means, said as the selects change. */}
            <div className="hr-pay-preview" id={`${uid}-preview`} aria-live="polite">
              <Icon name="calendar" size={16} />
              {bounds ? (
                <span>
                  <strong className="hr-pay-preview__range">{formatPeriodRange(bounds.start, bounds.end)}</strong>
                  <span className="hr-pay-preview__state" data-tone={bounds.start > today ? 'warn' : undefined}>
                    {bounds.start > today
                      ? `Has not started yet. You can open it from ${shortCalendarDate(bounds.start)}.`
                      : bounds.end < today
                        ? `Ended on ${shortCalendarDate(bounds.end)}. You can calculate and approve it straight away.`
                        : `Running now, until ${shortCalendarDate(bounds.end)}. Calculate any time to see the figures so far.`}
                  </span>
                </span>
              ) : (
                <span>The exact dates are set from your pay cycle when the period is opened.</span>
              )}
            </div>
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
              aria-describedby={noteError ? `${uid}-note-error` : `${uid}-note-hint`}
              onChange={(event) => setNote(event.target.value)}
            />
            {noteError ? (
              <p className="field__error" id={`${uid}-note-error`} role="alert">
                <Icon name="alert" size={14} />
                {noteError}
              </p>
            ) : (
              <p className="field__hint" id={`${uid}-note-hint`}>
                Shown on the pay period for administrators. Employees do not see it.
              </p>
            )}
          </div>
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--outline" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving} aria-busy={saving || undefined}>
            {saving ? <ButtonSpinner /> : <Icon name="add" size={16} />}
            {saving ? 'Opening…' : 'Open pay period'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
