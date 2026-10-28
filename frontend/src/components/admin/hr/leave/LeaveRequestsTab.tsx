'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import type { HrPaginated } from '@/lib/hr';
import {
  HALF_DAY_LABELS,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUS_TONE,
  formatDayCount,
  formatLeaveRange,
  leaveAdminApi,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
} from '@/lib/hrLeave';
import { DateTimeCell, EmptyPanel, Pager, Tag, TableSkeleton } from '../../telecalling/shared';
import { LeaveRequestDialog, type LeaveDecisionIntent } from './LeaveRequestDialog';
import { isAbort, pageCount, readFailure } from './shared';

/**
 * The leave queue: every request, pending first and oldest first within them, so the
 * one that has waited longest is at the top.
 *
 * Decisions go through the request dialog rather than straight from the row, because a
 * decision needs the dates, the day count and the balance in view — and a rejection
 * needs a reason the employee will read.
 */

const PAGE_SIZE = 20;

const STATUS_FILTERS: { key: LeaveStatus | 'all'; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

export function LeaveRequestsTab({
  pendingCount,
  onCountChanged,
  onUnauthorized,
}: {
  pendingCount: number | null;
  /** A decision changed the pending count; the panel refreshes its badge. */
  onCountChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [status, setStatus] = useState<LeaveStatus | 'all'>('pending');
  const [typeId, setTypeId] = useState<number | 'all'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [data, setData] = useState<HrPaginated<LeaveRequest> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<{ request: LeaveRequest; intent: LeaveDecisionIntent } | null>(null);

  const abort = useRef<AbortController | null>(null);

  /* The search box, debounced; the page resets only when the settled text changes. */
  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;
    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  /* Types for the filter, inactive ones included — old requests still carry them. */
  useEffect(() => {
    const controller = new AbortController();
    leaveAdminApi
      .listTypes(controller.signal)
      .then(setTypes)
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        // The filter can do without its options; the list itself still loads.
        readFailure(caught, onUnauthorized, '');
        setTypes([]);
      });
    return () => controller.abort();
  }, [onUnauthorized]);

  /* An inverted range is not sent: it would match nothing and look like an empty queue. */
  const rangeError = from && to && from > to ? 'The "from" date is after the "to" date.' : null;

  const query = useMemo(
    () => ({
      status,
      leaveTypeId: typeId === 'all' ? undefined : typeId,
      from: rangeError ? undefined : from || undefined,
      to: rangeError ? undefined : to || undefined,
      q: debounced || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [status, typeId, from, to, rangeError, debounced, page],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await leaveAdminApi.listRequests(query, controller.signal);
      // Past the end — the last row of the last page was just decided away: step back.
      if (result.items.length === 0 && result.total > 0 && query.page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load leave requests.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [query, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const closeDialog = useCallback(() => setOpen(null), []);

  const handleDecided = useCallback(
    (_decided: LeaveRequest, message: string) => {
      setOpen(null);
      setNotice(message);
      onCountChanged();
      // Reloaded rather than patched: on the Pending filter the row leaves the list.
      void load();
    },
    [load, onCountChanged],
  );

  const filtered = typeId !== 'all' || from !== '' || to !== '' || debounced !== '';

  const clearFilters = () => {
    setTypeId('all');
    setFrom('');
    setTo('');
    setSearch('');
    setDebounced('');
    setPage(1);
  };

  const empty =
    status === 'pending' && !filtered
      ? {
          title: 'Nothing waiting',
          message: 'When an employee applies for leave in the HR app, the request appears here.',
        }
      : {
          title: 'No leave requests here',
          message: filtered
            ? 'Nothing matches these filters. Clear them to see more.'
            : 'No requests have this status yet.',
        };

  return (
    <>
      <div className="admin-toolbar">
        <div className="tc-segmented" role="group" aria-label="Leave request status">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              className="tc-segmented__button"
              aria-pressed={status === option.key}
              onClick={() => {
                if (option.key === status) return;
                setStatus(option.key);
                setPage(1);
              }}
            >
              {option.label}
              {option.key === 'pending' && pendingCount !== null && pendingCount > 0 ? (
                <span className="hrl-count">
                  {pendingCount}
                  <span className="sr-only"> waiting</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hrl-req-search">
              Search
            </label>
            <input
              id="hrl-req-search"
              className="input"
              type="search"
              value={search}
              placeholder="Name, email or code"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '13rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hrl-req-type">
              Type
            </label>
            <select
              id="hrl-req-type"
              className="select"
              value={String(typeId)}
              onChange={(event) => {
                setTypeId(event.target.value === 'all' ? 'all' : Number(event.target.value));
                setPage(1);
              }}
            >
              <option value="all">Every type</option>
              {(types ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                  {type.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </div>

          <div className={`field${rangeError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor="hrl-req-from">
              From
            </label>
            <input
              id="hrl-req-from"
              className="input"
              type="date"
              value={from}
              aria-describedby={rangeError ? 'hrl-req-range-error' : undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className={`field${rangeError ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor="hrl-req-to">
              To
            </label>
            <input
              id="hrl-req-to"
              className="input"
              type="date"
              value={to}
              aria-describedby={rangeError ? 'hrl-req-range-error' : undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {rangeError ? (
        <p className="field__error hrl-filter-error" id="hrl-req-range-error" role="alert">
          <Icon name="alert" size={14} />
          {rangeError} The dates are ignored until that is fixed.
        </p>
      ) : (
        <p className="hrl-filter-hint">
          {from || to
            ? 'Showing requests whose dates overlap the range.'
            : 'Pending requests come first, the longest-waiting at the top.'}
        </p>
      )}

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {data.items.length === 0 ? (
            <EmptyPanel
              title={empty.title}
              message={empty.message}
              actionLabel={filtered ? 'Clear filters' : undefined}
              onAction={filtered ? clearFilters : undefined}
            />
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.id}
              minWidth="74rem"
              caption="Leave requests, with the employee, dates, days, reason, status and actions"
              onRowDoubleClick={(row) => setOpen({ request: row, intent: 'view' })}
              rowTitle={() => 'Double-click to open the request'}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  width: '13rem',
                  render: (row) => (
                    <CellStack
                      primary={
                        <button
                          type="button"
                          className="tc-link-button"
                          onClick={() => setOpen({ request: row, intent: 'view' })}
                        >
                          {row.employeeName}
                        </button>
                      }
                    >
                      <span className="tc-muted tc-mono">{row.employeeCode}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'type',
                  header: 'Type',
                  width: '10rem',
                  render: (row) => (
                    <CellStack primary={row.leaveType.name}>
                      {row.leaveType.kind !== 'leave' ? (
                        <Tag tone="progress">{LEAVE_KIND_LABELS[row.leaveType.kind]}</Tag>
                      ) : null}
                      {!row.leaveType.isPaid ? <Tag tone="warn">Unpaid</Tag> : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'dates',
                  header: 'Dates',
                  width: '12rem',
                  render: (row) => (
                    <CellStack
                      primary={formatLeaveRange(row.startDate, row.endDate)}
                      secondary={
                        row.compOffEarnedOn
                          ? `For working ${formatLeaveRange(row.compOffEarnedOn, row.compOffEarnedOn)}`
                          : row.halfDay !== 'none'
                            ? HALF_DAY_LABELS[row.halfDay]
                            : undefined
                      }
                    />
                  ),
                },
                {
                  key: 'days',
                  header: 'Days',
                  align: 'end',
                  width: '5rem',
                  nowrap: true,
                  render: (row) => formatDayCount(row.days),
                },
                {
                  /* No width: the column that absorbs whatever space is left. */
                  key: 'reason',
                  header: 'Reason',
                  render: (row) => (
                    <CellStack
                      primary={
                        <span className="tc-note" title={row.reason}>
                          {row.reason}
                        </span>
                      }
                      secondary={row.reviewNote ? `Note: ${row.reviewNote}` : undefined}
                    />
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '10rem',
                  render: (row) => (
                    <CellStack
                      primary={
                        <Tag tone={LEAVE_STATUS_TONE[row.status]}>{LEAVE_STATUS_LABELS[row.status]}</Tag>
                      }
                      secondary={
                        row.reviewerName && (row.status === 'approved' || row.status === 'rejected')
                          ? `by ${row.reviewerName}`
                          : undefined
                      }
                    />
                  ),
                },
                {
                  key: 'applied',
                  header: 'Applied',
                  width: '7.5rem',
                  render: (row) => <DateTimeCell value={row.createdAt} />,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '12.5rem',
                  render: (row) => (
                    <CellActions>
                      {row.status === 'pending' ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => setOpen({ request: row, intent: 'approve' })}
                            aria-label={`Approve ${row.employeeName}'s ${row.leaveType.name.toLowerCase()}`}
                          >
                            <Icon name="check" size={15} />
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setOpen({ request: row, intent: 'reject' })}
                            aria-label={`Reject ${row.employeeName}'s ${row.leaveType.name.toLowerCase()}`}
                          >
                            Reject
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => setOpen({ request: row, intent: 'view' })}
                          aria-label={`View ${row.employeeName}'s request`}
                        >
                          View
                        </button>
                      )}
                    </CellActions>
                  ),
                },
              ]}
            />
          )}
        </LoadingOverlay>
      )}

      {data && data.items.length > 0 ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="request"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {open ? (
        <LeaveRequestDialog
          key={`${open.request.id}-${open.intent}`}
          request={open.request}
          intent={open.intent}
          onClose={closeDialog}
          onDecided={handleDecided}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
