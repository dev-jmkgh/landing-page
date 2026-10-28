'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { RegisterStatusFilter } from '@/lib/hr';
import type { HrAdminDashboard, HrDashboardMetric } from '@/lib/hrReports';
import { count, plural } from '../reports/shared';
import { sectionLinkProps } from './sectionLink';

/**
 * The HR dashboard's day: a summary of where everybody is, then the figures in groups.
 *
 * EVERY FIGURE IS A LINK TO ITS LIST. A figure opens the screen that lists the same people
 * — the attendance register filtered to one status, the exceptions queue, or the employee
 * directory — with the filters already set. The server counts each figure with exactly
 * that screen's query, so the number on the card is the total the list shows, and the list
 * is paged, searchable and exportable however many people are behind it.
 */

export type TileTone = 'good' | 'warn' | 'bad' | 'accent' | 'info';

type LinkProps = { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };

export const METRIC_META: Record<HrDashboardMetric, { label: string; icon: IconName; tone: TileTone }> = {
  headcount: { label: 'Headcount', icon: 'users', tone: 'info' },
  present: { label: 'Present', icon: 'check', tone: 'good' },
  late: { label: 'Late', icon: 'clock', tone: 'warn' },
  half_day: { label: 'Half day', icon: 'target', tone: 'warn' },
  absent: { label: 'Absent', icon: 'alert', tone: 'bad' },
  not_yet_in: { label: 'Not yet in', icon: 'info', tone: 'info' },
  on_leave: { label: 'On leave', icon: 'calendar', tone: 'info' },
  wfh: { label: 'Working from home', icon: 'globe', tone: 'info' },
  field: { label: 'On field work', icon: 'pin', tone: 'info' },
  weekly_off: { label: 'Weekly off', icon: 'leaf', tone: 'info' },
  currently_in: { label: 'In right now', icon: 'spark', tone: 'accent' },
  not_checked_out: { label: 'Not checked out', icon: 'logout', tone: 'warn' },
  missing_punches: { label: 'Missing punches', icon: 'alert', tone: 'warn' },
  flagged: { label: 'Flagged punches to review', icon: 'shield', tone: 'warn' },
};

/** The register status each day figure counts (`DAY_FIGURES` in dashboard.service.ts). */
const REGISTER_STATUS: Partial<Record<HrDashboardMetric, RegisterStatusFilter>> = {
  present: 'present',
  late: 'late',
  half_day: 'half_day',
  absent: 'absent',
  not_yet_in: 'yet_to_check_in',
  on_leave: 'on_leave',
  wfh: 'wfh',
  field: 'field',
  weekly_off: 'weekly_off',
  currently_in: 'currently_in',
  not_checked_out: 'not_checked_out',
};

/**
 * Where a figure's people are listed, with the filters that make the list's total equal
 * the figure. Only the target screen's own parameters are set (see sectionLink.ts).
 */
export function figureLink(metric: HrDashboardMetric, data: HrAdminDashboard): LinkProps {
  if (metric === 'headcount') return sectionLinkProps('people', { 'dir-active': 'true' });
  if (metric === 'missing_punches') {
    return sectionLinkProps('attendance', {
      attTab: 'exceptions',
      'exc-type': 'missing_punch',
      'exc-reviewed': 'all',
      'exc-from': data.today.missingPunchesSince,
      'exc-to': data.date,
    });
  }
  if (metric === 'flagged') {
    // Unreviewed is the queue's default, so it is not spelled out.
    return sectionLinkProps('attendance', { attTab: 'exceptions', 'exc-type': 'flagged', 'exc-to': data.date });
  }
  return sectionLinkProps('attendance', {
    // Without a date the register shows the company's today, as the dashboard does.
    ...(data.isToday ? {} : { 'att-date': data.date }),
    'att-status': REGISTER_STATUS[metric] ?? '',
  });
}

/* -------------------------------------------------------------------------- */
/* A figure                                                                    */
/* -------------------------------------------------------------------------- */

export function MetricTile({
  metric,
  value,
  hint,
  label,
  data,
}: {
  metric: HrDashboardMetric;
  value: number;
  hint?: string;
  /** Overrides the metric's own label. */
  label?: string;
  data: HrAdminDashboard;
}) {
  const meta = METRIC_META[metric];
  const name = label ?? meta.label;
  const link = figureLink(metric, data);

  return (
    <a
      className={`hr-dash-tile hr-dash-tile--${value > 0 ? meta.tone : 'zero'}`}
      href={link.href}
      onClick={link.onClick}
      aria-label={`${name}: ${count(value)}. Open the list.`}
    >
      <span className="hr-dash-tile__top">
        <span className="hr-dash-tile__icon" aria-hidden="true">
          <Icon name={meta.icon} size={15} />
        </span>
        <span className="hr-dash-tile__label">{name}</span>
      </span>
      <span className="hr-dash-tile__value">{count(value)}</span>
      {hint ? <span className="hr-dash-tile__hint">{hint}</span> : null}
      <span className="hr-dash-tile__more" aria-hidden="true">
        View list
        <Icon name="arrowRight" size={13} />
      </span>
    </a>
  );
}

