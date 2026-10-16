'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { EmptyPanel, Tag, TableSkeleton } from '@/components/admin/telecalling/shared';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import { todayIso } from '@/lib/telecalling';
import { formatDays, peopleApi, type HrEmployee, type HrLeaveBalance } from '@/lib/hr';
import { isAbort } from './shared';

/**
 * An employee's leave balances for one year — a read-only summary.
 *
 * Entitlements are changed in the Leave section, which owns allocations; this tab only
 * reads them, so there is one place an entitlement can be edited and one audit trail.
 *
 * An UNTRACKED type has no balance at all, and the table says "Not tracked" rather than
 * printing 0: zero would claim they have used up an allowance that does not exist. Days
 * used are still shown, because those are real approved requests.
 */
export function EmployeeLeaveTab({
  employee,
  onUnauthorized,
}: {
  employee: HrEmployee;
  onUnauthorized: () => void;
}) {
  const thisYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [items, setItems] = useState<HrLeaveBalance[] | null>(null);
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
      const result = await peopleApi.leaveBalances(employee.id, year, controller.signal);
      setItems(result.items);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load leave balances.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [employee.id, year, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  return (
    <div className="hrp-tab-body">
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor={`hr-emp-leave-year-${employee.id}`}>
              Year
            </label>
            <select
              id={`hr-emp-leave-year-${employee.id}`}
              className="select"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {[thisYear - 1, thisYear, thisYear + 1].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="tc-muted hrp-toolbar-note">Entitlements are set in the Leave section.</p>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {items === null ? (
        loading ? (
          <TableSkeleton rows={4} />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {items.length === 0 ? (
            <EmptyPanel
              title="No leave types"
              message="Leave types with balances appear here once they are set up in the Leave section."
            />
          ) : (
            <DataTable
              rows={items}
              rowKey={(row) => row.leaveType.id}
              minWidth="52rem"
              caption={`${employee.name}’s leave balances for ${year}`}
              columns={[
                {
                  key: 'type',
                  header: 'Leave type',
                  render: (row) => (
                    <CellStack
                      primary={row.leaveType.name}
                      secondary={
                        row.allocation
                          ? `Set for ${year}${row.allocation.note ? ` — ${row.allocation.note}` : ''}`
                          : row.tracked
                            ? 'From the yearly quota'
                            : undefined
                      }
                    >
                      <span className="tc-muted tc-mono">{row.leaveType.code}</span>
                      {row.leaveType.isPaid ? null : <Tag>Unpaid</Tag>}
                    </CellStack>
                  ),
                },
                {
                  key: 'entitled',
                  header: 'Entitled',
                  width: '8rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) =>
                    row.entitled === null ? (
                      <span className="tc-muted">Not tracked</span>
                    ) : (
                      formatDays(row.entitled)
                    ),
                },
                {
                  key: 'used',
                  header: 'Used',
                  width: '6rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) => formatDays(row.used),
                },
                {
                  key: 'pending',
                  header: 'Waiting',
                  width: '6rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) =>
                    row.pending > 0 ? formatDays(row.pending) : <span className="tc-muted">0</span>,
                },
                {
                  key: 'available',
                  header: 'Available',
                  width: '8rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) =>
                    row.available === null ? (
                      <span className="tc-muted">—</span>
                    ) : row.available < 0 ? (
                      <span className="tc-cell-bad" title="More was approved than the entitlement allows.">
                        {formatDays(row.available)}
                      </span>
                    ) : (
                      formatDays(row.available)
                    ),
                },
              ]}
            />
          )}
          <p className="tc-muted hrp-caption">
            Days, for requests starting in {year}. Waiting counts requests not yet decided; they
            are held against what is available.
          </p>
        </LoadingOverlay>
      )}
    </div>
  );
}
