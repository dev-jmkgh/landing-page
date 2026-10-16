'use client';

import { useState } from 'react';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { hrReportsApi, type HrAdminDashboard } from '@/lib/hrReports';
import { EmptyPanel, StatCard, StatGrid, StatGridSkeleton } from '../telecalling/shared';
import { AttendanceTrendCard } from './dashboard/AttendanceTrendCard';
import { AttentionCards, DepartmentHeadcountCard, PayrollCard } from './dashboard/DashboardCards';
import { sectionLinkProps } from './dashboard/sectionLink';
import { calendarDay, companyToday, count, readUrlDate, useServerData, useUrlParams } from './reports/shared';

/**
 * HR's landing page: the day at a glance, then whatever is waiting for a decision.
 *
 * ONE REQUEST. `GET /admin/hr/dashboard?date` is a single bounded aggregate — headcount,
 * the day's figures, the queues, a fourteen-day trend and (for administrators) the last
 * payroll — so the screen that opens first is never the slow one, and no tile can
 * disagree with its neighbour about which moment it describes.
 *
 * NOTHING IS INVENTED. The live figures (in right now, not checked out) only exist for
 * today; for an earlier date the server sends null and those tiles are not shown, rather
 * than showing a zero that would be a claim about a past moment nobody measured. The
 * payroll card exists only when the server sent payroll figures, which it does for the
 * admin role alone.
 *
 * The date lives in the address (`dash-date`), so a refresh or Back keeps the day chosen.
 * Empty means "whatever the server calls today" — the company calendar, not the browser's.
 */

export function HrDashboardPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [date, setDate] = useState(() => readUrlDate('dash-date'));
  useUrlParams({ 'dash-date': date || null });

  const dashboard = useServerData<HrAdminDashboard>(
    `dashboard:${date}`,
    (signal) => hrReportsApi.dashboard(date || undefined, signal),
    onUnauthorized,
    'Could not load the HR dashboard.',
  );
  const data = dashboard.data;
  const today = companyToday();

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field hr-rep-field--date">
            <label className="field__label" htmlFor="hr-dash-date">
              Date
            </label>
            <input
              id="hr-dash-date"
              className="input"
              type="date"
              value={date || data?.date || today}
              max={today}
              onChange={(event) => setDate(event.target.value === today ? '' : event.target.value)}
            />
          </div>

          {date ? (
            <button type="button" className="btn btn--ghost" onClick={() => setDate('')}>
              Today
            </button>
          ) : null}

          <button type="button" className="btn btn--outline" onClick={dashboard.reload} disabled={dashboard.loading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>

        {data ? (
          <p className="hr-dash-caption">
            {data.isToday ? 'Today, ' : ''}
            {calendarDay(data.date)} · company time (IST)
          </p>
        ) : null}
      </div>

      {data ? (
        <>
          {dashboard.error ? (
            <FormAlert variant="error">
              The figures could not be refreshed. {dashboard.error}{' '}
              <button type="button" className="tc-alert-action" onClick={dashboard.reload}>
                Try again
              </button>
            </FormAlert>
          ) : null}

          <LoadingOverlay busy={dashboard.loading} label="Updating the figures…">
            <DashboardBody data={data} />
          </LoadingOverlay>
        </>
      ) : dashboard.loading ? (
        <>
          <h2 className="tc-section-title">The day</h2>
          <StatGridSkeleton count={8} />
          <h2 className="tc-section-title">Needs your attention</h2>
          <StatGridSkeleton count={4} />
        </>
      ) : (
        <>
          {dashboard.error ? <FormAlert variant="error">{dashboard.error}</FormAlert> : null}
          <EmptyPanel
            title="Nothing to show"
            message="The HR dashboard could not be loaded."
            actionLabel="Try again"
            onAction={dashboard.reload}
          />
        </>
      )}
    </>
  );
}

