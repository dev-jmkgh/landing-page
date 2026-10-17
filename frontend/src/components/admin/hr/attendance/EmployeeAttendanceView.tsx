'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  ATTENDANCE_SOURCE_LABELS,
  DAY_STATUS_LABELS,
  WEEKDAYS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  WORK_MODE_LABELS,
  companyClock,
  dayVerdict,
  formatMonth,
  minutesAsHours,
  peopleApi,
  shiftMonth,
  type AttendanceDays,
  type AttendanceViewDay,
  type AttendanceViewSession,
  type CalendarDayStatus,
  type HrEmployee,
  type WorkMode,
} from '@/lib/hr';
import { formatTime, todayIso } from '@/lib/telecalling';
import { Tag } from '../../telecalling/shared';
import { isAbort } from '../people/shared';
import { CorrectDayDialog } from './CorrectDayDialog';
import { DayMarkers, DayStatusTag, FlagTags } from './dayStatus';

/**
 * One employee's attendance — opened from the register by their name.
 *
 * Three ways to read it, as HR tools usually offer them:
 *   Calendar     a MONTH at a glance, each date coloured by what it was
 *   Table        a WEEK, one row per date, with the times and totals
 *   Punch view   a WEEK, each date as a line across the working day with one bar per
 *                session, so late starts, long breaks and forgotten check-outs show as shapes
 *
 * Every view is drawn from one response (`attendance-days`, a month or a week): the
 * server's single day classifier, with each date's recorded day, its sessions and the
 * evidence behind each punch beside it — the same verdicts the employee's app, the register
 * and payroll use. Neither period is more than 31 days, so each is fetched whole.
 *
 * Choosing a date in any view opens that day in a drawer from the right: every check-in
 * and check-out, office or remote, where each punch was made, and the correction, which
 * goes through the same dialog the register uses.
 */

type View = 'calendar' | 'table' | 'punch';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'table', label: 'Table' },
  { key: 'punch', label: 'Punch view' },
];

const VIEW_KEY = 'jmk.hr.attendance.view';

/* The chosen view is a per-browser convenience; blocked storage just means "calendar". */
function readView(): View {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    return saved === 'table' || saved === 'punch' ? saved : 'calendar';
  } catch {
    return 'calendar';
  }
}

function writeView(view: View) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not remembered this time.
  }
}

/* ------------------------------------------------------------------ dates */

/** All date maths at noon UTC on `YYYY-MM-DD`, so no zone or daylight rule can move a date. */
const atNoon = (date: string) => new Date(`${date}T12:00:00Z`);

