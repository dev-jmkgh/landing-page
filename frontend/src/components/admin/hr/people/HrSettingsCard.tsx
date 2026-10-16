'use client';

import { useCallback, useEffect, useState } from 'react';
import { ButtonSpinner, LoaderBlock } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/telecalling';
import { describeWeekdays, peopleApi, type HrSettings, type Weekday } from '@/lib/hr';
import { DateField } from './fields';
import { classifyWriteError, isAbort } from './shared';
import { WeekdayPicker } from './WeekdayPicker';

/**
 * Company-wide HR policy: when attendance tracking began, and the weekly off for people
 * with no shift.
 *
 * Both change how EVERY day is classified — past days included — wherever days are
 * counted: the register, calendars, reports, and any payroll run processed afterwards.
 * An approved payroll run is frozen and does not move. That is said beside the Save
 * button, because nothing on the screen would otherwise suggest that a date field
 * reaches back into last month's absences.
 */
export function HrSettingsCard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [settings, setSettings] = useState<HrSettings | null>(null);
  const [trackedFrom, setTrackedFrom] = useState('');
  const [weeklyOff, setWeeklyOff] = useState<Weekday[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Takes the server's values as both the saved state and the form's starting point. */
  const adopt = useCallback((next: HrSettings) => {
    setSettings(next);
    setTrackedFrom(next.attendanceTrackedFrom ?? '');
    setWeeklyOff(next.defaultWeeklyOff);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        adopt(await peopleApi.settings(signal));
        setLoadError(null);
      } catch (caught) {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
        setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the HR settings.');
      }
    },
    [adopt, onUnauthorized],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const trackedChanged = settings !== null && (trackedFrom || null) !== settings.attendanceTrackedFrom;
  const weeklyChanged =
    settings !== null && describeWeekdays(weeklyOff) !== describeWeekdays(settings.defaultWeeklyOff);
  const dirty = trackedChanged || weeklyChanged;

  const save = async () => {
    setError(null);
    setNotice(null);
    setFieldErrors({});
    if (!dirty) return;

    const patch: Partial<HrSettings> = {};
    if (trackedChanged) patch.attendanceTrackedFrom = trackedFrom || null;
    if (weeklyChanged) patch.defaultWeeklyOff = weeklyOff;

    setSaving(true);
    try {
      adopt(await peopleApi.updateSettings(patch));
      setNotice('HR settings saved.');
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      if (outcome.forbidden) {
        setError('Only an administrator can change HR settings.');
        return;
      }
      setFieldErrors(outcome.fields);
      setError(outcome.fields.form ?? outcome.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="tc-card tc-form hrp-settings" aria-labelledby="hr-settings-title">
      <h3 className="tc-section-title" id="hr-settings-title" style={{ marginTop: 0 }}>
        HR settings
      </h3>

      {loadError ? (
        <FormAlert variant="error">
          {loadError}{' '}
          <button type="button" className="tc-text-button" onClick={() => void load()}>
            Try again
          </button>
        </FormAlert>
      ) : null}
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {settings === null ? (
        loadError ? null : <LoaderBlock label="Loading the settings…" minHeight="10rem" />
      ) : (
        <>
          <div className="tc-form__grid">
            <div className="hrp-settings__field">
              <DateField
                label="Attendance tracked from"
                value={trackedFrom}
                error={fieldErrors.attendanceTrackedFrom}
                hint="Days before this date are not judged present or absent. With no punch on record they count as not tracked, so payroll does not deduct pay for them. Leave it empty to judge every day."
                onChange={setTrackedFrom}
              />
              {trackedFrom ? (
                <button type="button" className="tc-text-button" onClick={() => setTrackedFrom('')}>
                  Clear the date
                </button>
              ) : null}
            </div>

            <WeekdayPicker
              label="Default weekly off"
              value={weeklyOff}
              onChange={setWeeklyOff}
              error={fieldErrors.defaultWeeklyOff}
              hint="For employees with no shift. Someone on a shift gets that shift’s weekly off instead."
            />
          </div>

          <p className="tc-dialog__note">
            Saved now:{' '}
            {settings.attendanceTrackedFrom
              ? `tracking from ${formatDate(settings.attendanceTrackedFrom)}`
              : 'every day is judged'}
            {' · '}default weekly off {describeWeekdays(settings.defaultWeeklyOff)}. Changes apply to
            past days as well as future ones — in the register, calendars, reports and any payroll
            processed afterwards. Approved payroll does not change.
          </p>

          <div className="hrp-form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!dirty || saving}
              aria-busy={saving || undefined}
              onClick={() => void save()}
            >
              {saving ? <ButtonSpinner /> : null}
              Save settings
            </button>
            {dirty ? (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={saving}
                onClick={() => settings && adopt(settings)}
              >
                Undo changes
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
