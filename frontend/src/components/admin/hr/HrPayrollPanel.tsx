'use client';

import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { PayrollRunsTab } from './payroll/PayrollRunsTab';
import { SalaryStructuresTab, type StructuresTarget } from './payroll/SalaryStructuresTab';
import { RestrictedState } from './payroll/shared';

/**
 * Payroll: pay periods and their payslips, and the salary structures they are worked out
 * from. The API calls a pay period a payroll "run"; the screen never does.
 *
 * THE CYCLE, as the server enforces it:
 *   1. Every employee to be paid has a salary structure (Salary structures tab).
 *   2. A pay period is opened for a month. Its dates follow the pay cycle — the HR
 *      setting `payrollCycleStartDay`, the calendar month or e.g. 26th to 25th — and are
 *      fixed when it is opened.
 *   3. It can be calculated any time once it has started. While it is running the
 *      figures are "so far": they stop at the day of the calculation, and the days still
 *      to come are neither paid nor loss of pay. Recalculate as often as wanted.
 *   4. Once it has ended, a final recalculation covers every day; only then can it be
 *      approved, which freezes it and publishes the payslips to employees in the HR app.
 * Everybody employed in the period whom a calculation left out is listed on the period
 * by name, with the reason ("Not included"), so "0 employees" is never a mystery.
 *
 * ADMINISTRATORS ONLY, READS INCLUDED. Elsewhere in HR a supervisor may look; here what
 * would be read is everybody's salary, so the server answers every payroll request from
 * anyone below administrator with 403. The panel takes the first such answer as "this
 * account cannot open payroll" and shows that plainly, instead of an error per request.
 *
 * Both tabs stay mounted once opened, hidden when not shown, so that following "Set up
 * salary" from a pay period, setting the person up and coming back finds the period
 * still open where it was left.
 */

const TABS = [
  { key: 'runs', label: 'Pay periods' },
  { key: 'structures', label: 'Salary structures' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function HrPayrollPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>('runs');
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['runs']));
  const [restricted, setRestricted] = useState(false);

  /**
   * How the Salary structures tab starts. A new `key` remounts it with that target —
   * used when a pay period sends the administrator to somebody it left out.
   */
  const [structuresStart, setStructuresStart] = useState<{ key: number; target: StructuresTarget }>({
    key: 0,
    target: { setUp: 'all' },
  });

  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const onRestricted = useCallback(() => setRestricted(true), []);

  const choose = useCallback((next: Tab) => {
    setTab(next);
    setOpened((current) => (current.has(next) ? current : new Set([...current, next])));
  }, []);

  /**
   * Switches to Salary structures. With a target it starts afresh there (a filter, or one
   * employee opened); without one it is shown as it was left.
   */
  const openStructures = useCallback(
    (target?: StructuresTarget) => {
      if (target) setStructuresStart((current) => ({ key: current.key + 1, target }));
      choose('structures');
      // The button that was clicked is now inside a hidden panel; the tab it switched to
      // is where keyboard focus belongs (an employee opened there takes it in turn).
      tabRefs.current.structures?.focus();
    },
    [choose],
  );

  /** Arrow keys move between the tabs, as a tab list is expected to behave. */
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((item) => item.key === tab);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const next = TABS[nextIndex]?.key ?? 'runs';
    choose(next);
    tabRefs.current[next]?.focus();
  };

  if (restricted) return <RestrictedState />;

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Payroll">
          {TABS.map((item) => (
            <button
              key={item.key}
              ref={(element) => {
                tabRefs.current[item.key] = element;
              }}
              type="button"
              role="tab"
              id={`hr-pay-tab-${item.key}`}
              aria-controls={`hr-pay-panel-${item.key}`}
              aria-selected={tab === item.key}
              tabIndex={tab === item.key ? 0 : -1}
              className="admin-tab"
              onClick={() => choose(item.key)}
              onKeyDown={onTabKeyDown}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {opened.has('runs') ? (
        <div
          className="hr-pay"
          role="tabpanel"
          id="hr-pay-panel-runs"
          aria-labelledby="hr-pay-tab-runs"
          hidden={tab !== 'runs'}
        >
          <PayrollRunsTab
            onUnauthorized={onUnauthorized}
            onRestricted={onRestricted}
            onOpenStructures={openStructures}
          />
        </div>
      ) : null}

      {opened.has('structures') ? (
        <div
          className="hr-pay"
          role="tabpanel"
          id="hr-pay-panel-structures"
          aria-labelledby="hr-pay-tab-structures"
          hidden={tab !== 'structures'}
        >
          <SalaryStructuresTab
            key={structuresStart.key}
            initialSetUp={structuresStart.target.setUp}
            initialEmployee={structuresStart.target.employee}
            onUnauthorized={onUnauthorized}
            onRestricted={onRestricted}
          />
        </div>
      ) : null}
    </>
  );
}
