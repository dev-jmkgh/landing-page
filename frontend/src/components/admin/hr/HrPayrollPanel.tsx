'use client';

import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { PayrollRunsTab } from './payroll/PayrollRunsTab';
import { SalaryStructuresTab, type SetUpFilter } from './payroll/SalaryStructuresTab';
import { RestrictedState } from './payroll/shared';

/**
 * Payroll: monthly runs and their payslips, and the salary structures they are computed
 * from.
 *
 * THE MONTHLY CYCLE, as the server enforces it:
 *   1. Every employee to be paid has a salary structure (Salary structures tab).
 *   2. A run is created for a month (a draft), and processed once the month is over —
 *      the server computes every payslip from attendance, leave and the structures.
 *   3. The administrator checks the payslips (each opens to its day counts and lines,
 *      and to its PDF), processes again if anything was corrected, and approves.
 *   4. Approval freezes the run and publishes the payslips to employees in the HR app.
 *
 * ADMINISTRATORS ONLY, READS INCLUDED. Elsewhere in HR a supervisor may look; here what
 * would be read is everybody's salary, so the server answers every payroll request from
 * anyone below administrator with 403. The panel takes the first such answer as "this
 * account cannot open payroll" and shows that plainly, instead of an error per request.
 *
 * Both tabs stay mounted once opened, hidden when not shown, so that following "N people
 * have no salary structure" from a run, setting them up and coming back finds the run
 * still open where it was left.
 */

const TABS = [
  { key: 'runs', label: 'Runs' },
  { key: 'structures', label: 'Salary structures' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function HrPayrollPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>('runs');
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['runs']));
  const [restricted, setRestricted] = useState(false);

  /**
   * How the Salary structures tab starts. A new `key` remounts it with that filter —
   * used when a run sends the administrator to the people it left out.
   */
  const [structuresStart, setStructuresStart] = useState<{ key: number; setUp: SetUpFilter }>({
    key: 0,
    setUp: 'all',
  });

  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const onRestricted = useCallback(() => setRestricted(true), []);

  const choose = useCallback((next: Tab) => {
    setTab(next);
    setOpened((current) => (current.has(next) ? current : new Set([...current, next])));
  }, []);

  const openMissingStructures = useCallback(() => {
    setStructuresStart((current) => ({ key: current.key + 1, setUp: 'false' }));
    choose('structures');
    // The link that was clicked is now inside a hidden panel; the tab it switched to is
    // where keyboard focus belongs.
    tabRefs.current.structures?.focus();
  }, [choose]);

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
            onOpenStructures={openMissingStructures}
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
            initialSetUp={structuresStart.setUp}
            onUnauthorized={onUnauthorized}
            onRestricted={onRestricted}
          />
        </div>
      ) : null}
    </>
  );
}
