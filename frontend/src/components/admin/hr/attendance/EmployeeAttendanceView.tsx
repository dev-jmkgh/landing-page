'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  ATTENDANCE_SOURCE_LABELS,
  DAY_STATUS_LABELS,
  WEEKDAYS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  WORK_MODE_LABELS,
  formatMonth,
  minutesAsHours,
  peopleApi,
  shiftMonth,
  type AttendanceMonth,
  type AttendanceMonthDay,
  type CalendarDayStatus,
  type HrEmployee,
} from '@/lib/hr';
import { formatTime } from '@/lib/telecalling';
import { Tag } from '../../telecalling/shared';
import { isAbort } from '../people/shared';
import { CorrectDayDialog } from './CorrectDayDialog';
import { DayMarkers, DayStatusTag, FlagTags } from './dayStatus';

/**
 * One employee's attendance for a month — opened from the register by their name.
 *
 * Three ways to read the same month, as HR tools usually offer them:
 *   Calendar     the month at a glance, each date coloured by what it was
 *   Table        one row per date, with the times and totals
 *   Punch view   each date as a line across the working day, one bar per session, so
 *                late starts, long breaks and forgotten check-outs show as shapes
 *
 * Every view is drawn from one response (`attendance-month`): the server's single day
 * classifier, with each date's recorded day and sessions beside it — the same verdicts
 * the employee's app, the register and payroll use. A month is at most 31 days, so it is
 * fetched whole.
 *
 * Choosing a date in any view opens that day below: its sessions, who recorded them, and
 * the correction, which goes through the same dialog the register uses.
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

/** "Thu, 16 Oct" from `2026-10-16`. Built at noon UTC so no zone can move the date. */
function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

function longDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
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
function shiftFor(day: AttendanceMonthDay, current: AttendanceMonth['shift']): { start: number; end: number } | null {
  const start = clockMinutes(day.record?.shiftStartsAt ?? current?.startsAt);
  const end = clockMinutes(day.record?.shiftEndsAt ?? current?.endsAt);
  if (start === null || end === null) return null;
  // An overnight shift ends the next morning.
  return { start, end: end <= start ? end + 1440 : end };
}

/** Days with no work expected — no shift band on the timeline, nothing to correct. */
const RESTING: CalendarDayStatus[] = ['weekly_off', 'holiday', 'not_employed'];

const canCorrectDay = (day: AttendanceMonthDay) =>
  day.employed && day.status !== 'not_employed' && (day.isToday || day.status !== 'upcoming');

