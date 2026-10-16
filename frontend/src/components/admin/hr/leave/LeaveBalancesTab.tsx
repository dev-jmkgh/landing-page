'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { todayIso } from '@/lib/telecalling';
import {
  formatDayCount,
  formatDays,
  leaveAdminApi,
  type HrEmployeeOption,
  type LeaveBalance,
} from '@/lib/hrLeave';
import { EmptyPanel, Tag, TableSkeleton } from '../../telecalling/shared';
import { AllocationDialog } from './AllocationDialog';
import { EmployeePicker } from './EmployeePicker';
import { YearSwitcher, isAbort, readFailure } from './shared';

/**
 * One employee's leave balances for one year, and the per-person allocations behind them.
 *
 * NEVER A ZERO FOR "NOT TRACKED". A type with no quota and no allocation has no balance
 * at all — the server sends `entitled` and `available` as null — and the table says
 * "Not tracked" in those cells. A 0 there would tell HR the person had used everything,
 * which is a different, false, statement. Used and pending are real counts either way.
 *
 * Only active leave-kind types appear: work from home and field work are arrangements,
 * never counted against a balance.
 */

export function LeaveBalancesTab({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [employee, setEmployee] = useState<HrEmployeeOption | null>(null);
  const [year, setYear] = useState(() => Number(todayIso().slice(0, 4)));

  const [items, setItems] = useState<LeaveBalance[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeaveBalance | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    if (!employee) {
      setItems(null);
      setLoadedFor(null);
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      const result = await leaveAdminApi.allocations(employee.id, year, controller.signal);
      setItems(result.items);
      setLoadedFor(`${employee.id}:${year}`);
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load the balances.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [employee, year, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const handleSaved = useCallback(
    (message: string) => {
      setEditing(null);
      setNotice(message);
      void load();
    },
    [load],
  );

  // The rows on screen belong to someone else while the next employee's are loading.
  const current = employee !== null && loadedFor === `${employee.id}:${year}`;

  return (
    <>
      <div className="admin-toolbar">
        <div className="hrl-balances-pick">
          <EmployeePicker
            label="Employee"
            value={employee}
            onChange={(next) => {
              setEmployee(next);
              setNotice(null);
              setError(null);
            }}
            onUnauthorized={onUnauthorized}
          />
        </div>

        <div className="admin-filters">
          <div className="field">
            <span className="field__label">Year</span>
            <YearSwitcher
              year={year}
              onChange={(next) => {
                setYear(next);
                setNotice(null);
              }}
              label="Balance year"
            />
          </div>
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => void load()}
            disabled={!employee}
          >
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {!employee ? (
        <EmptyPanel
          title="Choose an employee"
          message="Search for someone by name, email or employee code to see their leave balances for the year and set an allocation."
        />
      ) : items === null || !current ? (
        loading ? (
          <TableSkeleton rows={4} />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {items.length === 0 ? (
            <EmptyPanel
              title="No leave types to show"
              message="Balances are kept for active leave types of the kind “Leave”. Add or switch one on in the Leave types tab."
            />
          ) : (
            <DataTable
              rows={items}
              rowKey={(row) => row.leaveType.id}
              minWidth="60rem"
              caption={`Leave balances for ${employee.name} in ${year}`}
              columns={[
                {
                  key: 'type',
                  header: 'Leave type',
                  render: (row) => (
                    <CellStack
                      primary={row.leaveType.name}
                      secondary={
                        row.allocation
                          ? `Allocation${row.allocation.note ? `: ${row.allocation.note}` : ''}`
                          : row.leaveType.annualQuota !== null
                            ? `Quota ${formatDays(row.leaveType.annualQuota)} a year`
                            : 'No quota'
                      }
                    >
                      <span className="tc-mono tc-muted">{row.leaveType.code}</span>
                      {!row.leaveType.isPaid ? <Tag tone="warn">Unpaid</Tag> : null}
                      {row.allocation ? <Tag tone="progress">Override</Tag> : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'entitled',
                  header: 'Entitled',
                  align: 'end',
                  width: '7rem',
                  nowrap: true,
                  render: (row) =>
                    row.tracked && row.entitled !== null ? (
                      formatDayCount(row.entitled)
                    ) : (
                      <span className="tc-muted">Not tracked</span>
                    ),
                },
                {
                  key: 'used',
                  header: 'Used',
                  align: 'end',
                  width: '6rem',
                  nowrap: true,
                  render: (row) => formatDayCount(row.used),
                },
                {
                  key: 'pending',
                  header: 'Pending',
                  align: 'end',
                  width: '6rem',
                  nowrap: true,
                  render: (row) => formatDayCount(row.pending),
                },
                {
                  key: 'available',
                  header: 'Available',
                  align: 'end',
                  width: '8rem',
                  nowrap: true,
                  render: (row) =>
                    row.tracked && row.available !== null ? (
                      row.available < 0 ? (
                        <span className="tc-cell-bad">
                          {formatDayCount(row.available)} <span className="sr-only">(overdrawn)</span>
                        </span>
                      ) : (
                        <strong>{formatDayCount(row.available)}</strong>
                      )
                    ) : (
                      <span className="tc-muted">Not tracked</span>
                    ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '9rem',
                  nowrap: true,
                  render: (row) => (
                    <CellActions>
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        onClick={() => {
                          setNotice(null);
                          setEditing(row);
                        }}
                        aria-label={`Set the ${row.leaveType.name} allocation for ${employee.name}, ${year}`}
                      >
                        Set days
                      </button>
                    </CellActions>
                  ),
                },
              ]}
            />
          )}
        </LoadingOverlay>
      )}

      {employee && current && items && items.length > 0 ? (
        <p className="hrl-filter-hint">
          Used counts approved requests that start in {year}; pending requests count against what
          is available. “Not tracked” means the type has no quota and no allocation for this
          person, so there is no balance — not a balance of zero.
        </p>
      ) : null}

      {editing && employee ? (
        <AllocationDialog
          key={`${employee.id}-${year}-${editing.leaveType.id}`}
          employee={employee}
          year={year}
          balance={editing}
          onClose={closeEdit}
          onSaved={handleSaved}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
