'use client';

import { useCallback, useEffect, useState } from 'react';
import { leaveAdminApi } from '@/lib/hrLeave';
import { HolidaysTab } from './leave/HolidaysTab';
import { LeaveBalancesTab } from './leave/LeaveBalancesTab';
import { LeaveRequestsTab } from './leave/LeaveRequestsTab';
import { LeaveTypesTab } from './leave/LeaveTypesTab';
import { readUrlEnum, useUrlParam } from './leave/shared';

/**
 * Leave and holidays, for HR.
 *
 * Four tabs over one subject: the requests waiting on a decision, each employee's
 * balances (and the allocations that override a type's quota), the leave types
 * themselves, and the holiday calendar every one of those is counted against.
 *
 * Requests first and by default — that is the daily work; the other three are set-up
 * that changes a few times a year. Each tab is mounted only while visible, like the
 * sections themselves, so its requests abort on switch and it refetches on return. The
 * tab is kept in the address (`?leaveTab=`), so a refresh or Back reopens it.
 *
 * Reads are open to supervisors; every change is administrator-only, and the server
 * refuses a supervisor's write with a 403 that each tab names as such.
 */

const TABS = [
  { key: 'requests', label: 'Requests' },
  { key: 'balances', label: 'Balances' },
  { key: 'types', label: 'Leave types' },
  { key: 'holidays', label: 'Holidays' },
] as const;

type Tab = (typeof TABS)[number]['key'];
const TAB_KEYS = TABS.map((tab) => tab.key);

export function HrLeavePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>(() => readUrlEnum('leaveTab', TAB_KEYS, 'requests'));
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  useUrlParam('leaveTab', tab === 'requests' ? null : tab);

  /**
   * The badge, loaded separately and allowed to fail quietly: a missing badge is a far
   * smaller problem than an error banner over a working screen.
   */
  const refreshCount = useCallback(async () => {
    try {
      setPendingCount(await leaveAdminApi.pendingCount());
    } catch {
      setPendingCount(null);
    }
  }, []);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  const onCountChanged = useCallback(() => void refreshCount(), [refreshCount]);

  return (
    <>
      <div className="hrl-subnav">
        <div className="admin-tabs" role="tablist" aria-label="Leave and holidays">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`hrl-tab-${item.key}`}
              aria-controls="hrl-tabpanel"
              className="admin-tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
              {item.key === 'requests' && pendingCount !== null && pendingCount > 0 ? (
                <span className="tc-tab-count">
                  {pendingCount}
                  <span className="sr-only"> pending</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div id="hrl-tabpanel" role="tabpanel" aria-labelledby={`hrl-tab-${tab}`}>
        {tab === 'requests' ? (
          <LeaveRequestsTab
            pendingCount={pendingCount}
            onCountChanged={onCountChanged}
            onUnauthorized={onUnauthorized}
          />
        ) : null}
        {tab === 'balances' ? <LeaveBalancesTab onUnauthorized={onUnauthorized} /> : null}
        {tab === 'types' ? <LeaveTypesTab onUnauthorized={onUnauthorized} /> : null}
        {tab === 'holidays' ? <HolidaysTab onUnauthorized={onUnauthorized} /> : null}
      </div>
    </>
  );
}
