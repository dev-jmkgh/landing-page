'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
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
  type LeadSourceRecord,
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
 *
 * Leads can also be created here. The endpoint has always existed and the mobile app has
 * always used it, but the web had no form — so a lead phoned in to the office, or arriving
 * on paper, had to be entered on somebody's handset.
 */

type NewLead = {
  customerName: string;
  phone: string;
  alternatePhone: string;
  email: string;
  city: string;
  address: string;
  source: string;
  productInterest: string;
  status: LeadStatus;
  assignedTo: string;
  summaryNote: string;
};

/**
 * `source` is left empty rather than defaulted to a slug.
 *
 * The sources are admin-editable, so hard-coding 'manual' here would break silently the
 * day someone renames it. It is filled in once the list loads, and validated before
 * submit so a failed source load cannot produce a lead with no source.
 *
 * `assignedTo` is a string because it is bound to a `<select>`; '' means unassigned.
 */
const BLANK_LEAD: NewLead = {
  customerName: '',
  phone: '',
  alternatePhone: '',
  email: '',
  city: '',
  address: '',
  source: '',
  productInterest: '',
  status: 'new',
  assignedTo: '',
  summaryNote: '',
};

const PAGE_SIZE = 25;

const SORTS: { key: NonNullable<LeadQuery['sort']>; label: string }[] = [
  { key: 'recent', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'follow_up', label: 'Follow-up due' },
  { key: 'never_contacted', label: 'Longest untouched' },
  { key: 'name', label: 'Customer name' },
];

/**
 * Whether a lead's next follow-up is in the past.
 *
 * Derived on the client from the cached `next_follow_up_at`, deliberately: the column
 * is maintained transactionally by the API, and asking the server for an "overdue" flag
 * as well would be a second source of truth for the same comparison.
 */
