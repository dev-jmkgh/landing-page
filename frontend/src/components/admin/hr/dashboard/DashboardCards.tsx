'use client';

import { useId } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { formatMonth } from '@/lib/hr';
import { formatRupees, type HrAdminDashboard } from '@/lib/hrReports';
import { BarChart } from '../../telecalling/shared';
import { count, plural } from '../reports/shared';
import { sectionLinkProps, type HrSectionKey } from './sectionLink';

/**
 * The HR dashboard's cards below the day's figures: what is waiting for a decision,
 * headcount by department, and — for administrators — the last approved payroll.
 */

/* -------------------------------------------------------------------------- */
/* Needs your attention                                                        */
/* -------------------------------------------------------------------------- */

type Queue = {
  key: keyof HrAdminDashboard['pending'];
  section: HrSectionKey;
  /** The section's own view parameters, so the card opens exactly the waiting list. */
  params?: Record<string, string>;
  title: string;
  icon: IconName;
  waiting: (value: number) => string;
  open: string;
};

const QUEUES: Queue[] = [
  {
    key: 'registrations',
    section: 'people',
    params: { peopleTab: 'pending' },
    title: 'Registrations',
    icon: 'users',
    waiting: (value) => `${plural(value, 'person', 'people')} waiting to be let in to the HR app`,
    open: 'Open Pending approval',
  },
  {
    key: 'regularisations',
    section: 'corrections',
    title: 'Attendance corrections',
    icon: 'file',
    waiting: (value) => `${plural(value, 'correction')} waiting for a decision`,
    open: 'Open Corrections',
  },
  {
    key: 'leave',
    section: 'leave',
    title: 'Leave requests',
    icon: 'calendar',
    waiting: (value) => `${plural(value, 'request')} waiting for a decision`,
    open: 'Open Leave',
  },
  {
    key: 'requests',
    section: 'requests',
    title: 'HR requests',
    icon: 'inbox',
    waiting: (value) => `${plural(value, 'request')} open or in progress`,
    open: 'Open Requests',
  },
];

/**
 * One card per queue, each a link to the section that clears it.
 *
 * All four are always shown, zero included: these are the same four places every
 * morning, and a card that appears and disappears moves the others around under the
 * reader's hand. A zero reads as calm ("Nothing waiting"), not as a figure to act on.
 */
export function AttentionCards({ pending }: { pending: HrAdminDashboard['pending'] }) {
  return (
    <ul className="hr-dash-attention" role="list">
      {QUEUES.map((queue) => {
        const value = pending[queue.key];
        const link = sectionLinkProps(queue.section, queue.params);
        return (
          <li key={queue.key}>
            <a
              className={value > 0 ? 'hr-dash-attention__card hr-dash-attention__card--waiting' : 'hr-dash-attention__card'}
              href={link.href}
              onClick={link.onClick}
            >
              <span className="hr-dash-attention__icon" aria-hidden="true">
                <Icon name={queue.icon} size={18} />
              </span>
              <span className="hr-dash-attention__body">
                <span className="hr-dash-attention__title">{queue.title}</span>
                <span className="hr-dash-attention__count">{count(value)}</span>
                <span className="hr-dash-attention__text">{value > 0 ? queue.waiting(value) : 'Nothing waiting'}</span>
                <span className="hr-dash-attention__open">
                  {queue.open}
                  <Icon name="arrowRight" size={14} />
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Headcount by department                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A ranked comparison of one measure, so the plain-HTML `BarChart` rather than a chart
 * library: it reads correctly in a screen reader as a list of names and numbers, and
 * adds nothing to the bundle.
 */
export function DepartmentHeadcountCard({
  headcount,
  wide,
}: {
  headcount: HrAdminDashboard['headcount'];
  wide: boolean;
}) {
  const titleId = useId();
  const ranked = [...headcount.byDepartment].sort((a, b) => {
    // People with no department recorded go last whatever their number: they are a gap
    // in the records, not a department competing with the others.
    if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1;
    return b.count - a.count || (a.name ?? '').localeCompare(b.name ?? '');
  });

  return (
    <section className={wide ? 'tc-chart-card tc-chart-card--wide' : 'tc-chart-card'} aria-labelledby={titleId}>
      <header className="tc-chart-card__head">
        <div className="tc-chart-card__heading">
          <h3 id={titleId} className="tc-chart-card__title">
            Headcount by department
          </h3>
          <p className="tc-chart-card__sub">
            {plural(headcount.total, 'active employee')} with an approved account, as of now.
          </p>
        </div>
      </header>
      <div className="tc-chart-card__body">
        {ranked.length === 0 ? (
          <p className="tc-muted">Nobody has an approved, active account yet.</p>
        ) : (
          <BarChart
            data={ranked.map((row) => ({ label: row.name ?? 'No department recorded', value: row.count }))}
            primaryLabel="Employees"
            formatValue={count}
          />
        )}
      </div>
      <footer className="tc-chart-card__foot">
        <span>Departments are managed under Organisation.</span>
        <a className="tc-link" {...sectionLinkProps('organisation')}>
          Open Organisation
        </a>
      </footer>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Payroll                                                                     */
/* -------------------------------------------------------------------------- */

/** Administrators only: the server sends `payroll: null` to anyone else, and this is not rendered. */
export function PayrollCard({ payroll }: { payroll: NonNullable<HrAdminDashboard['payroll']> }) {
  const titleId = useId();
  const last = payroll.lastApproved;

  return (
    <section className="tc-chart-card" aria-labelledby={titleId}>
      <header className="tc-chart-card__head">
        <div className="tc-chart-card__heading">
          <h3 id={titleId} className="tc-chart-card__title">
            Payroll
          </h3>
          <p className="tc-chart-card__sub">The most recent approved pay period. Visible to administrators only.</p>
        </div>
      </header>
      <div className="tc-chart-card__body">
        {last ? (
          <dl className="hr-dash-facts">
            <div>
              <dt>Last approved</dt>
              <dd>{formatMonth(last.period)}</dd>
            </div>
            <div>
              <dt>Employees paid</dt>
              <dd>{count(last.employeeCount)}</dd>
            </div>
            <div>
              <dt>Total net pay</dt>
              <dd className="hr-dash-facts__money">{formatRupees(last.totalNet)}</dd>
            </div>
          </dl>
        ) : (
          <p className="tc-muted">No pay period has been approved yet.</p>
        )}
      </div>
      <footer className="tc-chart-card__foot">
        <span>{last ? 'Payslips for this period are visible to employees in the HR app.' : null}</span>
        <a className="tc-link" {...sectionLinkProps('payroll')}>
          Open Payroll
        </a>
      </footer>
    </section>
  );
}
