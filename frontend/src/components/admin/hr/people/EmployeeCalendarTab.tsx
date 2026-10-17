'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  DAY_STATUS_LABELS,
  WEEKDAYS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  companyClock,
  formatMonth,
  peopleApi,
  shiftMonth,
  type CalendarDay,
  type CalendarDayStatus,
  type HrEmployee,
} from '@/lib/hr';
import { isAbort } from './shared';

/**
 * One month of an employee's days, classified exactly as the HR app and payroll see them.
 *
 * Every date of the month gets a status from the server's one classifier: attended
 * (present / late / half day), a holiday, a weekly off, leave, absent, not judged yet,
 * before attendance tracking began, or outside their employment. The admin sees the same
 * answer the employee's own calendar shows, so a dispute starts from one shared picture.
 *
 * A month is at most 31 days, so it is fetched whole — a bounded aggregate, not a list.
 */

/** The order the month's totals are listed in. Statuses with no days are left out. */
const SUMMARY_ORDER: CalendarDayStatus[] = [
  'checked_in',
  'checked_out',
  'yet_to_check_in',
  'present',
  'late',
  'half_day',
  'on_leave',
  'absent',
  'holiday',
  'weekly_off',
  'untracked',
  'not_employed',
  'upcoming',
];

function dayNumber(date: string): number {
  return Number(date.slice(8, 10));
}

const HALF_DAY_LABEL = { none: '', first_half: ' · first half', second_half: ' · second half' } as const;

/** The small print under a day's status: times, leave, or the holiday's name. */
function dayDetail(day: CalendarDay): string[] {
  const lines: string[] = [];
  if (day.attendance?.checkedInAt) {
    const out = day.attendance.checkedOutAt ? companyClock(day.attendance.checkedOutAt) : 'now';
    lines.push(`${companyClock(day.attendance.checkedInAt)}–${out}`);
  }
  if (day.leave) lines.push(`${day.leave.typeName}${HALF_DAY_LABEL[day.leave.halfDay]}`);
  if (day.holiday) lines.push(day.holiday.isOptional ? `${day.holiday.name} (optional)` : day.holiday.name);
  if (day.pendingLeave) lines.push(`Asked for ${day.pendingLeave.typeName}`);
  if (day.attendance?.missingPunch) lines.push('Missing punch');
  if (day.attendance?.flagged) lines.push('Flagged punch');
  return lines;
}

export function EmployeeCalendarTab({
  employee,
  onUnauthorized,
}: {
  employee: HrEmployee;
  onUnauthorized: () => void;
}) {
  /** Undefined until the server names the current month (the company's, not the browser's). */
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [days, setDays] = useState<CalendarDay[] | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await peopleApi.employeeCalendar(employee.id, month, controller.signal);
      setDays(result.days);
      setShown(result.month);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load the calendar.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [employee.id, month, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const current = shown ?? month ?? null;

  const go = (delta: number) => {
    if (current) setMonth(shiftMonth(current, delta));
  };

  /* Totals over the month — computed from the classifier's own answers, nothing added. */
  const counts = new Map<CalendarDayStatus, number>();
  for (const day of days ?? []) counts.set(day.status, (counts.get(day.status) ?? 0) + 1);

  /* The month as weeks, Sunday first, padded at both ends to whole weeks. */
  const weeks: (CalendarDay | null)[][] = [];
  if (days && days.length > 0) {
    const lead = WEEKDAYS.indexOf(days[0]!.weekday);
    const cells: (CalendarDay | null)[] = [...Array.from({ length: lead }, () => null), ...days];
    while (cells.length % 7 !== 0) cells.push(null);
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  }

  return (
    <div className="hrp-tab-body">
      <div className="hrp-month" role="group" aria-label="Month">
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => go(-1)}
          disabled={!current || loading}
          aria-label={current ? `Previous month, ${formatMonth(shiftMonth(current, -1))}` : 'Previous month'}
        >
          <Icon name="arrowLeft" size={15} />
        </button>
        <label className="sr-only" htmlFor={`hr-cal-month-${employee.id}`}>
          Month
        </label>
        <input
          id={`hr-cal-month-${employee.id}`}
          className="input hrp-month__input"
          type="month"
          value={current ?? ''}
          onChange={(event) => {
            if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value);
          }}
        />
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => go(1)}
          disabled={!current || loading}
          aria-label={current ? `Next month, ${formatMonth(shiftMonth(current, 1))}` : 'Next month'}
        >
          <Icon name="arrowRight" size={15} />
        </button>
        {month !== undefined ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMonth(undefined)}>
            This month
          </button>
        ) : null}
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {days === null ? (
        loading ? (
          <LoaderBlock label="Loading the calendar…" minHeight="20rem" />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          <ul className="hrp-cal-summary" aria-label={`Totals for ${current ? formatMonth(current) : 'the month'}`}>
            {SUMMARY_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => (
              <li key={status} className="hrp-cal-summary__item" data-status={status}>
                <span className="hrp-cal-summary__value">{counts.get(status)}</span>
                <span className="hrp-cal-summary__label">{DAY_STATUS_LABELS[status]}</span>
              </li>
            ))}
          </ul>

          <div className="hrp-cal-wrap">
            <table className="hrp-cal">
              <caption className="sr-only">
                {employee.name}’s days in {current ? formatMonth(current) : 'this month'}
              </caption>
              <thead>
                <tr>
                  {WEEKDAYS.map((weekday) => (
                    <th key={weekday} scope="col">
                      <abbr title={WEEKDAY_LONG[weekday]}>{WEEKDAY_SHORT[weekday]}</abbr>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, index) => (
                  <tr key={index}>
                    {week.map((day, cell) =>
                      day ? (
                        <td
                          key={day.date}
                          className="hrp-cal__cell"
                          data-status={day.status}
                          data-today={day.isToday ? 'true' : undefined}
                        >
                          <span className="hrp-cal__num">
                            {dayNumber(day.date)}
                            {day.isToday ? <span className="sr-only"> (today)</span> : null}
                          </span>
                          <span className="hrp-cal__status">{DAY_STATUS_LABELS[day.status]}</span>
                          {dayDetail(day).map((line) => (
                            <span key={line} className="hrp-cal__meta">
                              {line}
                            </span>
                          ))}
                        </td>
                      ) : (
                        <td key={`blank-${cell}`} className="hrp-cal__cell hrp-cal__cell--blank" aria-hidden="true" />
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="tc-muted hrp-caption">
            Times are India Standard Time. “Not tracked” days fall before attendance tracking
            began, so a missing punch there is not an absence.
          </p>
        </LoadingOverlay>
      )}
    </div>
  );
}