/** What a date was, beyond its status: leave, the holiday's name, a pending request. */
function dayNotes(day: AttendanceMonthDay): string[] {
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
  /** The register's date, opened in the day panel when it falls in the month shown. */
  initialDate?: string;
  onBack: () => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const [month, setMonth] = useState<string | undefined>(initialMonth);
  const [data, setData] = useState<AttendanceMonth | null>(null);
  const [employee, setEmployee] = useState<HrEmployee | null>(null);
  const [view, setView] = useState<View>(() => (typeof window === 'undefined' ? 'calendar' : readView()));
  const [selected, setSelected] = useState<string | null>(initialDate ?? null);
  const [correcting, setCorrecting] = useState<AttendanceMonthDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);

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
        // Otherwise the header keeps the register's name; the month still loads.
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
      setData(await peopleApi.employeeAttendanceMonth(userId, month, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load this month.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [userId, month, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const current = data?.month ?? month ?? null;
  const go = (delta: number) => {
    if (!current) return;
    setMonth(shiftMonth(current, delta));
    setSelected(null);
  };

  const choose = (next: View) => {
    setView(next);
    writeView(next);
  };

  const open = (date: string) => {
    setSelected(date);
    setNotice(null);
    // After the panel renders: its heading takes focus, which also scrolls it into view.
    window.requestAnimationFrame(() => detailRef.current?.focus());
  };

  const days = data?.days ?? [];
  const selectedDay = days.find((day) => day.date === selected) ?? null;
  const name = employee?.name ?? initialName;

  const counts = new Map<CalendarDayStatus, number>();
  for (const day of days) counts.set(day.status, (counts.get(day.status) ?? 0) + 1);
  const count = (...statuses: CalendarDayStatus[]) =>
    statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);

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
          <label className="sr-only" htmlFor={`${uid}-month`}>
            Month
          </label>
          <input
            id={`${uid}-month`}
            className="input hrp-month__input"
            type="month"
            value={current ?? ''}
            onChange={(event) => {
              if (/^\d{4}-\d{2}$/.test(event.target.value)) {
                setMonth(event.target.value);
                setSelected(null);
              }
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
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setMonth(undefined);
              setSelected(null);
            }}
            disabled={data !== null && days.some((day) => day.isToday)}
          >
            This month
          </button>
        </div>

        <div className="tc-segmented" role="group" aria-label="Show the month as">
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
          <LoaderBlock label="Loading the month…" minHeight="22rem" />
        ) : null
      ) : (
        <LoadingOverlay busy={loading} label="Loading the month…">
          <ul className="hra-totals" aria-label={`Totals for ${formatMonth(data.month)}`}>
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

          {view === 'calendar' ? (
            <CalendarView data={data} name={name} selected={selected} onOpen={open} />
          ) : view === 'table' ? (
            <TableView data={data} name={name} onOpen={open} />
          ) : (
            <PunchView data={data} name={name} selected={selected} onOpen={open} />
          )}

          <p className="tc-muted hrp-caption">
            Times are India Standard Time. “Not tracked” days fall before attendance tracking began, so a missing punch
            there is not an absence.
          </p>
        </LoadingOverlay>
      )}

      {selectedDay && data ? (
        <DayPanel
          day={selectedDay}
          shift={data.shift}
          headingRef={detailRef}
          onClose={() => setSelected(null)}
          onCorrect={() => {
            setNotice(null);
            setCorrecting(selectedDay);
          }}
        />
      ) : null}

      {correcting ? (
        <CorrectDayDialog
          key={`${userId}-${correcting.date}`}
          employee={{
            userId,
            name,
            employeeCode: employee?.employeeCode ?? '',
          }}
          date={correcting.date}
          day={correcting.record}
          onClose={() => setCorrecting(null)}
          onSaved={(_day, message) => {
            setCorrecting(null);
            setNotice(message);
            void load();
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
  data: AttendanceMonth;
  name: string;
  selected: string | null;
  onOpen: (date: string) => void;
}) {
  /* The month as weeks, Sunday first, padded at both ends to whole weeks. */
  const weeks: (AttendanceMonthDay | null)[][] = [];
  if (data.days.length > 0) {
    const lead = WEEKDAYS.indexOf(data.days[0]!.weekday);
    const cells: (AttendanceMonthDay | null)[] = [...Array.from({ length: lead }, () => null), ...data.days];
    while (cells.length % 7 !== 0) cells.push(null);
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  }

  return (
    <div className="hrp-cal-wrap">
      <table className="hrp-cal hra-cal">
        <caption className="sr-only">
          {name}’s days in {formatMonth(data.month)}. Choose a date to see its punches.
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
                    <button
                      type="button"
                      className="hra-cal__day"
                      aria-pressed={day.date === selected}
                      onClick={() => onOpen(day.date)}
                    >
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
  data: AttendanceMonth;
  name: string;
  /** Opens the date's panel, which is also where a day is corrected. */
  onOpen: (date: string) => void;
}) {
  const dash = <span className="tc-muted">—</span>;

  return (
    <DataTable
      rows={data.days}
      rowKey={(day) => day.date}
      rowTone={(day) => (day.record?.missingPunch ? 'bad' : day.status === 'absent' ? 'warn' : undefined)}
      minWidth="62rem"
      caption={`${name}’s attendance, ${formatMonth(data.month)}, one row per date`}
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
 * the month to an hour after the latest, never less than eight hours. A fixed 00:00–24:00
 * would leave a 9-to-6 day as a thin bar in the middle third of the line.
 */
function timelineWindow(data: AttendanceMonth, now: number): { from: number; to: number } {
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
  data: AttendanceMonth;
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
        {name}’s sessions in {formatMonth(data.month)}, one line per date, from {clockLabel(range.from)} to{' '}
        {clockLabel(range.to)}. Each date lists its sessions in words as well.
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
              className="hra-punch__row"
              data-status={day.status}
              data-today={day.isToday ? 'true' : undefined}
              data-selected={day.date === selected ? 'true' : undefined}
            >
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
                    style={{
                      left: at(shift.start),
                      width: width(shift.start, shift.end),
                    }}
                    title={`Shift ${clockLabel(shift.start)}–${clockLabel(shift.end)}`}
                  />
                ) : null}
                {sessions.map((session) => {
                  const start = minuteOfDay(session.startedAt, day.date);
                  const end = minuteOfDay(session.endedAt ?? new Date(now).toISOString(), day.date);
                  const kind = session.endedAt === null ? 'open' : session.autoClosed ? 'auto' : session.source;
                  const label = `${formatTime(session.startedAt)}–${session.endedAt ? formatTime(session.endedAt) : 'now'}${
                    session.minutes !== null ? ` · ${minutesAsHours(session.minutes)}` : ''
                  }${session.source !== 'app' ? ` · ${ATTENDANCE_SOURCE_LABELS[session.source]}` : ''}`;
                  return (
                    <span
                      key={session.id}
                      className="hra-punch__bar"
                      data-kind={kind}
                      style={{
                        left: at(start),
                        width: width(start, Math.max(end, start + 1)),
                      }}
                      title={label}
                    />
                  );
                })}
              </div>

              <span className="hra-punch__total">
                {day.record?.workedMinutes
                  ? minutesAsHours(day.record.workedMinutes)
                  : day.record?.openSessionStartedAt
                    ? 'in now'
                    : ''}
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

/* ------------------------------------------------------------------ the day */

function DayPanel({
  day,
  shift: currentShift,
  headingRef,
  onClose,
  onCorrect,
}: {
  day: AttendanceMonthDay;
  shift: AttendanceMonth['shift'];
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onCorrect: () => void;
}) {
  const uid = useId();
  const record = day.record;
  const shift = RESTING.includes(day.status) ? null : shiftFor(day, currentShift);
  const notes = dayNotes(day);

  return (
    <section className="tc-card hra-detail" aria-labelledby={`${uid}-title`}>
      <header className="hra-detail__head">
        <div className="hra-detail__title-row">
          <h3 className="hra-detail__title" id={`${uid}-title`} ref={headingRef} tabIndex={-1}>
            {longDate(day.date)}
          </h3>
          <DayStatusTag status={day.status} />
          {record ? (
            <DayMarkers missingPunch={record.missingPunch} flagged={record.flagged} source={record.source} />
          ) : null}
        </div>
        <button type="button" className="hra-detail__close" onClick={onClose} aria-label="Close the day">
          <Icon name="close" size={16} />
        </button>
      </header>

      {notes.length ? <p className="hra-detail__notes">{notes.join(' · ')}</p> : null}

      <dl className="hra-detail__facts">
        <div>
          <dt>Shift</dt>
          <dd>{shift ? `${clockLabel(shift.start)}–${clockLabel(shift.end)}` : '—'}</dd>
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
          <dt>Worked</dt>
          <dd>{record?.workedMinutes === null || !record ? '—' : minutesAsHours(record.workedMinutes)}</dd>
        </div>
        <div>
          <dt>Break</dt>
          <dd>{record && record.breakMinutes > 0 ? minutesAsHours(record.breakMinutes) : '—'}</dd>
        </div>
        <div>
          <dt>Late by</dt>
          <dd>{record && record.lateMinutes > 0 ? minutesAsHours(record.lateMinutes) : '—'}</dd>
        </div>
      </dl>

      {record && record.sessions.length > 0 ? (
        <div className="table-wrap hra-detail__sessions">
          <table className="data-table">
            <caption className="sr-only">Sessions on {longDate(day.date)}</caption>
            <thead>
              <tr>
                <th scope="col">Check-in</th>
                <th scope="col">Check-out</th>
                <th scope="col" className="hra-num">
                  Duration
                </th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {record.sessions.map((session) => (
                <tr key={session.id}>
                  <td>{formatTime(session.startedAt)}</td>
                  <td>{session.endedAt ? formatTime(session.endedAt) : <Tag tone="progress">in now</Tag>}</td>
                  <td className="hra-num">{session.minutes === null ? '—' : minutesAsHours(session.minutes)}</td>
                  <td>
                    <span className="hra-detail__source">
                      {session.autoClosed ? 'Closed by the system' : ATTENDANCE_SOURCE_LABELS[session.source]}
                      <FlagTags flags={session.flags} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tc-muted hra-detail__empty">No punches on this day.</p>
      )}

      {record?.note ? (
        <p className="hra-detail__note">
          <strong>Correction note:</strong> {record.note}
        </p>
      ) : null}

      {canCorrectDay(day) ? (
        <div className="hra-detail__actions">
          <button type="button" className="btn btn--outline btn--sm" onClick={onCorrect}>
            Correct day
          </button>
        </div>
      ) : null}
    </section>
  );
}