function isOverdue(lead: Lead): boolean {
  return lead.nextFollowUpAt !== null && new Date(lead.nextFollowUpAt).getTime() < Date.now();
}

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

  const [sources, setSources] = useState<LeadSourceRecord[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewLead>(BLANK_LEAD);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

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

  /**
   * The lead sources, for the create form's dropdown.
   *
   * Only the active ones are offered: a retired source stays on the leads that already
   * carry it — so their history reads correctly — but must not be selectable for new
   * ones, which is the whole point of retiring it.
   *
   * The first active source becomes the default selection, so the common case is one
   * fewer decision. A failure is silent for the same reason as the picker above, and the
   * form refuses to submit without a source, so this cannot create a sourceless lead.
   */
  useEffect(() => {
    let cancelled = false;
    telecallingApi
      .listLeadSources()
      .then((rows) => {
        if (cancelled) return;
        const active = rows.filter((row) => row.isActive);
        setSources(active);
        setForm((current) =>
          current.source === '' && active[0] ? { ...current, source: active[0].slug } : current,
        );
      })
      .catch(() => undefined);
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

  /**
   * Creates a lead from the web form.
   *
   * Validated here as well as on the server. Not for safety — the server is
   * authoritative and its Zod schema is what actually decides — but so a missing phone
   * number is reported before a round trip, and so the message names the field.
   *
   * `clientUuid` is deliberately NOT sent. It exists for the mobile app's offline queue,
   * where the same create can be retried after the response was lost; a web form submit
   * has no such queue, and inventing a uuid per keystroke-session would either dedupe
   * two genuinely different leads or do nothing at all.
   */
  const create = async () => {
    setFormErrors({});
    setError(null);
    setNotice(null);

    const localErrors: Record<string, string> = {};

    if (form.customerName.trim().length < 2) {
      localErrors.customerName = "Enter the customer's name.";
    }

    /*
     * Digits only, 7 to 15, matching what the server accepts. Checked loosely on
     * purpose: the point is to catch an empty or obviously-wrong box, not to reject a
     * real number written with spaces or a country code.
     */
    const digits = form.phone.replace(/[^\d]/g, '');
    if (digits.length < 7 || digits.length > 15) {
      localErrors.phone = 'Enter a phone number of 7 to 15 digits.';
    }

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(form.email.trim())) {
      localErrors.email = 'Enter a valid email address, or leave it blank.';
    }

    if (!form.source) {
      localErrors.source = 'Choose a source.';
    }

    if (Object.keys(localErrors).length > 0) {
      setFormErrors(localErrors);
      return;
    }

    setCreating(true);

    try {
      const result = await telecallingApi.createLead({
        customerName: form.customerName.trim(),
        phone: form.phone.trim(),
        // Empty strings become null: the server treats '' as absent for these, and
        // sending '' would store a blank rather than nothing.
        alternatePhone: form.alternatePhone.trim() || null,
        email: form.email.trim().toLowerCase() || null,
        city: form.city.trim() || null,
        address: form.address.trim() || null,
        source: form.source,
        productInterest: form.productInterest.trim() || null,
        status: form.status,
        assignedTo: form.assignedTo === '' ? null : Number(form.assignedTo),
        summaryNote: form.summaryNote.trim() || null,
      });

      const owner = result.lead.assignedToName
        ? ` Assigned to ${result.lead.assignedToName}.`
        : ' Left unassigned.';

      /*
       * A duplicate phone is reported, not treated as a failure. The server returns the
       * existing lead alongside the new one precisely so the decision belongs to whoever
       * can see both — so the lead IS created and the warning names the other reference.
       */
      const duplicate = result.possibleDuplicate
        ? ` Note: ${result.possibleDuplicate.reference} (${result.possibleDuplicate.customerName}) already has this number.`
        : '';

      setNotice(`Lead ${result.lead.reference} created for ${result.lead.customerName}.${owner}${duplicate}`);

      // Keep the source and the assignee: entering a stack of paper leads from the same
      // batch means the next one almost always shares both.
      setForm({ ...BLANK_LEAD, source: form.source, assignedTo: form.assignedTo });
      setShowForm(false);
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFormErrors(caught.fieldErrors);
      } else {
        setError('Could not create the lead.');
      }
    } finally {
      setCreating(false);
    }
  };

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

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowForm((value) => !value)}
          >
            <Icon name="add" size={16} />
            {showForm ? 'Cancel' : 'New lead'}
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {showForm ? (
        <div className="tc-card tc-form">
          <h3 className="tc-section-title" style={{ marginTop: 0 }}>
            New lead
          </h3>

          <div className="tc-form__grid">
            <div className="field">
              <label className="field__label" htmlFor="tc-lead-name">
                Customer name
              </label>
              <input
                id="tc-lead-name"
                className="input"
                value={form.customerName}
                onChange={(event) => setForm({ ...form, customerName: event.target.value })}
              />
              {formErrors.customerName ? (
                <p className="field__error">{formErrors.customerName}</p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-phone">
                Phone
              </label>
              <input
                id="tc-lead-phone"
                className="input"
                type="tel"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
              {formErrors.phone ? (
                <p className="field__error">{formErrors.phone}</p>
              ) : (
                /*
                  Said plainly because a duplicate is allowed, which surprises people who
                  expect the form to stop them. Kept to one short line so it does not
                  wrap and make this column taller than its neighbours.
                */
                <p className="field__hint">A duplicate number is allowed.</p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-alt">
                Alternate phone (optional)
              </label>
              <input
                id="tc-lead-alt"
                className="input"
                type="tel"
                value={form.alternatePhone}
                onChange={(event) => setForm({ ...form, alternatePhone: event.target.value })}
              />
              {formErrors.alternatePhone ? (
                <p className="field__error">{formErrors.alternatePhone}</p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-email">
                Email (optional)
              </label>
              <input
                id="tc-lead-email"
                className="input"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
              {formErrors.email ? <p className="field__error">{formErrors.email}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-source">
                Source
              </label>
              <select
                id="tc-lead-source"
                className="select"
                value={form.source}
                onChange={(event) => setForm({ ...form, source: event.target.value })}
              >
                {/*
                  No "choose one" placeholder: the first active source is preselected, and
                  an empty option only exists to be an error state.
                */}
                {sources.length === 0 ? <option value="">Loading…</option> : null}
                {sources.map((source) => (
                  <option key={source.slug} value={source.slug}>
                    {source.label}
                  </option>
                ))}
              </select>
              {formErrors.source ? <p className="field__error">{formErrors.source}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-city">
                City (optional)
              </label>
              <input
                id="tc-lead-city"
                className="input"
                value={form.city}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-product">
                Product interest (optional)
              </label>
              <input
                id="tc-lead-product"
                className="input"
                value={form.productInterest}
                onChange={(event) => setForm({ ...form, productInterest: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-owner">
                Assign to
              </label>
              <select
                id="tc-lead-owner"
                className="select"
                value={form.assignedTo}
                onChange={(event) => setForm({ ...form, assignedTo: event.target.value })}
              >
                <option value="">Leave unassigned</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
              {formErrors.assignedTo ? (
                <p className="field__error">{formErrors.assignedTo}</p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-lead-status">
                Status
              </label>
              <select
                id="tc-lead-status"
                className="select"
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as LeadStatus })
                }
              >
                {LEAD_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {LEAD_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
              {/*
                Offered rather than forced to "new" because a lead taken down over the
                phone has often already been spoken to — the person entering it IS the
                conversation.
              */}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-address">
              Address (optional)
            </label>
            <input
              id="tc-lead-address"
              className="input"
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
            />
            {formErrors.address ? <p className="field__error">{formErrors.address}</p> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-note">
              Requirement / notes (optional)
            </label>
            <textarea
              id="tc-lead-note"
              /* `.textarea`, not `.input` — the stylesheet has a separate rule for it. */
              className="textarea"
              rows={3}
              value={form.summaryNote}
              onChange={(event) => setForm({ ...form, summaryNote: event.target.value })}
            />
            {formErrors.summaryNote ? (
              <p className="field__error">{formErrors.summaryNote}</p>
            ) : null}
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create lead'}
          </button>
        </div>
      ) : null}

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
        <DataTable
          rows={data.items}
          rowKey={(lead) => lead.id}
          rowBusy={(lead) => busyId === lead.id}
          rowTone={(lead) => (isOverdue(lead) ? 'bad' : undefined)}
          minWidth="72rem"
          caption="Leads, with owner, status and follow-up dates"
          columns={[
            {
              key: 'select',
              width: '2.75rem',
              align: 'center',
              header: (
                <input
                  type="checkbox"
                  checked={selected.size === data.items.length && data.items.length > 0}
                  onChange={toggleAll}
                  aria-label="Select all leads on this page"
                />
              ),
              render: (lead) => (
                <input
                  type="checkbox"
                  checked={selected.has(lead.id)}
                  onChange={() => toggle(lead.id)}
                  aria-label={`Select ${lead.customerName}`}
                />
              ),
            },
            {
              /* No width: the customer column absorbs the leftover space. */
              key: 'customer',
              header: 'Customer',
              render: (lead) => (
                <CellStack primary={lead.customerName} secondary={lead.phone}>
                  <span className="tc-muted tc-mono">{lead.reference}</span>
                  {lead.productInterest ? (
                    <span className="tc-muted">{lead.productInterest}</span>
                  ) : null}
                </CellStack>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: '11rem',
              render: (lead) => (
                <CellStack primary={<LeadStatusBadge status={lead.status} />}>
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
                </CellStack>
              ),
            },
            {
              key: 'assigned',
              header: 'Assigned to',
              width: '12rem',
              render: (lead) => (
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
                    assignable list. Without this option the select would show the wrong
                    person as the current owner.
                  */}
                  {lead.assignedTo !== null &&
                  !employees.some((employee) => employee.id === lead.assignedTo) ? (
                    <option value={String(lead.assignedTo)}>
                      {lead.assignedToName ?? 'Former employee'} (inactive)
                    </option>
                  ) : null}
                </select>
              ),
            },
            {
              key: 'lastContacted',
              header: 'Last contacted',
              width: '10rem',
              nowrap: true,
              render: (lead) => formatDateTime(lead.lastContactedAt),
            },
            {
              key: 'nextFollowUp',
              header: 'Next follow-up',
              width: '10rem',
              nowrap: true,
              render: (lead) => (
                <CellStack
                  primary={
                    <span className={isOverdue(lead) ? 'tc-cell-bad' : undefined}>
                      {formatDateTime(lead.nextFollowUpAt)}
                    </span>
                  }
                >
                  {isOverdue(lead) ? <span className="tc-badge tc-badge--bad">Overdue</span> : null}
                </CellStack>
              ),
            },
            {
              key: 'source',
              header: 'Source',
              width: '8rem',
              render: (lead) => humanise(lead.source),
            },
          ]}
        />
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
