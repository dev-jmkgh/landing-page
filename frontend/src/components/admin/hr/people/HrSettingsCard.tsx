'use client';

import { useCallback, useEffect, useState } from 'react';
import { ButtonSpinner, LoaderBlock } from '@/components/admin/Loader';
import { FormAlert, TextField } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import { formatDate, todayIso } from '@/lib/telecalling';
import { describeWeekdays, peopleApi, type HrSettings, type Weekday } from '@/lib/hr';
import { CYCLE_START_DAYS, cycleExample, cycleSpan, ordinal } from '@/lib/hrPayroll';
import { DateField, EnumSelect } from './fields';
import { classifyWriteError, isAbort } from './shared';
import { WeekdayPicker } from './WeekdayPicker';

/**
 * Company-wide HR policy: when attendance tracking began, the weekly off for people with
 * no shift, the pay cycle, and how long compensatory leave stays usable.
 *
 * The first two change how EVERY day is classified — past days included — wherever days
 * are counted: the register, calendars, reports, and any payroll calculated afterwards.
 * An approved pay period is frozen and does not move. That is said beside the Save
 * button, because nothing on the screen would otherwise suggest that a date field
 * reaches back into last month's absences.
 *
 * The pay cycle is the opposite: it applies only to pay periods opened AFTER it is
 * saved, because a period's dates are fixed when it is opened. Payroll → Pay periods
 * edits the same value; both say so.
 */

/** "1".."28", as the select's values. */
const CYCLE_OPTIONS = CYCLE_START_DAYS.map(String);
const CYCLE_LABELS: Record<string, string> = Object.fromEntries(
  CYCLE_START_DAYS.map((day) => [String(day), day === 1 ? '1st (calendar month)' : `${ordinal(day)} of the month`]),
);

export function HrSettingsCard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [settings, setSettings] = useState<HrSettings | null>(null);
  const [trackedFrom, setTrackedFrom] = useState('');
  const [weeklyOff, setWeeklyOff] = useState<Weekday[]>([]);
  const [cycleDay, setCycleDay] = useState('1');
  const [compOffDays, setCompOffDays] = useState('30');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The IST date, for the pay cycle's live example.
  const [today] = useState(todayIso);

  /** Takes the server's values as both the saved state and the form's starting point. */
  const adopt = useCallback((next: HrSettings) => {
    // An API from before the pay cycle existed sends no start day: that is the calendar
    // month (1), and treating it so keeps the form from reading as changed on arrival.
    const cycle = Number.isInteger(next.payrollCycleStartDay) ? next.payrollCycleStartDay : 1;
    // Likewise compensatory leave's validity: 30 days until it is set.
    const validity = Number.isInteger(next.compOffValidityDays) ? next.compOffValidityDays : 30;
    setSettings({ ...next, payrollCycleStartDay: cycle, compOffValidityDays: validity });
    setTrackedFrom(next.attendanceTrackedFrom ?? '');
    setWeeklyOff(next.defaultWeeklyOff);
    setCycleDay(String(cycle));
    setCompOffDays(String(validity));
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
  const cycleChanged = settings !== null && Number(cycleDay) !== settings.payrollCycleStartDay;
  const compOffChanged = settings !== null && compOffDays.trim() !== String(settings.compOffValidityDays);
  const dirty = trackedChanged || weeklyChanged || cycleChanged || compOffChanged;

  const save = async () => {
    setError(null);
    setNotice(null);
    setFieldErrors({});
    if (!dirty) return;

    const validity = Number(compOffDays.trim());
    if (compOffChanged && !(Number.isInteger(validity) && validity >= 1 && validity <= 365)) {
      setFieldErrors({ compOffValidityDays: 'Use a whole number of days from 1 to 365.' });
      return;
    }

    const patch: Partial<HrSettings> = {};
    if (trackedChanged) patch.attendanceTrackedFrom = trackedFrom || null;
    if (weeklyChanged) patch.defaultWeeklyOff = weeklyOff;
    if (cycleChanged) patch.payrollCycleStartDay = Number(cycleDay);
    if (compOffChanged) patch.compOffValidityDays = validity;

    setSaving(true);
    try {
      adopt(await peopleApi.updateSettings(patch));
      setNotice(
        cycleChanged
          ? 'HR settings saved. Pay periods already opened keep their dates; the new pay cycle applies to the ones opened from now on.'
          : 'HR settings saved.',
      );
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
                hint="Days before this date show as “Not tracked” in calendars and reports. Payroll still counts a working day with no attendance as absent (loss of pay) — to pay somebody for those days, pay them in full on their payslip. Leave it empty to judge every day."
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

            <EnumSelect
              label="Pay period starts on the"
              value={cycleDay}
              options={CYCLE_OPTIONS}
              labels={CYCLE_LABELS}
              onChange={setCycleDay}
              error={fieldErrors.payrollCycleStartDay}
              hint={`The same for everyone. A pay period is named after the month it ends in: ${cycleExample(
                Number(cycleDay),
                today,
              )}. Pay periods already opened keep their dates.`}
            />

            <TextField
              label="Compensatory leave must be taken within (days)"
              name="hr-comp-off-validity"
              value={compOffDays}
              error={fieldErrors.compOffValidityDays}
              maxLength={3}
              autoComplete="off"
              hint="Counted from the weekly off or holiday worked. A worked day older than this can no longer be used."
              onChange={setCompOffDays}
            />
          </div>

          <p className="tc-dialog__note">
            Saved now:{' '}
            {settings.attendanceTrackedFrom
              ? `tracking from ${formatDate(settings.attendanceTrackedFrom)}`
              : 'every day is judged'}
            {' · '}default weekly off {describeWeekdays(settings.defaultWeeklyOff)}
            {' · '}pay periods {settings.payrollCycleStartDay <= 1 ? 'follow' : 'run from'}{' '}
            {cycleSpan(settings.payrollCycleStartDay)}
            {' · '}compensatory leave within {settings.compOffValidityDays} days. Tracking and weekly-off changes apply to
            past days as well as future ones — in the register, calendars, reports and any payroll
            calculated afterwards. A new pay cycle applies only to pay periods opened afterwards.
            Approved payroll does not change.
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
