'use client';

import { useId, useRef, useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { isIsoDate } from '@/lib/telecalling';
import { formatCalendarDay, leaveAdminApi, type Holiday } from '@/lib/hrLeave';
import { HrDialog, writeFailure } from './shared';

/**
 * Adds or edits one holiday.
 *
 * A holiday reclassifies its date on every calendar at once (attendance, leave counting,
 * payroll all derive it), but a leave request already raised across it keeps the day
 * count it was raised with. An OPTIONAL holiday is shown in the app's calendar but is not
 * a day off — employees who take it apply for leave as usual.
 */

type FieldKey = 'date' | 'name' | 'isOptional' | 'form';

export function HolidayDialog({
  existing,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  existing: Holiday | null;
  onClose: () => void;
  onSaved: (saved: Holiday, message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const dateRef = useRef<HTMLInputElement | null>(null);

  const [date, setDate] = useState(existing?.date ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [isOptional, setIsOptional] = useState(existing?.isOptional ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const submit = async () => {
    const errors: Partial<Record<FieldKey, string>> = {};
    const cleanName = name.trim();
    if (!isIsoDate(date)) errors.date = 'Choose the date.';
    if (cleanName.length < 2) errors.name = 'Name the holiday.';
    else if (cleanName.length > 120) errors.name = 'Keep the name to 120 characters or fewer.';

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('Check the highlighted fields.');
      return;
    }

    let patch: Partial<{ date: string; name: string; isOptional: boolean }> = {};
    if (existing) {
      if (date !== existing.date) patch.date = date;
      if (cleanName !== existing.name) patch.name = cleanName;
      if (isOptional !== existing.isOptional) patch.isOptional = isOptional;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
    } else {
      patch = { date, name: cleanName, isOptional };
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const saved = existing
        ? await leaveAdminApi.updateHoliday(existing.id, patch)
        : await leaveAdminApi.createHoliday({ date, name: cleanName, isOptional });
      onSaved(
        saved,
        `${saved.name} on ${formatCalendarDay(saved.date)} is ${existing ? 'updated' : 'added'}${
          saved.isOptional ? ' as an optional holiday' : ''
        }.`,
      );
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can change the holiday calendar.',
        'The holiday could not be saved.',
      );
      if (message === null) return;
      if (caught instanceof ApiError) setFieldErrors(caught.fieldErrors as Partial<Record<FieldKey, string>>);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const errorLine = (key: FieldKey) =>
    fieldErrors[key] ? (
      <p className="field__error" id={id(`${key}-error`)}>
        <Icon name="alert" size={14} />
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <HrDialog
      title={existing ? 'Edit holiday' : 'Add a holiday'}
      eyebrow="Holiday calendar"
      sub={existing ? `${existing.name} · ${formatCalendarDay(existing.date)}` : undefined}
      onClose={onClose}
      initialFocus={dateRef}
    >
      <form
        className="hrl-dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="tc-dialog__body">
          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <div className="tc-form__grid">
            <div className={`field${fieldErrors.date ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={id('date')}>
                Date
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                ref={dateRef}
                id={id('date')}
                className="input"
                type="date"
                required
                min="2000-01-01"
                max="2100-12-31"
                value={date}
                disabled={saving}
                aria-invalid={fieldErrors.date ? true : undefined}
                aria-describedby={fieldErrors.date ? id('date-error') : id('date-hint')}
                onChange={(event) => setDate(event.target.value)}
              />
              {fieldErrors.date ? (
                errorLine('date')
              ) : (
                <p className="field__hint" id={id('date-hint')}>
                  {isIsoDate(date) ? formatCalendarDay(date) : 'One holiday per date.'}
                </p>
              )}
            </div>

            <div className={`field${fieldErrors.name ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={id('name')}>
                Name
                <span className="field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id={id('name')}
                className="input"
                maxLength={120}
                required
                value={name}
                disabled={saving}
                placeholder="e.g. Diwali"
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? id('name-error') : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {errorLine('name')}
            </div>
          </div>

          <div className="tc-choice-list">
            <div className="tc-choice">
              <label>
                <input
                  type="checkbox"
                  checked={isOptional}
                  disabled={saving}
                  aria-describedby={id('optional-hint')}
                  onChange={(event) => setIsOptional(event.target.checked)}
                />
                <span>Optional holiday</span>
              </label>
            </div>
            <p className="field__hint" id={id('optional-hint')}>
              {isOptional
                ? 'Shown in the calendar, but a normal working day: anyone taking it applies for leave.'
                : 'A day off for everyone. It is not counted as a working day in leave requests, attendance or payroll.'}
            </p>
            {errorLine('isOptional')}
          </div>

          {existing ? (
            <p className="tc-dialog__note">
              Leave requests already raised across this date keep the number of days they were
              raised with.
            </p>
          ) : null}
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving} aria-busy={saving || undefined}>
            {saving ? <ButtonSpinner /> : null}
            {existing ? 'Save changes' : 'Add holiday'}
          </button>
        </div>
      </form>
    </HrDialog>
  );
}
