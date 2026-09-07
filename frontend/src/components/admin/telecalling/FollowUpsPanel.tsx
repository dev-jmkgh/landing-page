'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  formatDateTime,
  telecallingApi,
  type Employee,
  type FollowUp,
  type FollowUpScope,
  type Paginated,
} from '@/lib/telecalling';
import { EmptyPanel, LeadStatusBadge, Pager, Tag, TableSkeleton, downloadCsv } from './shared';

/**
 * Follow-up management (spec: Admin Module 8).
 *
 * The scopes are date windows over the pending state, computed server-side — there is no
 * stored "overdue" flag to go stale. An admin can complete, reschedule, cancel and
 * reassign from here without opening each lead.
 */

const PAGE_SIZE = 25;

const SCOPES: { key: FollowUpScope; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'pending', label: 'All pending' },
  { key: 'completed', label: 'Completed' },
];

export function FollowUpsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [scope, setScope] = useState<FollowUpScope>('overdue');
  const [assignedTo, setAssignedTo] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<Paginated<FollowUp> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [scope, assignedTo, debounced]);

  useEffect(() => {
    let cancelled = false;
    telecallingApi
      .assignableEmployees()
      .then((rows) => {
        if (!cancelled) setEmployees(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const query = useMemo(
    () => ({ scope, page, pageSize: PAGE_SIZE, assignedTo, q: debounced || undefined }),
    [scope, page, assignedTo, debounced],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(await telecallingApi.listFollowUps(query, controller.signal));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load follow-ups.');
    } finally {
      setLoading(false);
    }
  }, [query, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  /* ------------------------------------------------------------------ actions */

  const replaceRow = (updated: FollowUp) => {
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((row) => (row.id === updated.id ? updated : row)),
          }
        : current,
    );
  };

  const act = async (id: number, action: () => Promise<FollowUp>, message: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);

    try {
      replaceRow(await action());
      setNotice(message);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not update the follow-up.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Pushes a follow-up out by whole days from now.
   *
   * Relative rather than absolute, because that is how the decision is actually made:
   * "give them another week", not "move it to the 14th". A date picker per row would be
   * five controls in a table cell.
   */
  const postpone = (followUp: FollowUp, days: number) => {
    const next = new Date();
    next.setDate(next.getDate() + days);
    next.setHours(10, 0, 0, 0);

    return act(
      followUp.id,
      () => telecallingApi.rescheduleFollowUp(followUp.id, next.toISOString(), followUp.note),
      `Moved to ${formatDateTime(next.toISOString())}.`,
    );
  };

  const reassign = async (followUp: FollowUp, value: string) => {
    setBusyId(followUp.id);
    setError(null);
    setNotice(null);

    try {
      const result = await telecallingApi.updateFollowUp(followUp.id, {
        assignedTo: Number(value),
      });
      replaceRow(result.followUp);
      setNotice(`Reassigned to ${result.followUp.assignedToName ?? 'another employee'}.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not reassign the follow-up.');
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = () => {
    if (!data) return;

    downloadCsv(
      `jmk-followups-${scope}-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Due',
        'State',
        'Overdue',
        'Customer',
        'Number',
        'Reference',
        'Lead status',
        'Assigned to',
        'Note',
        'Times rescheduled',
        'Completed',
        'Completed by',
      ],
      data.items.map((row) => [
        formatDateTime(row.dueAt),
        row.state,
        row.isOverdue ? 'Yes' : 'No',
        row.leadName,
        row.leadPhone,
        row.leadReference,
        row.leadStatus,
        row.assignedToName ?? 'Unassigned',
        row.note,
        row.rescheduleCount,
        formatDateTime(row.completedAt),
        row.completedByName,
      ]),
    );
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Follow-up scope">
          {SCOPES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={scope === option.key}
              onClick={() => setScope(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="tc-fu-search">
              Search
            </label>
            <input
              id="tc-fu-search"
              className="input"
              type="search"
              value={search}
              placeholder="Customer, number or note"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '15rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-fu-owner">
              Assigned to
            </label>
            <select
              id="tc-fu-owner"
              className="select"
              value={String(assignedTo)}
              onChange={(event) =>
                setAssignedTo(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
            >
              <option value="all">Everyone</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          <button
            type="button"
            className="btn btn--outline"
            onClick={exportCsv}
            disabled={!data || data.items.length === 0}
          >
            <Icon name="download" size={16} />
            Export page
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data || data.items.length === 0 ? (
        <EmptyPanel
          title={scope === 'overdue' ? 'Nothing overdue' : 'No follow-ups here'}
          message={
            scope === 'overdue'
              ? 'Every follow-up is on schedule.'
              : 'Nothing matches this scope and filter.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Due</th>
                <th scope="col">Customer</th>
                <th scope="col">Assigned to</th>
                <th scope="col">Note</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.id} aria-busy={busyId === row.id}>
                  <td className={row.isOverdue ? 'tc-cell-bad' : undefined}>
                    {formatDateTime(row.dueAt)}
                    {row.isOverdue ? (
                      <>
                        <br />
                        <Tag tone="bad">Overdue</Tag>
                      </>
                    ) : null}
                    {row.rescheduleCount > 0 ? (
                      <>
                        <br />
                        {/*
                          Worth showing: a follow-up postponed four times is usually a lead
                          that needs a different conversation, not a fifth reminder.
                        */}
                        <span className="tc-muted">
                          Moved {row.rescheduleCount}{' '}
                          {row.rescheduleCount === 1 ? 'time' : 'times'}
                        </span>
                      </>
                    ) : null}
                  </td>

                  <td>
                    <strong>{row.leadName}</strong>
                    <br />
                    <span className="tc-muted">{row.leadPhone}</span>
                    <br />
                    <LeadStatusBadge status={row.leadStatus} />
                  </td>

                  <td>
                    {row.state === 'pending' ? (
                      <select
                        className="select select--sm"
                        value={row.assignedTo === null ? '' : String(row.assignedTo)}
                        disabled={busyId === row.id}
                        onChange={(event) => void reassign(row, event.target.value)}
                        aria-label={`Reassign the follow-up for ${row.leadName}`}
                      >
                        {row.assignedTo === null ? <option value="">Unassigned</option> : null}
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (row.assignedToName ?? '—')
                    )}
                  </td>

                  <td>
                    {row.note ?? <span className="tc-muted">—</span>}
                    {row.state === 'completed' ? (
                      <>
                        <br />
                        <Tag tone="good">
                          Done {formatDateTime(row.completedAt)}
                          {row.completedByName ? ` by ${row.completedByName}` : ''}
                        </Tag>
                        {row.outcomeNote ? (
                          <>
                            <br />
                            <span className="tc-muted">{row.outcomeNote}</span>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </td>

                  <td>
                    {row.state === 'pending' ? (
                      <div className="tc-row-actions">
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row.id,
                              () => telecallingApi.completeFollowUp(row.id),
                              'Marked as completed.',
                            )
                          }
                        >
                          Complete
                        </button>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => void postpone(row, 1)}
                        >
                          +1 day
                        </button>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => void postpone(row, 7)}
                        >
                          +1 week
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row.id,
                              () => telecallingApi.cancelFollowUp(row.id),
                              'Follow-up cancelled.',
                            )
                          }
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="tc-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          noun="follow-up"
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
