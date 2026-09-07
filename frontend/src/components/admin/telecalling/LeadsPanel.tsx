'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  formatDate,
  formatDateTime,
  humanise,
  telecallingApi,
  type Employee,
  type Lead,
  type LeadQuery,
  type LeadStatus,
  type Paginated,
} from '@/lib/telecalling';
import { EmptyPanel, LeadStatusBadge, Pager, TableSkeleton, downloadCsv } from './shared';

/**
 * Lead management and assignment (spec: Admin Modules 4 and 5).
 *
 * The two modules share one screen because they are the same task: an admin looking at
 * the lead list is deciding who works what. Splitting them would mean filtering twice —
 * once to find the leads, again on an assignment screen to find them a second time.
 */

const PAGE_SIZE = 25;

const SORTS: { key: NonNullable<LeadQuery['sort']>; label: string }[] = [
  { key: 'recent', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'follow_up', label: 'Follow-up due' },
  { key: 'never_contacted', label: 'Longest untouched' },
  { key: 'name', label: 'Customer name' },
];

export function LeadsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<LeadStatus | 'all'>('all');
  const [owner, setOwner] = useState<number | 'unassigned' | 'all'>('all');
  const [sort, setSort] = useState<NonNullable<LeadQuery['sort']>>('recent');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<Paginated<Lead> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  /** Ids ticked for a bulk assignment. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Any filter change invalidates the page number and the selection: a tick on a lead
  // that is no longer listed would be assigned invisibly.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [status, owner, sort, debounced]);

  useEffect(() => {
    let cancelled = false;
    telecallingApi
      .assignableEmployees()
      .then((rows) => {
        if (!cancelled) setEmployees(rows);
      })
      .catch(() => {
        // A failed picker is not worth an error banner — the list still works, and the
        // assignment control simply has no options until the next load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = useMemo<LeadQuery>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      status,
      assignedTo: owner,
      sort,
      q: debounced || undefined,
    }),
    [page, status, owner, sort, debounced],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(await telecallingApi.listLeads(query, controller.signal));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load leads.');
    } finally {
      setLoading(false);
    }
  }, [query, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  /* ------------------------------------------------------------------ actions */

  const assign = async (leadId: number, value: string) => {
    setBusyId(leadId);
    setError(null);
    setNotice(null);

    try {
      const assignedTo = value === 'unassigned' ? null : Number(value);
      const updated = await telecallingApi.assignLead(leadId, assignedTo);

      setData((current) =>
        current
          ? { ...current, items: current.items.map((lead) => (lead.id === leadId ? updated : lead)) }
          : current,
      );
      setNotice(
        updated.assignedToName
          ? `${updated.customerName} assigned to ${updated.assignedToName}.`
          : `${updated.customerName} returned to the unassigned pool.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not assign the lead.');
    } finally {
      setBusyId(null);
    }
  };

  const changeStatus = async (leadId: number, next: LeadStatus) => {
    setBusyId(leadId);
    setError(null);

    try {
      const result = await telecallingApi.setLeadStatus(leadId, { status: next });
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((lead) => (lead.id === leadId ? result.lead : lead)),
            }
          : current,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not update the status.');
    } finally {
      setBusyId(null);
    }
  };

  const runBulkAssign = async () => {
    if (selected.size === 0 || !bulkTarget) return;

    setBulkBusy(true);
    setError(null);
    setNotice(null);

    try {
      const assignedTo = bulkTarget === 'unassigned' ? null : Number(bulkTarget);
      const result = await telecallingApi.bulkAssign([...selected], assignedTo);

      /**
       * Reports skipped and failed counts separately, because they mean different things:
       * skipped is "already owned by that person", failed is "no longer exists". Rolling
       * them into one number would hide a real problem behind a benign one.
       */
      const parts = [`${result.assigned} assigned`];
      if (result.skipped > 0) parts.push(`${result.skipped} already correct`);
      if (result.failedIds.length > 0) parts.push(`${result.failedIds.length} could not be found`);

      setNotice(`${parts.join(', ')}.`);
      setSelected(new Set());
      setBulkTarget('');
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not assign the leads.');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggle = (leadId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data) return;
    setSelected((current) =>
      current.size === data.items.length ? new Set() : new Set(data.items.map((lead) => lead.id)),
    );
  };

  const exportCsv = () => {
    if (!data) return;

    downloadCsv(
      `jmk-leads-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Reference',
        'Customer',
        'Phone',
        'Alternate',
        'Email',
        'City',
        'Source',
        'Interested in',
        'Status',
        'Assigned to',
        'Last contacted',
        'Next follow-up',
        'Created',
      ],
      data.items.map((lead) => [
        lead.reference,
        lead.customerName,
        lead.phone,
        lead.alternatePhone,
        lead.email,
        lead.city,
        humanise(lead.source),
        lead.productInterest,
        LEAD_STATUS_LABELS[lead.status],
        lead.assignedToName ?? 'Unassigned',
        formatDateTime(lead.lastContactedAt),
        formatDateTime(lead.nextFollowUpAt),
        formatDate(lead.createdAt),
      ]),
    );
  };

  const clearFilters = () => {
    setStatus('all');
    setOwner('all');
    setSearch('');
    setSort('recent');
  };

  const hasFilters = status !== 'all' || owner !== 'all' || debounced.length > 0;

  /* -------------------------------------------------------------------- view */

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="tc-lead-search">
              Search
            </label>
            <input
              id="tc-lead-search"
              className="input"
              type="search"
              value={search}
              placeholder="Name, number or reference"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '15rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-status">
              Status
            </label>
            <select
              id="tc-lead-status"
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as LeadStatus | 'all')}
            >
              <option value="all">All statuses</option>
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {LEAD_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-owner">
              Assigned to
            </label>
            <select
              id="tc-lead-owner"
              className="select"
              value={String(owner)}
              onChange={(event) => {
                const value = event.target.value;
                setOwner(value === 'all' || value === 'unassigned' ? value : Number(value));
              }}
            >
              <option value="all">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-sort">
              Sort
            </label>
            <select
              id="tc-lead-sort"
              className="select"
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as NonNullable<LeadQuery['sort']>)
              }
            >
              {SORTS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
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

      {/* Bulk assignment appears only when something is ticked. */}
      {selected.size > 0 ? (
        <div className="tc-bulkbar">
          <span>
            <strong>{selected.size}</strong> lead{selected.size === 1 ? '' : 's'} selected
          </span>

          <select
            className="select"
            value={bulkTarget}
            onChange={(event) => setBulkTarget(event.target.value)}
            aria-label="Assign selected leads to"
          >
            <option value="">Choose an employee…</option>
            <option value="unassigned">Return to unassigned pool</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!bulkTarget || bulkBusy}
            onClick={() => void runBulkAssign()}
          >
            {bulkBusy ? 'Assigning…' : 'Assign'}
          </button>

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      ) : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data || data.items.length === 0 ? (
        <EmptyPanel
          title="No leads found"
          message={
            hasFilters
              ? 'No leads match the current filters.'
              : 'No leads have been created yet. Telecallers can add them from the mobile app, or import them.'
          }
          actionLabel={hasFilters ? 'Clear filters' : undefined}
          onAction={hasFilters ? clearFilters : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="tc-col-tick">
                  <input
                    type="checkbox"
                    checked={selected.size === data.items.length && data.items.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all leads on this page"
                  />
                </th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col">Assigned to</th>
                <th scope="col">Last contacted</th>
                <th scope="col">Next follow-up</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((lead) => {
                const overdue =
                  lead.nextFollowUpAt !== null &&
                  new Date(lead.nextFollowUpAt).getTime() < Date.now();

                return (
                  <tr key={lead.id} aria-busy={busyId === lead.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggle(lead.id)}
                        aria-label={`Select ${lead.customerName}`}
                      />
                    </td>

                    <td>
                      <strong>{lead.customerName}</strong>
                      <br />
                      <span className="tc-muted">{lead.phone}</span>
                      <br />
                      <span className="tc-muted tc-mono">{lead.reference}</span>
                      {lead.productInterest ? (
                        <>
                          <br />
                          <span className="tc-muted">{lead.productInterest}</span>
                        </>
                      ) : null}
                    </td>

                    <td>
                      <LeadStatusBadge status={lead.status} />
                      <br />
                      <select
                        className="select select--sm"
                        value={lead.status}
                        disabled={busyId === lead.id}
                        onChange={(event) =>
                          void changeStatus(lead.id, event.target.value as LeadStatus)
                        }
                        aria-label={`Change status for ${lead.customerName}`}
                      >
                        {LEAD_STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {LEAD_STATUS_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td>
                      <select
                        className="select select--sm"
                        value={lead.assignedTo === null ? 'unassigned' : String(lead.assignedTo)}
                        disabled={busyId === lead.id}
                        onChange={(event) => void assign(lead.id, event.target.value)}
                        aria-label={`Assign ${lead.customerName}`}
                      >
                        <option value="unassigned">Unassigned</option>
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                        {/*
                          A lead can be owned by a deactivated employee, who is not in the
                          assignable list. Without this option the select would show the
                          wrong person as the current owner.
                        */}
                        {lead.assignedTo !== null &&
                        !employees.some((employee) => employee.id === lead.assignedTo) ? (
                          <option value={String(lead.assignedTo)}>
                            {lead.assignedToName ?? 'Former employee'} (inactive)
                          </option>
                        ) : null}
                      </select>
                    </td>

                    <td>{formatDateTime(lead.lastContactedAt)}</td>

                    <td className={overdue ? 'tc-cell-bad' : undefined}>
                      {formatDateTime(lead.nextFollowUpAt)}
                      {overdue ? (
                        <>
                          <br />
                          <span className="tc-badge tc-badge--bad">Overdue</span>
                        </>
                      ) : null}
                    </td>

                    <td>{humanise(lead.source)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          noun="lead"
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