function DashboardBody({ data }: { data: HrAdminDashboard }) {
  const { today, headcount } = data;
  const everyoneOff = headcount.total > 0 && today.weeklyOff >= headcount.total;
  const day = calendarDay(data.date);

  return (
    <div>
      {/*
        A holiday or a company-wide weekly off is said in words, at the top. Without it a
        column of zeros reads as a morning nobody turned up, which is the opposite of
        what happened.
      */}
      {today.holiday ? (
        <div className="hr-dash-daytype" role="status">
          <span className="hr-dash-daytype__icon" aria-hidden="true">
            <Icon name="calendar" size={20} />
          </span>
          <div>
            <p className="hr-dash-daytype__title">
              {day} is a company holiday{today.holidayName ? `: ${today.holidayName}` : ''}.
            </p>
            <p className="hr-dash-daytype__text">Nobody is expected in, and no one is counted absent.</p>
          </div>
        </div>
      ) : everyoneOff ? (
        <div className="hr-dash-daytype" role="status">
          <span className="hr-dash-daytype__icon" aria-hidden="true">
            <Icon name="calendar" size={20} />
          </span>
          <div>
            <p className="hr-dash-daytype__title">{day} is a weekly off for everyone.</p>
            <p className="hr-dash-daytype__text">Nobody is expected in, and no one is counted absent.</p>
          </div>
        </div>
      ) : null}

      <h2 className="tc-section-title tc-section-title--with-hint">The day</h2>
      <p className="tc-section-hint">
        {data.isToday
          ? 'So far today. People with nothing recorded yet are “not yet in”, not absent.'
          : 'As the attendance calendar classifies the day.'}{' '}
        <a className="tc-link" {...sectionLinkProps('attendance')}>
          Open the attendance register
        </a>
      </p>
      <StatGrid>
        <StatCard value={count(headcount.total)} label="Headcount" icon="users" hint="Active employees" />
        <StatCard value={count(today.present)} label="Present" tone={today.present > 0 ? 'good' : 'default'} icon="check" hint="On time" />
        <StatCard value={count(today.late)} label="Late" tone={today.late > 0 ? 'warn' : 'default'} icon="clock" />
        <StatCard value={count(today.halfDay)} label="Half day" tone={today.halfDay > 0 ? 'warn' : 'default'} />
        <StatCard value={count(today.onLeave)} label="On leave" icon="calendar" />
        {data.isToday ? (
          <StatCard
            value={count(today.notYetIn)}
            label="Not yet in"
            hint="A working day, nothing recorded yet"
          />
        ) : null}
        {/* Today's absences are only ever the exception; an earlier day's are the figure. */}
        {!data.isToday || today.absent > 0 ? (
          <StatCard value={count(today.absent)} label="Absent" tone={today.absent > 0 ? 'bad' : 'default'} />
        ) : null}
        <StatCard value={count(today.wfh)} label="Working from home" hint="On an approved request" />
        <StatCard value={count(today.field)} label="On field work" hint="On an approved request" />
        {today.weeklyOff > 0 && !everyoneOff ? (
          <StatCard value={count(today.weeklyOff)} label="Weekly off" hint="Their rest day" />
        ) : null}
        {today.currentlyIn !== null ? (
          <StatCard value={count(today.currentlyIn)} label="In right now" tone="accent" hint="Checked in, shift not over" />
        ) : null}
        {today.notCheckedOut !== null ? (
          <StatCard
            value={count(today.notCheckedOut)}
            label="Not checked out"
            tone={today.notCheckedOut > 0 ? 'warn' : 'default'}
            hint="Still checked in after their shift"
          />
        ) : null}
      </StatGrid>

      <h2 className="tc-section-title">Punches to look at</h2>
      <StatGrid>
        <StatCard
          value={count(today.missingPunches)}
          label="Missing punches"
          tone={today.missingPunches > 0 ? 'warn' : 'default'}
          icon="alert"
          hint="Forgotten check-outs, 7 days to this date"
        />
        <StatCard
          value={count(today.flaggedUnreviewed)}
          label="Flagged punches to review"
          tone={today.flaggedUnreviewed > 0 ? 'warn' : 'default'}
          icon="shield"
          hint="Mock location, clock or accuracy flags"
        />
      </StatGrid>

      <h2 className="tc-section-title tc-section-title--with-hint">Needs your attention</h2>
      <p className="tc-section-hint">As of now. The date above does not apply.</p>
      <AttentionCards pending={data.pending} />

      <h2 className="tc-section-title">{data.payroll ? 'Trend, headcount and payroll' : 'Trend and headcount'}</h2>
      <div className="tc-charts">
        <div className="tc-chart-grid">
          <AttendanceTrendCard trend={data.trend} isToday={data.isToday} />
          <DepartmentHeadcountCard headcount={headcount} wide={data.payroll === null} />
          {data.payroll ? <PayrollCard payroll={data.payroll} /> : null}
        </div>
      </div>
    </div>
  );
}