function addDays(date: string, days: number): string {
  const next = atNoon(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** The Sunday a week starts on — the calendar grid's first column. */
function weekStartOf(date: string): string {
  return addDays(date, -atNoon(date).getUTCDay());
}

/** "Thu, 16 Oct" from `2026-10-16`. */
function shortDate(date: string): string {
  return atNoon(date).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

function longDate(date: string): string {
  return atNoon(date).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "11 – 17 Oct 2026", or "27 Sep – 3 Oct 2026" across a month. */
function rangeLabel(from: string, to: string): string {
  const format = (date: string, options: Intl.DateTimeFormatOptions) =>
    atNoon(date).toLocaleDateString('en-IN', { timeZone: 'UTC', ...options });
  const end = format(to, { day: 'numeric', month: 'short', year: 'numeric' });
  if (from.slice(0, 7) === to.slice(0, 7)) return `${format(from, { day: 'numeric' })} – ${end}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${format(from, { day: 'numeric', month: 'short' })} – ${end}`;
  return `${format(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${end}`;
}

/** Minutes after the company's midnight on `date` (IST, +05:30, no daylight saving). */
function minuteOfDay(iso: string, date: string): number {
  return (Date.parse(iso) - Date.parse(`${date}T00:00:00+05:30`)) / 60_000;
}

/** "09:30" or "09:30:00" as minutes after midnight; null when unreadable. */
function clockMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(value ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockLabel(minutes: number): string {
  const whole = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** The shift a date was worked against: its own snapshot when recorded, else today's shift. */
function shiftFor(day: AttendanceViewDay, current: AttendanceDays['shift']): { start: number; end: number } | null {
  const start = clockMinutes(day.record?.shiftStartsAt ?? current?.startsAt);
  const end = clockMinutes(day.record?.shiftEndsAt ?? current?.endsAt);
  if (start === null || end === null) return null;
  // An overnight shift ends the next morning.
  return { start, end: end <= start ? end + 1440 : end };
}

/** Days with no work expected — no shift band on the timeline, nothing to correct. */
const RESTING: CalendarDayStatus[] = ['weekly_off', 'holiday', 'not_employed'];

const canCorrectDay = (day: AttendanceViewDay) =>
  day.employed && day.status !== 'not_employed' && (day.isToday || day.status !== 'upcoming');

/** What a date was, beyond its status: leave, the holiday's name, a pending request. */
function dayNotes(day: AttendanceViewDay): string[] {
  const notes: string[] = [];
  if (day.leave) {
    const half =
      day.leave.halfDay === 'first_half'
        ? ' · first half'
        : day.leave.halfDay === 'second_half'
          ? ' · second half'
          : '';
    notes.push(`${day.leave.typeName}${half}`);
  }
  if (day.holiday) notes.push(day.holiday.isOptional ? `${day.holiday.name} (optional)` : day.holiday.name);
  if (day.pendingLeave) notes.push(`Asked for ${day.pendingLeave.typeName}`);
  return notes;
}

/* ------------------------------------------------------------------ the view */

export function EmployeeAttendanceView({
  userId,
  initialName,
  initialMonth,
  initialDate,
  onBack,
  onUnauthorized,
}: {
  userId: number;
  /** Shown until the employee record arrives, so the heading never flashes empty. */
  initialName: string;
  /** `YYYY-MM`. The register's month, so a click from 3 September opens September. */
  initialMonth?: string;
  /** The register's date: marked in the views, and the week the week views open on. */
  initialDate?: string;
  onBack: () => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [view, setView] = useState<View>(() => (typeof window === 'undefined' ? 'calendar' : readView()));
  /** The calendar's month; undefined until the server names the current one. */
  const [month, setMonth] = useState<string | undefined>(initialMonth);
  /** The Sunday the week views start on. */
  const [weekStart, setWeekStart] = useState<string>(() => weekStartOf(initialDate ?? todayIso()));
  const [data, setData] = useState<AttendanceDays | null>(null);
  const [employee, setEmployee] = useState<HrEmployee | null>(null);
  /** The date last chosen — marked in every view, and carried between month and week. */
  const [selected, setSelected] = useState<string | null>(initialDate ?? null);
  /** The date whose drawer is open. */
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceViewDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  /** What opened the drawer, so focus can return there after a correction too. */
  const triggerRef = useRef<HTMLElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  const weekly = view !== 'calendar';
  const weekEnd = addDays(weekStart, 6);

  // Arriving from the register: the heading takes focus, so a keyboard user is placed here.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    peopleApi
      .employee(userId, controller.signal)
      .then((result) => setEmployee(result.employee))
      .catch((caught) => {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        // Otherwise the header keeps the register's name; the days still load.
      });
    return () => controller.abort();
  }, [userId, onUnauthorized]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const query = weekly ? { from: weekStart, to: weekEnd } : { month };
      setData(await peopleApi.employeeAttendanceDays(userId, query, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load these days.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [userId, weekly, weekStart, weekEnd, month, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const today = todayIso();
  const currentMonth = (!weekly && data?.month) || month || today.slice(0, 7);

  /*
   * Switching between the month and the week keeps the place: the chosen date's week (or
   * month), else today's when it is in view, else the start of what was showing.
   */
  const choose = (next: View) => {
    if (next === view) return;
    if (next !== 'calendar' && view === 'calendar') {
      const anchor =
        selected && selected.slice(0, 7) === currentMonth
          ? selected
          : today.slice(0, 7) === currentMonth
            ? today
            : `${currentMonth}-01`;
      setWeekStart(weekStartOf(anchor));
    }
    if (next === 'calendar' && view !== 'calendar') {
      const anchor = selected && selected >= weekStart && selected <= weekEnd ? selected : addDays(weekStart, 3);
      setMonth(anchor.slice(0, 7));
    }
    setView(next);
    writeView(next);
  };

  const goMonth = (delta: number) => setMonth(shiftMonth(currentMonth, delta));
  const goWeek = (delta: number) => setWeekStart(addDays(weekStart, delta * 7));

  const open = (date: string) => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelected(date);
    setNotice(null);
    setDrawerDate(date);
  };

  const days = data?.days ?? [];
  const drawerDay = days.find((day) => day.date === drawerDate) ?? null;
  const name = employee?.name ?? initialName;

  // Totals count verdicts: somebody checked in or out today counts as present (or late) so far.
  const counts = new Map<CalendarDayStatus, number>();
  for (const day of days) counts.set(dayVerdict(day), (counts.get(dayVerdict(day)) ?? 0) + 1);
  const count = (...statuses: CalendarDayStatus[]) =>
    statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  const period = data ? (data.month ? formatMonth(data.month) : rangeLabel(data.from, data.to)) : '';

  return (
    <div className="hra">
      <div className="hra-head">
        <button type="button" className="tc-text-button hra-head__back" onClick={onBack}>
          <Icon name="arrowLeft" size={15} />
          Attendance register
        </button>

        <div className="hra-head__identity">
          <h2 className="hra-head__name" ref={headingRef} tabIndex={-1}>
            {name}
          </h2>
          <p className="hra-head__meta">
            {[employee?.employeeCode, employee?.designationName, employee?.departmentName]
              .filter(Boolean)
              .join(' · ') || ' '}
          </p>
          <p className="hra-head__meta">
            <Icon name="clock" size={14} />
            {data?.shift
              ? `${data.shift.name} · ${data.shift.startsAt.slice(0, 5)}–${data.shift.endsAt.slice(0, 5)}`
              : data
                ? 'No shift assigned'
                : ' '}
            {employee ? ` · ${WORK_MODE_LABELS[employee.workMode] ?? employee.workMode}` : ''}
          </p>
        </div>
      </div>

      <div className="hra-toolbar">
        {weekly ? (
          <div className="hrp-month" role="group" aria-label="Week">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => goWeek(-1)}
              disabled={loading}
              aria-label={`Previous week, ${rangeLabel(addDays(weekStart, -7), addDays(weekStart, -1))}`}
            >
              <Icon name="arrowLeft" size={15} />
            </button>
            <label className="sr-only" htmlFor={`${uid}-week`}>
              Show the week containing
            </label>
            <input
              id={`${uid}-week`}
              className="input hrp-month__input"
              type="date"
              value={weekStart}
              onChange={(event) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setWeekStart(weekStartOf(event.target.value));
              }}
            />
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => goWeek(1)}
              disabled={loading}
              aria-label={`Next week, ${rangeLabel(addDays(weekStart, 7), addDays(weekStart, 13))}`}
            >
              <Icon name="arrowRight" size={15} />
            </button>
            <span className="hra-range" aria-live="polite">
              {rangeLabel(weekStart, weekEnd)}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekStart(weekStartOf(today))}
              disabled={today >= weekStart && today <= weekEnd}
            >
              This week
            </button>
          </div>
        ) : (
          <div className="hrp-month" role="group" aria-label="Month">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => goMonth(-1)}
              disabled={loading}
              aria-label={`Previous month, ${formatMonth(shiftMonth(currentMonth, -1))}`}
            >
              <Icon name="arrowLeft" size={15} />
            </button>
            <label className="sr-only" htmlFor={`${uid}-month`}>
              Month
            </label>
            <input
              id={`${uid}-month`}
              className="input hrp-month__input"
              type="month"
              value={currentMonth}
              onChange={(event) => {
                if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value);
              }}
            />
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => goMonth(1)}
              disabled={loading}
              aria-label={`Next month, ${formatMonth(shiftMonth(currentMonth, 1))}`}
            >
              <Icon name="arrowRight" size={15} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMonth(today.slice(0, 7))}
              disabled={currentMonth === today.slice(0, 7)}
            >
              This month
            </button>
          </div>
        )}

        <div className="tc-segmented" role="group" aria-label="Show the days as">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="tc-segmented__button"
              aria-pressed={view === item.key}
              onClick={() => choose(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <FormAlert variant="error">
          {error}{' '}
          <button type="button" className="tc-alert-action" onClick={() => void load()}>
            Try again
          </button>
        </FormAlert>
      ) : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <LoaderBlock label="Loading the days…" minHeight="22rem" />
        ) : null
      ) : (
        <LoadingOverlay busy={loading} label="Loading the days…">
          <ul className="hra-totals" aria-label={`Totals for ${period}`}>
            <Total value={count('present', 'late', 'half_day')} label="Days present" tone="good" />
            <Total value={count('late')} label="Late" tone="warn" />
            <Total value={count('half_day')} label="Half days" tone="warn" />
            <Total value={count('absent')} label="Absent" tone="bad" />
            <Total value={count('on_leave')} label="On leave" tone="progress" />
            <Total value={count('holiday')} label="Holidays" />
            <Total value={count('weekly_off')} label="Weekly offs" />
            <Total value={minutesAsHours(data.summary.totalWorkedMinutes)} label="Hours worked" />
            <Total
              value={data.summary.averageWorkedMinutes > 0 ? minutesAsHours(data.summary.averageWorkedMinutes) : '—'}
              label="Average a day"
            />
          </ul>

          {/* What is showing must match what was asked for; a stale month never draws as a week. */}
          {view === 'calendar' && data.month ? (
            <CalendarView data={data} name={name} selected={selected} onOpen={open} />
          ) : view === 'table' && !data.month ? (
            <TableView data={data} name={name} onOpen={open} />
          ) : view === 'punch' && !data.month ? (
            <PunchView data={data} name={name} selected={selected} onOpen={open} />
          ) : null}

          <p className="tc-muted hrp-caption">
            Times are India Standard Time. “Not tracked” days fall before attendance tracking began, so a missing punch
            there is not an absence.
          </p>
        </LoadingOverlay>
      )}

      {drawerDay && data ? (
        <DayDrawer
          day={drawerDay}
          name={name}
          shift={data.shift}
          employeeMode={employee?.workMode ?? null}
          onClose={() => setDrawerDate(null)}
          onCorrect={() => {
            // One dialog at a time: the drawer closes and the correction opens in its place.
            setDrawerDate(null);
            setNotice(null);
            setCorrecting(drawerDay);
          }}
        />
      ) : null}

      {correcting ? (
        <CorrectDayDialog
          key={`${userId}-${correcting.date}`}
          employee={{ userId, name, employeeCode: employee?.employeeCode ?? '' }}
          date={correcting.date}
          day={correcting.record}
          onClose={() => {
            setCorrecting(null);
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }}
          onSaved={(_day, message) => {
            setCorrecting(null);
            setNotice(message);
            void load();
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </div>
  );
}

function Total({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'good' | 'warn' | 'bad' | 'progress';
}) {
  return (
    <li className="hra-totals__item" data-tone={tone}>
      <span className="hra-totals__value">{value}</span>
      <span className="hra-totals__label">{label}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ calendar */

function CalendarView({
  data,
  name,
  selected,
  onOpen,
}: {
  data: AttendanceDays;
  name: string;
  selected: string | null;
  onOpen: (date: string) => void;
}) {
  /* The month as weeks, Sunday first, padded at both ends to whole weeks. */
  const weeks: (AttendanceViewDay | null)[][] = [];
  if (data.days.length > 0) {
    const lead = WEEKDAYS.indexOf(data.days[0]!.weekday);
    const cells: (AttendanceViewDay | null)[] = [...Array.from({ length: lead }, () => null), ...data.days];
    while (cells.length % 7 !== 0) cells.push(null);
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  }

  return (
    <div className="hrp-cal-wrap">
      <table className="hrp-cal hra-cal">
        <caption className="sr-only">
          {name}’s days in {data.month ? formatMonth(data.month) : rangeLabel(data.from, data.to)}. Choose a date to see
          its punches.
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
                    data-selected={day.date === selected ? 'true' : undefined}
                  >
                    <button type="button" className="hra-cal__day" onClick={() => onOpen(day.date)}>
                      <span className="hrp-cal__num">
                        {Number(day.date.slice(8, 10))}
                        <span className="sr-only">
                          {' '}
                          {longDate(day.date)}
                          {day.isToday ? ' (today)' : ''}:
                        </span>
                      </span>
                      <span className="hrp-cal__status">{DAY_STATUS_LABELS[day.status]}</span>
                      {day.record?.checkedInAt ? (
                        <span className="hrp-cal__meta">
                          {formatTime(day.record.checkedInAt)}–
                          {day.record.checkedOutAt ? formatTime(day.record.checkedOutAt) : 'now'}
                        </span>
                      ) : null}
                      {day.record?.workedMinutes ? (
                        <span className="hra-cal__hours">{minutesAsHours(day.record.workedMinutes)}</span>
                      ) : null}
                      {dayNotes(day).map((line) => (
                        <span key={line} className="hrp-cal__meta">
                          {line}
                        </span>
                      ))}
                      {day.record?.missingPunch ? <span className="hra-cal__alert">Missing punch</span> : null}
                    </button>
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
  );
}

/* ------------------------------------------------------------------ table */

function TableView({
  data,
  name,
  onOpen,
}: {
  data: AttendanceDays;
  name: string;
  /** Opens the date's drawer, which is also where a day is corrected. */
  onOpen: (date: string) => void;
}) {
  const dash = <span className="tc-muted">—</span>;

  return (
    <DataTable
      rows={data.days}
      rowKey={(day) => day.date}
      rowTone={(day) => (day.record?.missingPunch ? 'bad' : day.status === 'absent' ? 'warn' : undefined)}
      minWidth="62rem"
      caption={`${name}’s attendance, ${rangeLabel(data.from, data.to)}, one row per date`}
      columns={[
        {
          key: 'date',
          header: 'Date',
          width: '8.5rem',
          nowrap: true,
          render: (day) => (
            <button type="button" className="tc-link-button hra-date" onClick={() => onOpen(day.date)}>
              {shortDate(day.date)}
              <span className="sr-only">: open the day</span>
              {day.isToday ? <span className="hra-date__today">today</span> : null}
            </button>
          ),
        },
        {
          key: 'day',
          header: 'Day',
          width: '12rem',
          render: (day) => (
            <CellStack
              primary={<DayStatusTag status={day.status} />}
              secondary={dayNotes(day).join(' · ') || undefined}
            >
              {day.record ? (
                <DayMarkers
                  missingPunch={day.record.missingPunch}
                  flagged={day.record.flagged}
                  source={day.record.source}
                />
              ) : null}
            </CellStack>
          ),
        },
        {
          key: 'shift',
          header: 'Shift',
          width: '8rem',
          nowrap: true,
          render: (day) => {
            if (RESTING.includes(day.status)) return dash;
            const shift = shiftFor(day, data.shift);
            return shift ? `${clockLabel(shift.start)}–${clockLabel(shift.end)}` : dash;
          },
        },
        {
          key: 'in',
          header: 'First in',
          width: '6.5rem',
          nowrap: true,
          render: (day) => (day.record?.checkedInAt ? formatTime(day.record.checkedInAt) : dash),
        },
        {
          key: 'out',
          header: 'Last out',
          width: '6.5rem',
          nowrap: true,
          render: (day) =>
            day.record?.checkedOutAt ? (
              formatTime(day.record.checkedOutAt)
            ) : day.record?.openSessionStartedAt ? (
              <Tag tone="progress">in now</Tag>
            ) : (
              dash
            ),
        },
        {
          key: 'sessions',
          header: 'Sessions',
          width: '5.5rem',
          align: 'end',
          render: (day) => (day.record && day.record.sessions.length > 0 ? day.record.sessions.length : dash),
        },
        {
          key: 'worked',
          header: 'Worked',
          width: '6rem',
          align: 'end',
          nowrap: true,
          render: (day) =>
            day.record?.workedMinutes === null || !day.record ? dash : minutesAsHours(day.record.workedMinutes),
        },
        {
          key: 'break',
          header: 'Break',
          width: '5.5rem',
          align: 'end',
          nowrap: true,
          render: (day) => (day.record && day.record.breakMinutes > 0 ? minutesAsHours(day.record.breakMinutes) : dash),
        },
        {
          key: 'late',
          header: 'Late by',
          width: '6rem',
          align: 'end',
          nowrap: true,
          render: (day) =>
            day.record && day.record.lateMinutes > 0 ? (
              <span className="hra-late">{minutesAsHours(day.record.lateMinutes)}</span>
            ) : (
              dash
            ),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ punch view */

/**
 * The hours the timeline spans: from an hour before the earliest shift start or punch in
 * the week to an hour after the latest, never less than eight hours. A fixed 00:00–24:00
 * would leave a 9-to-6 day as a thin bar in the middle third of the line.
 */
function timelineWindow(data: AttendanceDays, now: number): { from: number; to: number } {
  let low = Infinity;
  let high = -Infinity;
  const take = (minute: number | null) => {
    if (minute === null || !Number.isFinite(minute)) return;
    low = Math.min(low, minute);
    high = Math.max(high, minute);
  };

  for (const day of data.days) {
    if (!RESTING.includes(day.status)) {
      const shift = shiftFor(day, data.shift);
      if (shift) {
        take(shift.start);
        take(Math.min(shift.end, 1440));
      }
    }
    for (const session of day.record?.sessions ?? []) {
      take(minuteOfDay(session.startedAt, day.date));
      take(Math.min(1440, minuteOfDay(session.endedAt ?? new Date(now).toISOString(), day.date)));
    }
  }

  if (low === Infinity) return { from: 8 * 60, to: 20 * 60 };
  let from = Math.max(0, (Math.floor(low / 60) - 1) * 60);
  let to = Math.min(1440, (Math.ceil(high / 60) + 1) * 60);
  while (to - from < 8 * 60) {
    if (to < 1440) to += 60;
    else from -= 60;
  }
  return { from: Math.max(0, from), to };
}

function PunchView({
  data,
  name,
  selected,
  onOpen,
}: {
  data: AttendanceDays;
  name: string;
  selected: string | null;
  onOpen: (date: string) => void;
}) {
  // One "now" for the render: an open session runs to it.
  const [now] = useState(() => Date.now());
  const range = timelineWindow(data, now);
  const span = range.to - range.from;
  const at = (minute: number) =>
    `${(((Math.min(Math.max(minute, range.from), range.to) - range.from) / span) * 100).toFixed(3)}%`;
  const width = (start: number, end: number) => {
    const left = Math.max(start, range.from);
    const right = Math.min(end, range.to);
    return `${Math.max(0.5, ((right - left) / span) * 100).toFixed(3)}%`;
  };

  const step = span > 12 * 60 ? 180 : 120;
  const ticks: number[] = [];
  for (let minute = Math.ceil(range.from / 60) * 60; minute <= range.to; minute += 60) ticks.push(minute);

  return (
    <div className="hra-punch">
      <p className="sr-only">
        {name}’s sessions for {rangeLabel(data.from, data.to)}, one line per date, from {clockLabel(range.from)} to{' '}
        {clockLabel(range.to)}. Each date lists its sessions in words as well; choose one to see every punch.
      </p>

      <div className="hra-punch__row hra-punch__row--scale" aria-hidden="true">
        <span />
        <div className="hra-punch__track hra-punch__track--scale">
          {ticks.map((minute) => (
            <span
              key={minute}
              className={`hra-punch__tick${(minute - ticks[0]!) % step === 0 ? '' : ' hra-punch__tick--minor'}`}
              style={{ left: at(minute) }}
            >
              {clockLabel(minute)}
            </span>
          ))}
        </div>
        <span className="hra-punch__total">Worked</span>
      </div>

      <ol className="hra-punch__days">
        {data.days.map((day) => {
          const shift = RESTING.includes(day.status) ? null : shiftFor(day, data.shift);
          const sessions = day.record?.sessions ?? [];
          const spoken = sessions.length
            ? sessions
                .map((session) => {
                  const end = session.endedAt ? formatTime(session.endedAt) : 'still in';
                  return `${formatTime(session.startedAt)} to ${end}${session.minutes !== null ? ` (${minutesAsHours(session.minutes)})` : ''}`;
                })
                .join('; ')
            : 'no punches';

          return (
            <li
              key={day.date}
              className="hra-punch__row hra-punch__row--day"
              data-status={day.status}
              data-today={day.isToday ? 'true' : undefined}
              data-selected={day.date === selected ? 'true' : undefined}
            >
              {/* The whole row is this button's target (see the CSS), one tab stop per date. */}
              <button type="button" className="hra-punch__date" onClick={() => onOpen(day.date)}>
                <span className="hra-punch__day">{shortDate(day.date)}</span>
                <span className="hra-punch__status">{DAY_STATUS_LABELS[day.status]}</span>
                <span className="sr-only">: {spoken}. Open the day.</span>
              </button>

              <div className="hra-punch__track" aria-hidden="true">
                {ticks.map((minute) => (
                  <span key={minute} className="hra-punch__grid" style={{ left: at(minute) }} />
                ))}
                {shift ? (
                  <span
                    className="hra-punch__shift"
                    style={{ left: at(shift.start), width: width(shift.start, shift.end) }}
                  />
                ) : null}
                {sessions.map((session) => {
                  const start = minuteOfDay(session.startedAt, day.date);
                  const end = minuteOfDay(session.endedAt ?? new Date(now).toISOString(), day.date);
                  const kind = session.endedAt === null ? 'open' : session.autoClosed ? 'auto' : session.source;
                  return (
                    <span
                      key={session.id}
                      className="hra-punch__bar"
                      data-kind={kind}
                      style={{ left: at(start), width: width(start, Math.max(end, start + 1)) }}
                    />
                  );
                })}
              </div>

              <span className="hra-punch__total" aria-hidden="true">
                {day.record?.workedMinutes
                  ? minutesAsHours(day.record.workedMinutes)
                  : day.record?.openSessionStartedAt
                    ? 'in now'
                    : ''}
                {day.record?.checkedInAt ? (
                  <span className="hra-punch__span">
                    {companyClock(day.record.checkedInAt)}–
                    {day.record.checkedOutAt ? companyClock(day.record.checkedOutAt) : 'now'}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <ul className="hra-legend" aria-label="Key">
        <li>
          <span className="hra-legend__swatch" data-kind="shift" aria-hidden="true" />
          Shift
        </li>
        <li>
          <span className="hra-legend__swatch" data-kind="app" aria-hidden="true" />
          Punched in the app
        </li>
        <li>
          <span className="hra-legend__swatch" data-kind="open" aria-hidden="true" />
          Still checked in
        </li>
        <li>
          <span className="hra-legend__swatch" data-kind="admin" aria-hidden="true" />
          Corrected
        </li>
        <li>
          <span className="hra-legend__swatch" data-kind="auto" aria-hidden="true" />
          Closed by the system (missing punch)
        </li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ the day drawer */

const mapLink = (latitude: number, longitude: number) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

/** The device clock, when it disagreed with the server's by two minutes or more. */
function phoneClockNote(deviceAt: string | null | undefined, serverAt: string | null): string | null {
  if (!deviceAt || !serverAt) return null;
  return Math.abs(Date.parse(deviceAt) - Date.parse(serverAt)) >= 2 * 60_000
    ? `Phone clock said ${formatTime(deviceAt)}`
    : null;
}

/**
 * One punch — a check-in or a check-out — as the drawer lists it: the time, office or
 * remote, where it was made and how sure the phone was of it.
 */
function Punch({ kind, session, mode }: { kind: 'in' | 'out'; session: AttendanceViewSession; mode: WorkMode | null }) {
  const isIn = kind === 'in';
  const at = isIn ? session.startedAt : session.endedAt;
  const latitude = (isIn ? session.inLatitude : session.outLatitude) ?? null;
  const longitude = (isIn ? session.inLongitude : session.outLongitude) ?? null;
  const accuracy = (isIn ? session.inAccuracyMetres : session.outAccuracyMetres) ?? null;
  const distance = (isIn ? session.inDistanceMetres : session.outDistanceMetres) ?? null;
  const site = session.inLocationName ?? null;
  const flags = (isIn ? session.inFlags : session.outFlags) ?? [];
  const clockNote = phoneClockNote(isIn ? session.inDeviceAt : session.outDeviceAt, at);

  /* The words for where the punch was made. */
  let where: ReactNode;
  if (!isIn && session.endedAt === null) {
    where = 'Still checked in';
  } else if (!isIn && session.autoClosed) {
    where = 'Nobody checked out, so the system closed this session with no hours';
  } else if (latitude === null || longitude === null) {
    where =
      session.source === 'admin'
        ? 'Entered by an administrator — no location'
        : session.source === 'regularisation'
          ? 'From an approved correction — no location'
          : 'No location shared';
  } else {
    // A check-in names the site it was matched to; a check-out says how far it was from it.
    const place =
      isIn && site
        ? distance !== null
          ? `At ${site} · ${distance} m away`
          : `At ${site}`
        : distance !== null
          ? `${distance} m from ${site ?? 'the site'}`
          : null;
    const parts = [place, accuracy !== null ? `accurate to ±${accuracy} m` : null].filter(Boolean);
    where = (
      <>
        {parts.length ? <span className="hra-punch-item__place">{parts.join(' · ')}</span> : null}
        <span className="hra-punch-item__coords">
          {latitude.toFixed(5)}, {longitude.toFixed(5)}{' '}
          <a href={mapLink(latitude, longitude)} target="_blank" rel="noopener noreferrer" className="tc-text-button">
            Open in Maps
            <span className="sr-only"> (the {isIn ? 'check-in' : 'check-out'} location, in a new tab)</span>
          </a>
        </span>
      </>
    );
  }

  return (
    <div className="hra-punch-item" data-kind={kind}>
      <span className="hra-punch-item__dot" aria-hidden="true" />
      <div className="hra-punch-item__body">
        <p className="hra-punch-item__line">
          <span className="hra-punch-item__label">{isIn ? 'Check-in' : 'Check-out'}</span>
          <strong className="hra-punch-item__time">{at ? formatTime(at) : '—'}</strong>
          {mode && at && !(!isIn && session.autoClosed) ? (
            <span className="hra-mode" data-mode={mode}>
              {WORK_MODE_LABELS[mode] ?? mode}
            </span>
          ) : null}
        </p>
        <p className="hra-punch-item__where">{where}</p>
        {clockNote ? <p className="hra-punch-item__note">{clockNote}</p> : null}
        <FlagTags flags={flags} />
      </div>
    </div>
  );
}

function DayDrawer({
  day,
  name,
  shift: currentShift,
  employeeMode,
  onClose,
  onCorrect,
}: {
  day: AttendanceViewDay;
  name: string;
  shift: AttendanceDays['shift'];
  /** Their assigned mode, for a day with no record of its own. */
  employeeMode: WorkMode | null;
  onClose: () => void;
  onCorrect: () => void;
}) {
  const record = day.record;
  const shift = RESTING.includes(day.status) ? null : shiftFor(day, currentShift);
  const notes = dayNotes(day);
  // The day's own mode — an approved work-from-home or field day is recorded as such.
  const mode = record?.workMode ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={longDate(day.date)}
      label={`${name}, ${longDate(day.date)}`}
      className="hra-drawer"
    >
      <div className="hra-drawer__head">
        <p className="hra-drawer__eyebrow">{name}</p>
        <h2 className="hra-drawer__title">{longDate(day.date)}</h2>
        <div className="hra-drawer__tags">
          <DayStatusTag status={day.status} />
          {mode ? (
            <span className="hra-mode" data-mode={mode}>
              {WORK_MODE_LABELS[mode] ?? mode}
            </span>
          ) : null}
          {record ? (
            <DayMarkers missingPunch={record.missingPunch} flagged={record.flagged} source={record.source} />
          ) : null}
        </div>
        {notes.length ? <p className="hra-drawer__notes">{notes.join(' · ')}</p> : null}
      </div>

      <div className="hra-drawer__body">
        <dl className="hra-drawer__facts">
          <div>
            <dt>Shift</dt>
            <dd>{shift ? `${clockLabel(shift.start)}–${clockLabel(shift.end)}` : '—'}</dd>
          </div>
          <div>
            <dt>Worked</dt>
            <dd>{record?.workedMinutes === null || !record ? '—' : minutesAsHours(record.workedMinutes)}</dd>
          </div>
          <div>
            <dt>Break</dt>
            <dd>{record && record.breakMinutes > 0 ? minutesAsHours(record.breakMinutes) : '—'}</dd>
          </div>
          <div>
            <dt>First in</dt>
            <dd>{record?.checkedInAt ? formatTime(record.checkedInAt) : '—'}</dd>
          </div>
          <div>
            <dt>Last out</dt>
            <dd>
              {record?.checkedOutAt ? formatTime(record.checkedOutAt) : record?.openSessionStartedAt ? 'In now' : '—'}
            </dd>
          </div>
          <div>
            <dt>Late by</dt>
            <dd>{record && record.lateMinutes > 0 ? minutesAsHours(record.lateMinutes) : '—'}</dd>
          </div>
        </dl>

        <h3 className="hra-drawer__section">Check-ins and check-outs</h3>
        {record && record.sessions.length > 0 ? (
          <ol className="hra-sessions">
            {record.sessions.map((session, index) => (
              <li key={session.id} className="hra-sessions__item">
                <div className="hra-sessions__head">
                  <span>Session {index + 1}</span>
                  <span className="hra-sessions__duration">
                    {session.minutes === null ? 'running' : minutesAsHours(session.minutes)}
                  </span>
                </div>
                <Punch kind="in" session={session} mode={mode} />
                <Punch kind="out" session={session} mode={mode} />
                <p className="hra-sessions__source">
                  {session.autoClosed
                    ? 'Closed by the system'
                    : session.source === 'app'
                      ? 'Punched in the HR app'
                      : ATTENDANCE_SOURCE_LABELS[session.source]}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="tc-muted hra-drawer__empty">
            No punches on this day
            {employeeMode && !RESTING.includes(day.status)
              ? ` (assigned to work ${WORK_MODE_LABELS[employeeMode]?.toLowerCase() ?? employeeMode})`
              : ''}
            .
          </p>
        )}

        {record?.note ? (
          <p className="hra-drawer__note">
            <strong>Correction note:</strong> {record.note}
          </p>
        ) : null}
      </div>

      {canCorrectDay(day) ? (
        <div className="hra-drawer__foot">
          <button type="button" className="btn btn--outline btn--sm" onClick={onCorrect}>
            Correct day
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}
