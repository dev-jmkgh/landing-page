'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, Loader, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  NOTE_KIND_LABELS,
  formatCount,
  formatDate,
  formatDateRange,
  formatDateTime,
  humanise,
  telecallingApi,
  type DateRange,
  type Employee,
  type LatestLeadNote,
  type Lead,
  type LeadImport,
  type LeadListItem,
  type LeadQuery,
  type LeadSort,
  type LeadSourceRecord,
  type LeadStatus,
  type Paginated,
} from '@/lib/telecalling';
import { LeadImportPanel } from './LeadImportPanel';
import { LeadLink, useTelecallingNav } from './nav';
import {
  DateTimeCell,
  EmptyPanel,
  LeadStatusBadge,
  Pager,
  RangePicker,
  TableSkeleton,
  downloadCsv,
  rangeFor,
  type RangePreset,
} from './shared';
import { readCustomRange, readEnum, readId, readPage, readRange, readText } from './urlState';

/**
 * Lead management and assignment (spec: Admin Modules 4 and 5).
 *
 * The two modules share one screen because they are the same task: an admin looking at
 * the lead list is deciding who works what. Splitting them would mean filtering twice —
 * once to find the leads, again on an assignment screen to find them a second time.
 *
 * Leads can also be created here, one at a time or a spreadsheet at once (Import leads).
 * The endpoint has always existed and the mobile app has always used it, but the web had
 * no form — so a lead phoned in to the office, or arriving on paper, had to be entered on
 * somebody's handset.
 *
 * The filters live in the address (urlState.ts): a refresh, a link sent to a colleague, a
 * dashboard tile and the Back button all land on the same filtered page. Opening a lead
 * shows the Lead View over this panel, which stays mounted underneath — so closing it
 * returns to the list exactly as it was left, ticks and scroll position included.
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

const SORTS: { key: LeadSort; label: string }[] = [
  { key: 'recent', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'follow_up', label: 'Follow-up due' },
  { key: 'never_contacted', label: 'Longest untouched' },
  { key: 'name', label: 'Customer name' },
];

const SORT_KEYS = SORTS.map((option) => option.key);

/** `assigned` is anyone at all — the dashboard's "Assigned" tile. */
type OwnerFilter = number | 'unassigned' | 'assigned' | 'all';
type ContactedFilter = 'never' | 'any' | 'all';

type PanelKind = 'none' | 'create' | 'import';

/**
 * The list's filters as the address spells them, each read with a fallback.
 *
 * A hand-edited or years-old link must never reach the API as a value it would refuse,
 * so anything unreadable becomes the default rather than a 422 over a working screen.
 * `from`/`to` and `convertedFrom`/`convertedTo` are explicit ranges a dashboard chart
 * opens the list with; there is no control that sets them, only chips that remove them.
 */
function readLeadFilters(params: URLSearchParams) {
  const assigned = params.get('assignedTo');
  const owner: OwnerFilter =
    assigned === 'unassigned' || assigned === 'assigned' ? assigned : (readId(params, 'assignedTo') ?? 'all');
  const source = readText(params, 'source', 40).toLowerCase();

  return {
    status: readEnum<LeadStatus | 'all'>(params, 'status', LEAD_STATUSES, 'all'),
    owner,
    contacted: readEnum<ContactedFilter>(params, 'contacted', ['never', 'any'], 'all'),
    source: /^[a-z0-9_]+$/.test(source) ? source : '',
    sort: readEnum<LeadSort>(params, 'sort', SORT_KEYS, 'recent'),
    range: readRange(params, 'all'),
    created: readCustomRange(params),
    converted: readCustomRange(params, 'convertedFrom', 'convertedTo'),
    q: readText(params, 'q'),
    page: readPage(params),
  };
}

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

/** A note preview as shown and exported: marked when the server cut it short. */
function noteText(note: LatestLeadNote): string {
  return note.truncated ? `${note.body}…` : note.body;
}

/** "Call note · Ravi Caller · 05 Oct 2026, 02:30 pm", or "Lead summary" for the fallback. */
function noteMeta(note: LatestLeadNote): string {
  const kind = note.source === 'summary' ? 'Lead summary' : note.kind ? NOTE_KIND_LABELS[note.kind] : 'Note';
  return [kind, note.userName, note.createdAt ? formatDateTime(note.createdAt) : null]
    .filter(Boolean)
    .join(' · ');
}