/** A titled group of figures. */
export function TileGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="hr-dash-group" aria-label={title}>
      <header className="hr-dash-group__head">
        <h3 className="hr-dash-group__title">{title}</h3>
        {hint ? <p className="hr-dash-group__hint">{hint}</p> : null}
      </header>
      <div className="hr-dash-group__tiles">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Where everybody is                                                          */
/* -------------------------------------------------------------------------- */

type Segment = { key: string; metric: HrDashboardMetric | null; label: string; value: number };

/**
 * Headcount split by what the day is for each person, as one bar.
 *
 * The parts are the calendar's verdicts, which are disjoint, so they add up to the
 * headcount; whatever no figure covers (a holiday, a day before tracking began, somebody
 * not yet joined) is the grey remainder, named rather than hidden. Working from home and
 * field work are not parts: somebody working from home is also present, or not yet in.
 */
export function DaySummary({ data }: { data: HrAdminDashboard }) {
  const { today, headcount, isToday } = data;
  const attended = today.present + today.late + today.halfDay;
  const parts: Segment[] = [
    { key: 'present', metric: 'present', label: 'Present', value: today.present },
    { key: 'late', metric: 'late', label: 'Late', value: today.late },
    { key: 'half', metric: 'half_day', label: 'Half day', value: today.halfDay },
    { key: 'absent', metric: 'absent', label: 'Absent', value: today.absent },
    { key: 'leave', metric: 'on_leave', label: 'On leave', value: today.onLeave },
    { key: 'off', metric: 'weekly_off', label: 'Weekly off', value: today.weeklyOff },
    { key: 'waiting', metric: 'not_yet_in', label: 'Not yet in', value: today.notYetIn },
  ];
  const counted = parts.reduce((sum, part) => sum + part.value, 0);
  const rest = Math.max(0, headcount.total - counted);
  if (rest > 0) {
    parts.push({ key: 'rest', metric: null, label: today.holiday ? 'Holiday' : 'Not counted', value: rest });
  }
  // Everybody who was due in: attended, absent, or still to come.
  const expected = attended + today.absent + today.notYetIn;
  const shown = parts.filter((part) => part.value > 0);
  const headcountLink = figureLink('headcount', data);

  return (
    <section className="hr-dash-hero" aria-label="Where everybody is">
      <div className="hr-dash-hero__head">
        <div>
          <p className="hr-dash-hero__eyebrow">{isToday ? 'So far today' : 'That day'}</p>
          <p className="hr-dash-hero__figure">
            {expected > 0 ? (
              <>
                <strong>{count(attended)}</strong>
                <span className="hr-dash-hero__of"> of {count(expected)}</span>{' '}
                <span className="hr-dash-hero__words">{isToday ? 'expected are in' : 'expected came in'}</span>
              </>
            ) : (
              <span className="hr-dash-hero__words">Nobody was expected in</span>
            )}
          </p>
        </div>
        <a className="hr-dash-hero__headcount" href={headcountLink.href} onClick={headcountLink.onClick}>
          <Icon name="users" size={16} />
          <span>{plural(headcount.total, 'active employee')}</span>
          <Icon name="arrowRight" size={14} />
        </a>
      </div>

      {headcount.total > 0 ? (
        <>
          <div className="hr-dash-bar" aria-hidden="true">
            {shown.map((part) => (
              <span
                key={part.key}
                className={`hr-dash-bar__seg hr-dash-seg--${part.key}`}
                style={{ flexGrow: part.value }}
                title={`${part.label}: ${count(part.value)}`}
              />
            ))}
          </div>
          <ul className="hr-dash-legend" role="list">
            {shown.map((part) => {
              const body = (
                <>
                  <span className={`hr-dash-legend__swatch hr-dash-seg--${part.key}`} aria-hidden="true" />
                  {part.label}
                  <strong>{count(part.value)}</strong>
                </>
              );
              if (!part.metric) {
                return (
                  <li key={part.key}>
                    <span className="hr-dash-legend__item hr-dash-legend__item--static">{body}</span>
                  </li>
                );
              }
              const link = figureLink(part.metric, data);
              return (
                <li key={part.key}>
                  <a className="hr-dash-legend__item" href={link.href} onClick={link.onClick}>
                    {body}
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
