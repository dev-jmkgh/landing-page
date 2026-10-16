'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import type { HrPaginated } from '@/lib/hr';
import {
  HR_REQUEST_CATEGORIES,
  HR_REQUEST_CATEGORY_LABELS,
  HR_REQUEST_STATUS_LABELS,
  HR_REQUEST_STATUS_TONE,
  hrRequestsApi,
  type HrRequest,
  type HrRequestCategory,
  type HrRequestStatusFilter,
} from '@/lib/hrRequests';
import { DateTimeCell, EmptyPanel, Pager, Tag, TableSkeleton } from '../../telecalling/shared';
import { isAbort, pageCount, readFailure } from '../leave/shared';

/**
 * The HR request queue: open first, then in progress, the oldest first within each —
 * the request that has waited longest is at the top.
 *
 * "Waiting" (open + in progress) is the default view: that is HR's to-do list. Closed
 * requests stay reachable for the record.
 */

const PAGE_SIZE = 20;

const STATUS_FILTERS: { key: HrRequestStatusFilter; label: string }[] = [
  { key: 'active', label: 'Waiting' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export function RequestQueue({
  counts,
  refreshKey,
  onOpen,
  onUnauthorized,
}: {
  counts: { open: number; inProgress: number } | null;
  /** Bumped by the panel when a request changed elsewhere; the page is re-read. */
  refreshKey: number;
  onOpen: (request: HrRequest, opener: HTMLElement | null) => void;
  onUnauthorized: () => void;
}) {
  const [status, setStatus] = useState<HrRequestStatusFilter>('active');
  const [category, setCategory] = useState<HrRequestCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<HrPaginated<HrRequest> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;
    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  const query = useMemo(
    () => ({ status, category, q: debounced || undefined, page, pageSize: PAGE_SIZE }),
    [status, category, debounced, page],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      const result = await hrRequestsApi.listRequests(query, controller.signal);
      if (result.items.length === 0 && result.total > 0 && query.page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load HR requests.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [query, onUnauthorized]);

  useEffect(() => {
    void load();
    // `refreshKey` is a deliberate dependency: a change elsewhere re-reads this page.
  }, [load, refreshKey]);

  useEffect(() => () => abort.current?.abort(), []);

  const filtered = category !== 'all' || debounced !== '';

  const empty =
    status === 'active' && !filtered
      ? {
          title: 'Nothing waiting',
          message: 'When an employee raises a request in the HR app — a letter, a correction to their details — it appears here.',
        }
      : {
          title: 'No requests here',
          message: filtered ? 'Nothing matches these filters. Clear them to see more.' : 'No requests have this status.',
        };

  return (
    <>
      <div className="admin-toolbar">
        <div className="tc-segmented" role="group" aria-label="Request status">
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
              {option.key === 'active' && counts && counts.open > 0 ? (
                <span className="hrl-count">
                  {counts.open}
                  <span className="sr-only"> new</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hrr-search">
              Search
            </label>
            <input
              id="hrr-search"
              className="input"
              type="search"
              value={search}
              placeholder="Subject, name or code"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '13rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hrr-category">
              Category
            </label>
            <select
              id="hrr-category"
              className="select"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as HrRequestCategory | 'all');
                setPage(1);
              }}
            >
              <option value="all">Every category</option>
              {HR_REQUEST_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {HR_REQUEST_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {counts ? (
        <p className="hrl-filter-hint">
          {counts.open} new · {counts.inProgress} in progress. New requests come first, the
          longest-waiting at the top.
        </p>
      ) : null}

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

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
              onAction={
                filtered
                  ? () => {
                      setCategory('all');
                      setSearch('');
                      setDebounced('');
                      setPage(1);
                    }
                  : undefined
              }
            />
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.id}
              rowTone={(row) => (row.status === 'open' ? 'warn' : undefined)}
              minWidth="64rem"
              caption="HR requests, with subject, employee, status and last activity"
              onRowDoubleClick={(row) => onOpen(row, null)}
              rowTitle={() => 'Double-click to open the request'}
              columns={[
                {
                  /* No width: the subject absorbs whatever space is left. */
                  key: 'request',
                  header: 'Request',
                  render: (row) => (
                    <CellStack
                      primary={
                        <button
                          type="button"
                          className="tc-link-button hrl-subject-link"
                          onClick={(event) => onOpen(row, event.currentTarget)}
                        >
                          {row.subject}
                        </button>
                      }
                      secondary={
                        row.details ? (
                          <span className="tc-note" title={row.details}>
                            {row.details}
                          </span>
                        ) : undefined
                      }
                    >
                      <span className="tc-mono tc-muted">#{row.id}</span>
                      <Tag>{HR_REQUEST_CATEGORY_LABELS[row.category]}</Tag>
                      {row.commentCount > 0 ? (
                        <span className="tc-muted">
                          {row.commentCount} {row.commentCount === 1 ? 'message' : 'messages'}
                        </span>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'employee',
                  header: 'Employee',
                  width: '13rem',
                  render: (row) => (
                    <CellStack primary={row.employeeName}>
                      <span className="tc-mono tc-muted">{row.employeeCode}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '9rem',
                  render: (row) => (
                    <CellStack
                      primary={
                        <Tag tone={HR_REQUEST_STATUS_TONE[row.status]}>{HR_REQUEST_STATUS_LABELS[row.status]}</Tag>
                      }
                      secondary={
                        row.resolvedByName && (row.status === 'resolved' || row.status === 'rejected')
                          ? `by ${row.resolvedByName}`
                          : undefined
                      }
                    />
                  ),
                },
                {
                  key: 'activity',
                  header: 'Last activity',
                  width: '8rem',
                  render: (row) => <DateTimeCell value={row.lastActivityAt} />,
                },
                {
                  key: 'raised',
                  header: 'Raised',
                  width: '8rem',
                  render: (row) => <DateTimeCell value={row.createdAt} />,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '7rem',
                  nowrap: true,
                  render: (row) => (
                    <CellActions>
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        onClick={(event) => onOpen(row, event.currentTarget)}
                        aria-label={`Open request #${row.id}: ${row.subject}`}
                      >
                        Open
                      </button>
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
    </>
  );
}