/** "3 leads". */
function countOf(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The notice the list shows once an import ends, finished or stopped. */
function importNotice(summary: LeadImport): string {
  const { created, skipped, failed, notImported } = summary.progress;
  const opening =
    summary.state === 'completed'
      ? `${countOf(created, 'lead')} imported from ${summary.fileName}.`
      : `The import of ${summary.fileName} was stopped. ${countOf(created, 'lead')} already imported ${created === 1 ? 'was' : 'were'} kept.`;

  const rest: string[] = [];
  if (skipped > 0) rest.push(`${formatCount(skipped)} skipped`);
  if (failed > 0) rest.push(`${formatCount(failed)} could not be saved`);
  if (notImported > 0) rest.push(`${formatCount(notImported)} not imported (errors or duplicates)`);

  return rest.length > 0 ? `${opening} ${rest.join(', ')}.` : opening;
}

export function LeadsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const nav = useTelecallingNav();
  const { openLead, replaceParams } = nav;

  // Read once: from here on the state is the truth and the address follows it.
  const [initial] = useState(() => readLeadFilters(nav.params));

  const [status, setStatus] = useState(initial.status);
  const [owner, setOwner] = useState<OwnerFilter>(initial.owner);
  const [contacted, setContacted] = useState(initial.contacted);
  const [source, setSource] = useState(initial.source);
  const [sort, setSort] = useState(initial.sort);
  const [range, setRange] = useState<RangePreset>(initial.range);
  const [created, setCreated] = useState<DateRange | null>(initial.created);
  const [converted, setConverted] = useState<DateRange | null>(initial.converted);
  // Both start from the address, so the first fetch already carries the search.
  const [search, setSearch] = useState(initial.q);
  const [debounced, setDebounced] = useState(initial.q);
  const [page, setPage] = useState(initial.page);

  const [data, setData] = useState<Paginated<LeadListItem> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  /** Every source, retired ones included: the filter must reach leads that carry them. */
  const [sources, setSources] = useState<LeadSourceRecord[]>([]);
  const [sourcesStatus, setSourcesStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [panel, setPanel] = useState<PanelKind>('none');
  const [form, setForm] = useState<NewLead>(BLANK_LEAD);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  /*
   * Spreadsheet import. `importAllowed` is learned from the unfinished-import check: the
   * endpoints are manager and above, the browser is not told the signed-in role, and a
   * 403 there is the cheapest way to know not to offer the button at all.
   */
  const [importAllowed, setImportAllowed] = useState<boolean | null>(null);
  const [unfinished, setUnfinished] = useState<LeadImport | null>(null);
  const [resumeImportId, setResumeImportId] = useState<number | null>(null);
  const [importRunning, setImportRunning] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  /** Ids ticked for a bulk assignment. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const debouncedRef = useRef(initial.q);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeSources = useMemo(() => sources.filter((row) => row.isActive), [sources]);

  /**
   * Any filter change starts the list over: page one, nothing ticked. A tick on a lead
   * that is no longer listed would be assigned invisibly.
   *
   * Called from each control's handler rather than from an effect on the filters. An
   * effect would also run on mount — and twice under StrictMode — and throw away the page
   * number the address opened the list on.
   */
  const startOver = () => {
    setPage(1);
    setSelected(new Set());
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = search.trim();
      // Only a real change starts over, so settling on the text the list already shows —
      // which is what happens right after mount — keeps the page from the address.
      if (next === debouncedRef.current) return;
      debouncedRef.current = next;
      setDebounced(next);
      setPage(1);
      setSelected(new Set());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The address follows the filters, in place (no history entry per change).
  useEffect(() => {
    replaceParams(
      {
        status,
        assignedTo: owner,
        contacted,
        source,
        // An explicit range replaces the preset, so only one of them is spelled out.
        range: created ? null : range,
        from: created?.from,
        to: created?.to,
        convertedFrom: converted?.from,
        convertedTo: converted?.to,
        sort,
        q: debounced,
        page,
      },
      { range: 'all', sort: 'recent', page: 1 },
    );
  }, [replaceParams, status, owner, contacted, source, range, created, converted, sort, debounced, page]);

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
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The lead sources, for the source filter and the create form's dropdown.
   *
   * The form offers only the active ones: a retired source stays on the leads that already
   * carry it — so their history reads correctly — but must not be selectable for new
   * ones, which is the whole point of retiring it. The filter offers all of them.
   *
   * The first active source becomes the form's default, so the common case is one fewer
   * decision. A failure is silent for the same reason as the picker above, and the form
   * refuses to submit without a source, so this cannot create a sourceless lead.
   */
  useEffect(() => {
    let cancelled = false;
    telecallingApi
      .listLeadSources()
      .then((rows) => {
        if (cancelled) return;
        setSources(rows);
        setSourcesStatus('ready');
        const firstActive = rows.find((row) => row.isActive);
        setForm((current) =>
          current.source === '' && firstActive ? { ...current, source: firstActive.slug } : current,
        );
      })
      .catch(() => {
        if (!cancelled) setSourcesStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Looks for an import of this user's that stopped part-way — a closed tab, a lost
   * connection — so it can be offered again rather than forgotten.
   *
   * Errors are swallowed. A 403 means a role that cannot import (the button is hidden);
   * anything else is not worth a banner over the lead list, and the list's own request
   * reports a real outage.
   */
  const checkUnfinished = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await telecallingApi.listLeadImports(
        { state: 'committing', mine: true, pageSize: 1 },
        signal,
      );
      setImportAllowed(true);
      setUnfinished(result.items[0] ?? null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 403) setImportAllowed(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkUnfinished(controller.signal);
    return () => controller.abort();
  }, [checkUnfinished]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    // The Created window is worked out on every load, not memoised on the preset, so a
    // screen left open past IST midnight asks for today rather than keeping yesterday.
    const createdRange = created ?? rangeFor(range);
    const query: LeadQuery = {
      page,
      pageSize: PAGE_SIZE,
      status,
      assignedTo: owner,
      contacted,
      source: source || undefined,
      sort,
      q: debounced || undefined,
      from: createdRange.from,
      to: createdRange.to,
      convertedFrom: converted?.from,
      convertedTo: converted?.to,
    };

    setLoading(true);
    setError(null);

    try {
      const result = await telecallingApi.listLeads(query, controller.signal);
      setData(result);
      // A page past the end — the list shrank, or an old link — is answered with the last
      // page. Follow it, so the pager and the address say what is on screen.
      if (result.page !== query.page) setPage(result.page);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load leads.');
    } finally {
      // Only the latest request decides; an aborted one must not end the newer one's wait.
      if (abort.current === controller) setLoading(false);
    }
  }, [page, status, owner, contacted, source, sort, debounced, created, range, converted, onUnauthorized]);

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

      const ownerText = result.lead.assignedToName
        ? ` Assigned to ${result.lead.assignedToName}.`
        : ' Left unassigned.';

      /*
       * Nothing here reports a duplicate any more.
       *
       * A number can belong to only one active lead, so a clash never reaches this point:
       * the server refuses the create and the error lands on the Phone field, naming the
       * lead that already holds it. Reaching here means the lead was created outright.
       */
      setNotice(`Lead ${result.lead.reference} created for ${result.lead.customerName}.${ownerText}`);

      // Keep the source and the assignee: entering a stack of paper leads from the same
      // batch means the next one almost always shares both.
      setForm({ ...BLANK_LEAD, source: form.source, assignedTo: form.assignedTo });
      setPanel('none');
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

  /**
   * Puts a row-level action's answer into the row.
   *
   * Merged, not replaced: the action answers with a plain Lead, and the list row also
   * carries the newest note — replacing it would blank the Notes column after every
   * inline status or owner change.
   */
  const mergeLead = (updated: Lead) => {
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
          }
        : current,
    );
  };

  const assign = async (leadId: number, value: string) => {
    setBusyId(leadId);
    setError(null);
    setNotice(null);

    try {
      const assignedTo = value === 'unassigned' ? null : Number(value);
      const updated = await telecallingApi.assignLead(leadId, assignedTo);

      mergeLead(updated);
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

  const updateStatus = async (leadId: number, next: LeadStatus) => {
    setBusyId(leadId);
    setError(null);

    try {
      const result = await telecallingApi.setLeadStatus(leadId, { status: next });
      mergeLead(result.lead);
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
        // Appended, never inserted: spreadsheets built on this export address the columns
        // by position, and a column added in the middle would shift every one after it.
        'Latest note',
        'Latest note at',
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
        lead.latestNote ? noteText(lead.latestNote) : null,
        lead.latestNote?.createdAt ? formatDateTime(lead.latestNote.createdAt) : null,
      ]),
    );
  };

  const clearFilters = () => {
    setStatus('all');
    setOwner('all');
    setContacted('all');
    setSource('');
    setRange('all');
    setCreated(null);
    setConverted(null);
    setSort('recent');
    setSearch('');
    debouncedRef.current = '';
    setDebounced('');
    startOver();
  };

  const hasFilters =
    status !== 'all' ||
    owner !== 'all' ||
    contacted !== 'all' ||
    source !== '' ||
    range !== 'all' ||
    created !== null ||
    converted !== null ||
    debounced.length > 0;

  /* ------------------------------------------------------------ import panel */

  const openImport = () => {
    setResumeImportId(null);
    setPanel('import');
  };

  const closeImport = () => {
    setPanel('none');
    setResumeImportId(null);
    // Back to the button that opened it, so a keyboard user carries on from there.
    importButtonRef.current?.focus();
    void checkUnfinished();
  };

  const finishImport = (summary: LeadImport) => {
    setPanel('none');
    setResumeImportId(null);
    setUnfinished(null);
    setError(null);
    setNotice(importNotice(summary));
    importButtonRef.current?.focus();
    void load();
  };

  const resumeUnfinished = () => {
    if (!unfinished) return;
    setConfirmStop(false);
    setResumeImportId(unfinished.id);
    setPanel('import');
  };

  const stopUnfinished = async () => {
    if (!unfinished) return;

    setStopping(true);
    setError(null);
    setNotice(null);

    try {
      const summary = await telecallingApi.cancelLeadImport(unfinished.id);
      setUnfinished(null);
      setConfirmStop(false);
      setNotice(importNotice(summary));
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not stop the import.');
      void checkUnfinished();
    } finally {
      setStopping(false);
    }
  };

  const unfinishedDone = unfinished
    ? unfinished.progress.created + unfinished.progress.skipped + unfinished.progress.failed
    : 0;
  const unfinishedTotal = unfinished ? unfinishedDone + unfinished.progress.pending : 0;

  /** The owner filter can name someone the assignable list leaves out — a former employee. */
  const ownerMissing =
    typeof owner === 'number' && !employees.some((employee) => employee.id === owner);
  const ownerFallbackName =
    typeof owner === 'number'
      ? (data?.items.find((lead) => lead.assignedTo === owner)?.assignedToName ?? null)
      : null;

  const sourceMissing = source !== '' && !sources.some((row) => row.slug === source);
  const convertedText = converted ? formatDateRange(converted) : null;

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
              onChange={(event) => {
                setStatus(event.target.value as LeadStatus | 'all');
                startOver();
              }}
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
                setOwner(
                  value === 'all' || value === 'unassigned' || value === 'assigned' ? value : Number(value),
                );
                startOver();
              }}
            >
              <option value="all">All leads</option>
              <option value="assigned">Anyone assigned</option>
              <option value="unassigned">Unassigned</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
              {/*
                An address can name an employee the assignable list leaves out — someone
                since deactivated. Without this option the select would show "All leads"
                while the list was still filtered by them.
              */}
              {ownerMissing ? (
                <option value={String(owner)}>
                  {employeesLoaded
                    ? `${ownerFallbackName ?? 'Former employee'} (inactive)`
                    : (ownerFallbackName ?? 'Selected employee')}
                </option>
              ) : null}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-contacted">
              Contacted
            </label>
            <select
              id="tc-lead-contacted"
              className="select"
              value={contacted}
              onChange={(event) => {
                setContacted(event.target.value as ContactedFilter);
                startOver();
              }}
            >
              <option value="all">Any</option>
              <option value="never">Not yet contacted</option>
              <option value="any">Contacted</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-lead-source-filter">
              Source
            </label>
            <select
              id="tc-lead-source-filter"
              className="select"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                startOver();
              }}
            >
              <option value="">All sources</option>
              {sources.map((row) => (
                <option key={row.slug} value={row.slug}>
                  {row.isActive ? row.label : `${row.label} (retired)`}
                </option>
              ))}
              {sourceMissing ? <option value={source}>{humanise(source)}</option> : null}
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
              onChange={(event) => {
                setSort(event.target.value as LeadSort);
                startOver();
              }}
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

          {importAllowed !== false ? (
            <button
              ref={importButtonRef}
              type="button"
              className="btn btn--outline"
              aria-expanded={panel === 'import'}
              disabled={importRunning}
              onClick={() => (panel === 'import' ? closeImport() : openImport())}
            >
              <Icon name="upload" size={16} />
              {panel === 'import' ? 'Close import' : 'Import leads'}
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn--primary"
            aria-expanded={panel === 'create'}
            disabled={importRunning}
            onClick={() => {
              // Swapping an open import for the form — paused, or left on its last step —
              // the list and the unfinished-import notice catch up with what it did.
              if (panel === 'import') {
                setResumeImportId(null);
                void checkUnfinished();
                void load();
              }
              setPanel((current) => (current === 'create' ? 'none' : 'create'));
            }}
          >
            <Icon name="add" size={16} />
            {panel === 'create' ? 'Cancel' : 'New lead'}
          </button>
        </div>
      </div>

      <div className="tc-leads-range">
        <span className="tc-leads-range__label" aria-hidden="true">
          Created
        </span>
        <RangePicker
          value={range}
          onChange={(next) => {
            setRange(next);
            setCreated(null);
            startOver();
          }}
          custom={created}
          onClearCustom={() => {
            setCreated(null);
            startOver();
          }}
          label="Created"
        />

        {/*
          Leads converted in a period, as a dashboard chart opens them. No control sets
          this — it arrives in the address — so it is shown as what it is, with a way out.
        */}
        {convertedText !== null ? (
          <span className="tc-segmented" role="group" aria-label="Converted">
            <span className="tc-segmented__chip">
              Converted {convertedText}
              <button
                type="button"
                className="tc-segmented__clear"
                onClick={() => {
                  setConverted(null);
                  startOver();
                }}
                aria-label={`Remove the converted range ${convertedText}`}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          </span>
        ) : null}
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {unfinished && panel !== 'import' ? (
        <FormAlert variant="info">
          <div className="tc-import-banner">
            <p>
              An import of <strong>{unfinished.fileName}</strong> is unfinished:{' '}
              {formatCount(unfinishedDone)} of {formatCount(unfinishedTotal)} rows done.
            </p>
            <div className="tc-import-banner__actions">
              {confirmStop ? (
                <>
                  <span>Stop it for good? Leads already imported are kept.</span>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => void stopUnfinished()}
                    disabled={stopping}
                    aria-busy={stopping || undefined}
                  >
                    {stopping ? <ButtonSpinner /> : null}
                    Stop import
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setConfirmStop(false)}
                    disabled={stopping}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn--primary btn--sm" onClick={resumeUnfinished}>
                    Resume import
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmStop(true)}>
                    Stop import
                  </button>
                </>
              )}
            </div>
          </div>
        </FormAlert>
      ) : null}

      {panel === 'import' ? (
        <LeadImportPanel
          key={resumeImportId ?? 'new'}
          employees={employees}
          sources={activeSources}
          sourcesStatus={sourcesStatus}
          resumeImportId={resumeImportId}
          onUnauthorized={onUnauthorized}
          onClose={closeImport}
          onFinished={finishImport}
          onRunningChange={setImportRunning}
        />
      ) : null}

      {panel === 'create' ? (
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
                  Said up front because the form refuses a number an active lead already
                  holds — and names that lead — which is better known before typing than
                  after. One short line, so it does not wrap and make this column taller
                  than its neighbours.
                */
                <p className="field__hint">Each number can belong to only one active lead.</p>
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
                disabled={activeSources.length === 0}
                onChange={(event) => setForm({ ...form, source: event.target.value })}
              >
                {/*
                  No "choose one" placeholder: the first active source is preselected, and
                  an empty option only exists while there is nothing to choose from.
                */}
                {activeSources.length === 0 ? <option value="">—</option> : null}
                {activeSources.map((row) => (
                  <option key={row.slug} value={row.slug}>
                    {row.label}
                  </option>
                ))}
              </select>
              {formErrors.source ? (
                <p className="field__error">{formErrors.source}</p>
              ) : sourcesStatus === 'loading' ? (
                <Loader inline size="sm" label="Loading sources…" />
              ) : sourcesStatus === 'failed' ? (
                <p className="field__hint">The sources could not be loaded. Refresh to try again.</p>
              ) : activeSources.length === 0 ? (
                <p className="field__hint">No active sources. An administrator can add them in Settings.</p>
              ) : null}
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
              <label className="field__label" htmlFor="tc-lead-assignee">
                Assign to
              </label>
              <select
                id="tc-lead-assignee"
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
              <label className="field__label" htmlFor="tc-lead-new-status">
                Status
              </label>
              <select
                id="tc-lead-new-status"
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
            aria-busy={creating || undefined}
          >
            {creating ? (
              <>
                <ButtonSpinner />
                Creating…
              </>
            ) : (
              'Create lead'
            )}
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
            aria-busy={bulkBusy || undefined}
            onClick={() => void runBulkAssign()}
          >
            {bulkBusy ? (
              <>
                <ButtonSpinner />
                Assigning…
              </>
            ) : (
              'Assign'
            )}
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
      ) : !data && error ? (
        // Nothing has loaded yet, so "no leads found" would be a guess. The message is in
        // the alert above; this offers the way out.
        <EmptyPanel
          title="The leads could not be loaded"
          message="Check your connection, then try again."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyPanel
          title="No leads found"
          message={
            hasFilters
              ? 'No leads match the current filters.'
              : 'No leads have been created yet. Telecallers can add them from the mobile app, or import them from a spreadsheet.'
          }
          actionLabel={hasFilters ? 'Clear filters' : importAllowed !== false ? 'Import leads' : undefined}
          onAction={hasFilters ? clearFilters : importAllowed !== false ? openImport : undefined}
        />
      ) : (
        <LoadingOverlay busy={loading}>
          <DataTable
            rows={data.items}
            rowKey={(lead) => lead.id}
            rowBusy={(lead) => busyId === lead.id}
            rowTone={(lead) => (isOverdue(lead) ? 'bad' : undefined)}
            /*
             * A shortcut to the Lead View, beside the name link rather than instead of it:
             * a double-click is invisible to a keyboard. DataTable ignores double-clicks
             * that start on the tick box, the status and owner selects or a link, so
             * operating those twice never opens the lead.
             */
            onRowDoubleClick={(lead) => openLead(lead.id)}
            rowTitle={() => 'Double-click to open the lead'}
            /*
             * The sum of the column widths below plus room for the notes, so at its narrowest
             * the table scrolls instead of squeezing the customer, status and owner columns.
             */
            minWidth="90rem"
            caption="Leads, with owner, status, latest note and follow-up dates"
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
                key: 'customer',
                header: 'Customer',
                width: '13rem',
                render: (lead) => (
                  <CellStack
                    primary={<LeadLink leadId={lead.id}>{lead.customerName}</LeadLink>}
                    secondary={lead.phone}
                  >
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
                // Wide enough for the select to show "Callback requested" whole.
                width: '13rem',
                render: (lead) => (
                  <CellStack primary={<LeadStatusBadge status={lead.status} />}>
                    <select
                      className="select select--sm"
                      value={lead.status}
                      disabled={busyId === lead.id}
                      onChange={(event) =>
                        void updateStatus(lead.id, event.target.value as LeadStatus)
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
                width: '11.5rem',
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
                /*
                 * The newest thing anyone wrote about the lead — a call note, a note, a
                 * requirement — or, failing that, what was written when it was taken down.
                 * Two lines and the rest on hover; the link opens the lead at its notes.
                 *
                 * No width: this is the column that takes whatever space is left over.
                 */
                key: 'latestNote',
                header: 'Notes / remarks',
                render: (lead) => {
                  const note = lead.latestNote ?? null;
                  if (!note) return <span className="tc-muted">—</span>;

                  const text = noteText(note);
                  return (
                    <LeadLink
                      leadId={lead.id}
                      className="tc-note-cell"
                      title={text}
                      focus={note.source === 'note' ? 'notes' : undefined}
                    >
                      <span className="tc-note">{text}</span>
                      <span className="tc-note-cell__meta">{noteMeta(note)}</span>
                    </LeadLink>
                  );
                },
              },
              {
                /*
                 * When the lead arrived, next to when it was last worked.
                 *
                 * The two answer different questions and the table was only answering one.
                 * "Last contacted — —" on half the rows says nobody has rung them; it does
                 * not say whether that is because they came in an hour ago or have been
                 * sitting untouched since last month. Only the second is a problem, and
                 * until now the table gave a manager no way to tell them apart.
                 */
                key: 'createdAt',
                header: 'Created',
                width: '8rem',
                render: (lead) => <DateTimeCell value={lead.createdAt} />,
              },
              {
                key: 'lastContacted',
                header: 'Last contacted',
                width: '8rem',
                render: (lead) => <DateTimeCell value={lead.lastContactedAt} />,
              },
              {
                key: 'nextFollowUp',
                header: 'Next follow-up',
                width: '8.5rem',
                render: (lead) => (
                  <CellStack
                    primary={
                      <DateTimeCell
                        value={lead.nextFollowUpAt}
                        tone={isOverdue(lead) ? 'bad' : undefined}
                      />
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
        </LoadingOverlay>
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
