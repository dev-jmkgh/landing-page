'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  addDaysToIsoDate,
  formatDateRange,
  formatDateTime,
  istToIso,
  telecallingApi,
  todayIso,
  type DateRange,
  type Employee,
  type FollowUp,
  type FollowUpScope,
  type MoveFollowUpResult,
  type Paginated,
} from '@/lib/telecalling';
import { MoveFollowUpDialog, describeMove } from './MoveFollowUpDialog';
import { LeadLink, useTelecallingNav } from './nav';
import {
  DateTimeCell,
  EmptyPanel,
  LeadStatusBadge,
  Pager,
  Tag,
  TableSkeleton,
  downloadCsv,
} from './shared';
import { readCustomRange, readEnum, readId, readPage, readText } from './urlState';

/**
 * Follow-up management (spec: Admin Module 8).
 *
 * The scopes are date windows over the pending state, computed server-side — there is no
 * stored "overdue" flag to go stale. An admin can complete, postpone, move, reassign and
 * cancel from here without opening each lead.
 *
 * Moving and reassigning both go through the move dialog and its endpoint, so one set of
 * rules applies however a follow-up changes hands: pending only, no second follow-up with
 * the same customer for the same person on the same day, and a refusal rather than a
 * silent overwrite when someone else got there first.
 *
 * Filters live in the address, so the dashboard's follow-up tiles and charts open this
 * list already filtered, and a refresh or Back returns to it unchanged.
 */

const PAGE_SIZE = 25;

const SCOPES: { key: FollowUpScope; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'pending', label: 'All pending' },
  { key: 'completed', label: 'Completed' },
  /*
   * The dashboard's "Completed today" tile. A tab of its own rather than a chip on
   * Completed, because the tile opens it and the two lists are ordered the same way —
   * newest completion first.
   */
  { key: 'completed_today', label: 'Completed today' },
];

const SCOPE_KEYS = SCOPES.map((option) => option.key);

/** A ceiling on the staff list's pages — a guard against a looping server, not a cap. */
const MAX_STAFF_PAGES = 200;

type Filters = {
  scope: FollowUpScope;
  assignedTo: number | 'all';
  /** A due-date range from a link — a dashboard chart opens the list this way. */
  custom: DateRange | null;
  q: string;
  page: number;
};

function readFilters(params: URLSearchParams): Filters {
  return {
    scope: readEnum(params, 'scope', SCOPE_KEYS, 'overdue'),
    assignedTo: readId(params, 'assignedTo') ?? 'all',
    custom: readCustomRange(params),
    q: readText(params, 'q'),
    page: readPage(params),
  };
}

/**
 * Every approved employee — active and deactivated — for the "Assigned to" filter.
 *
 * Deactivated staff are in it on purpose: follow-ups left with someone who has gone are
 * exactly the ones an admin needs to find. It is a staff list, bounded by headcount, so it
 * is exempt from the one-page-at-a-time rule just as the assignment pickers are (spec §1);
 * it is still read 100 rows a request, every page, so nobody past the hundredth is ever
 * silently missing from the filter.
 */
async function loadApprovedStaff(signal: AbortSignal): Promise<Employee[]> {
  const staff: Employee[] = [];

  for (let page = 1; page <= MAX_STAFF_PAGES; page += 1) {
    const result = await telecallingApi.listEmployees(
      { approval: 'approved', page, pageSize: 100 },
      signal,
    );
    staff.push(...result.items);
    if (result.page >= result.totalPages) break;
  }

  return staff;
}

export function FollowUpsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const nav = useTelecallingNav();
  const { replaceParams, openLead, leadId: openLeadId } = nav;

  // Read once: from here on the state is the source and the address follows it.
  const [initial] = useState(() => readFilters(nav.params));

  const [scope, setScope] = useState<FollowUpScope>(initial.scope);
  const [assignedTo, setAssignedTo] = useState<number | 'all'>(initial.assignedTo);
  const [custom, setCustom] = useState<DateRange | null>(initial.custom);
  const [search, setSearch] = useState(initial.q);
  const [debounced, setDebounced] = useState(initial.q);
  const [page, setPage] = useState(initial.page);

  const [data, setData] = useState<Paginated<FollowUp> | null>(null);
  /** Null until loaded. Everything that hands a follow-up to someone waits for it. */
  const [staff, setStaff] = useState<Employee[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  /** The follow-up in the move dialog, with the employee the inline select picked, if any. */
  const [moving, setMoving] = useState<{ followUp: FollowUp; assignedTo?: number } | null>(null);

  const abort = useRef<AbortController | null>(null);

  /*
   * The search box, debounced. The page goes back to 1 only when the settled text really
   * changes — never on mount, where the page came from the address.
   */
  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;

    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  useEffect(() => {
    const controller = new AbortController();

    loadApprovedStaff(controller.signal)
      .catch(async (caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
        if (caught instanceof ApiError && caught.status === 401) throw caught;
        // The filter can do without the deactivated names; moving cannot do without the
        // active ones. Fall back to those rather than leave every move disabled.
        return telecallingApi.assignableEmployees(controller.signal);
      })
      .then((rows) => setStaff(rows))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError(
          'Could not load the employee list, so follow-ups cannot be moved or reassigned. Refresh the page to try again.',
        );
      });

    return () => controller.abort();
  }, [onUnauthorized]);

  /*
   * A lead opening over this screen closes the move dialog. The screen stays mounted
   * underneath, hidden, and a dialog left open in it would keep the page's scroll locked
   * and its keyboard trapped behind the Lead View.
   */
  useEffect(() => {
    if (openLeadId !== null) setMoving(null);
  }, [openLeadId]);

  /* -------------------------------------------------------- the address */

  useEffect(() => {
    replaceParams(
      {
        scope,
        assignedTo,
        from: custom?.from,
        to: custom?.to,
        q: debounced,
        page,
      },
      { scope: 'overdue', page: 1 },
    );
  }, [replaceParams, scope, assignedTo, custom, debounced, page]);

  /* ------------------------------------------------------------ loading */

  const query = useMemo(
    () => ({
      scope,
      page,
      pageSize: PAGE_SIZE,
      assignedTo,
      q: debounced || undefined,
      ...(custom ?? {}),
    }),
    [scope, page, assignedTo, debounced, custom],
  );

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await telecallingApi.listFollowUps(query, controller.signal);
      setData(result);
      // Past the end — the last row of the last page was just moved, or the address is
      // older than the list — the server answers with its last page. The page follows it,
      // so the address names the page on screen.
      if (result.page !== query.page && !controller.signal.aborted) setPage(result.page);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load follow-ups.');
    } finally {
      // An aborted request's `finally` must not clear the spinner of the one replacing it.
      if (abort.current === controller) setLoading(false);
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
      setNotice({ tone: 'success', text: message });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not update the follow-up.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Pushes a follow-up to 10:00 IST, a whole number of days from today.
   *
   * Relative rather than absolute, because that is how the decision is usually made:
   * "give them another week", not "move it to the 14th" — the Move dialog is there for
   * the 14th. Computed on IST calendar dates and converted with `istToIso`, so a laptop
   * set to another zone still books ten in the morning in India, not ten on its own clock.
   */
  const postpone = (followUp: FollowUp, days: number) => {
    const dueAt = istToIso(addDaysToIsoDate(todayIso(), days), '10:00');
    if (dueAt === null) return;

    return act(
      followUp.id,
      () => telecallingApi.rescheduleFollowUp(followUp.id, dueAt, followUp.note),
      `Moved to ${formatDateTime(dueAt)} IST.`,
    );
  };

  const closeMove = useCallback(() => setMoving(null), []);

  /*
   * After a move the list is reloaded rather than patched: the follow-up may no longer
   * belong in this scope or filter at all — moved to next week, or to someone else.
   */
  const handleMoved = useCallback(
    (result: MoveFollowUpResult) => {
      setMoving(null);
      setError(null);
      setNotice({ tone: result.changed ? 'success' : 'info', text: describeMove(result) });
      void load();
    },
    [load],
  );

  const handleStale = useCallback(
    (message: string) => {
      setMoving(null);
      setNotice({ tone: 'info', text: `${message} The list has been refreshed.` });
      void load();
    },
    [load],
  );

  /** "Show the existing follow-up" from a duplicate refusal: the pending ones on that lead. */
  const showExisting = useCallback((lead: { reference: string }) => {
    setMoving(null);
    setScope('pending');
    setAssignedTo('all');
    setCustom(null);
    setSearch(lead.reference);
    setDebounced(lead.reference);
    setPage(1);
    setNotice({ tone: 'info', text: `Showing the pending follow-ups for ${lead.reference}.` });
  }, []);

  const exportCsv = () => {
    if (!data) return;

    downloadCsv(
      `jmk-followups-${scope}-${todayIso()}.csv`,
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
        // Appended so every earlier column keeps its position for existing spreadsheets.
        'Lead owner',
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
        row.leadAssignedToName ?? 'Unassigned',
      ]),
    );
  };

  /* ------------------------------------------------------------- render */

  const activeStaff = useMemo(() => (staff ?? []).filter((employee) => employee.isActive), [staff]);
  const formerStaff = useMemo(() => (staff ?? []).filter((employee) => !employee.isActive), [staff]);
  const activeIds = useMemo(() => new Set(activeStaff.map((employee) => employee.id)), [activeStaff]);

  const showAssigneeFallback =
    assignedTo !== 'all' && !(staff ?? []).some((employee) => employee.id === assignedTo);
  /* Who that is, when the page on screen says — its rows are filtered to them. */
  const fallbackAssigneeName = showAssigneeFallback
    ? (data?.items.find((row) => row.assignedTo === assignedTo)?.assignedToName ?? null)
    : null;

  const empty = (() => {
    const filtered = assignedTo !== 'all' || debounced !== '' || custom !== null;
    const more = filtered ? ' Clear the filters to see more.' : '';

    switch (scope) {
      case 'overdue':
        return { title: 'Nothing overdue', message: `Every follow-up is on schedule.${more}` };
      case 'today':
        return {
          title: 'Nothing due today',
          message: `No pending follow-up falls due today (IST).${more}`,
        };
      case 'completed_today':
        return {
          title: 'Nothing completed today yet',
          message: `Follow-ups completed since midnight IST appear here.${more}`,
        };
      default:
        return { title: 'No follow-ups here', message: 'Nothing matches this scope and filter.' };
    }
  })();

  const customText = custom ? formatDateRange(custom) : null;

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
              onClick={() => {
                if (option.key === scope) return;
                setScope(option.key);
                setPage(1);
              }}
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
              onChange={(event) => {
                setAssignedTo(event.target.value === 'all' ? 'all' : Number(event.target.value));
                setPage(1);
              }}
            >
              <option value="all">Everyone</option>
              {/*
                Someone in the address who is in neither list — never approved, or from an
                old link. Without it the select would read "Everyone" while filtering.
              */}
              {showAssigneeFallback ? (
                <option value={String(assignedTo)}>
                  {fallbackAssigneeName
                    ? // "Inactive" only once the staff list has arrived without them.
                      staff === null
                      ? fallbackAssigneeName
                      : `${fallbackAssigneeName} (inactive)`
                    : staff === null
                      ? 'Selected employee'
                      : 'Former employee (inactive)'}
                </option>
              ) : null}
              {activeStaff.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
              {formerStaff.length > 0 ? (
                <optgroup label="Deactivated">
                  {formerStaff.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} (deactivated)
                    </option>
                  ))}
                </optgroup>
              ) : null}
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

      {customText !== null ? (
        <div className="tc-panel-head">
          {/*
            The due dates a link opened this list on — a dashboard chart's period. Shown
            the way the call list shows an explicit range, and removed the same way.
          */}
          <div className="tc-segmented" role="group" aria-label="Due date">
            <span className="tc-segmented__chip">
              Due {customText}
              <button
                type="button"
                className="tc-segmented__clear"
                onClick={() => {
                  setCustom(null);
                  setPage(1);
                }}
                aria-label={`Remove the due date range ${customText}`}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          </div>
        </div>
      ) : null}

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant={notice.tone}>{notice.text}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {data.items.length === 0 ? (
            <EmptyPanel title={empty.title} message={empty.message} />
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.id}
              rowBusy={(row) => busyId === row.id}
              rowTone={(row) => (row.isOverdue ? 'bad' : undefined)}
              /*
               * Sized to fit beside the sidebar on a 1366px screen, so the actions are never
               * scrolled out of view; the note column takes the rest.
               */
              minWidth="62rem"
              caption="Follow-ups, with their due date, customer, owner and available actions"
              onRowDoubleClick={(row) => openLead(row.leadId)}
              rowTitle={() => 'Double-click to open the lead'}
              columns={[
                {
                  key: 'due',
                  header: 'Due',
                  width: '9rem',
                  render: (row) => (
                    <CellStack
                      primary={
                        <DateTimeCell value={row.dueAt} tone={row.isOverdue ? 'bad' : undefined} />
                      }
                    >
                      {row.isOverdue ? <Tag tone="bad">Overdue</Tag> : null}
                      {/*
                        Worth showing: a follow-up postponed four times is usually a lead
                        that needs a different conversation, not a fifth reminder.
                      */}
                      {row.rescheduleCount > 0 ? (
                        <span className="tc-muted">
                          Moved {row.rescheduleCount}{' '}
                          {row.rescheduleCount === 1 ? 'time' : 'times'}
                        </span>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'customer',
                  header: 'Customer',
                  width: '13rem',
                  render: (row) => (
                    <CellStack
                      primary={<LeadLink leadId={row.leadId}>{row.leadName}</LeadLink>}
                      secondary={row.leadPhone}
                    >
                      <LeadStatusBadge status={row.leadStatus} />
                      {/*
                        A follow-up held by someone other than the lead's owner: they will
                        see it in the app but cannot open the lead. Worth knowing before
                        anyone wonders why it was never done.
                      */}
                      {row.state === 'pending' && row.leadAssignedTo !== row.assignedTo ? (
                        <span className="tc-muted">
                          Lead with {row.leadAssignedToName ?? 'nobody'}
                        </span>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'assigned',
                  header: 'Assigned to',
                  width: '11rem',
                  render: (row) =>
                    row.state === 'pending' ? (
                      /*
                        Choosing someone here opens the move dialog with them preselected,
                        rather than reassigning on the spot: the dialog shows what changes,
                        offers to transfer the lead, and applies the same duplicate and
                        conflict rules as any other move.
                      */
                      <select
                        className="select select--sm"
                        value={row.assignedTo === null ? '' : String(row.assignedTo)}
                        disabled={busyId === row.id || staff === null}
                        onChange={(event) => {
                          if (!event.target.value) return;
                          setNotice(null);
                          setMoving({ followUp: row, assignedTo: Number(event.target.value) });
                        }}
                        aria-label={`Reassign the follow-up for ${row.leadName}`}
                      >
                        {row.assignedTo === null ? (
                          <option value="" disabled>
                            Unassigned
                          </option>
                        ) : null}
                        {/*
                          A holder who has been deactivated is shown as the current value —
                          otherwise the select would display the first name in the list as
                          if it were the holder — but cannot be chosen again.
                        */}
                        {row.assignedTo !== null && !activeIds.has(row.assignedTo) ? (
                          <option value={String(row.assignedTo)} disabled>
                            {row.assignedToName ?? 'Former employee'} (deactivated)
                          </option>
                        ) : null}
                        {activeStaff.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (row.assignedToName ?? '—')
                    ),
                },
                {
                  /* No width: this is the column that absorbs whatever space is left. */
                  key: 'note',
                  header: 'Note',
                  render: (row) => (
                    <CellStack
                      primary={
                        row.note ? (
                          <span className="tc-note" title={row.note}>
                            {row.note}
                          </span>
                        ) : (
                          <span className="tc-muted">—</span>
                        )
                      }
                      secondary={row.state === 'completed' ? row.outcomeNote : null}
                    >
                      {row.state === 'completed' ? (
                        <Tag tone="good">
                          Done {formatDateTime(row.completedAt)}
                          {row.completedByName ? ` by ${row.completedByName}` : ''}
                        </Tag>
                      ) : null}
                      {row.state === 'cancelled' ? <Tag>Cancelled</Tag> : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  // Two rows: Complete, +1 day, +1 week — then Move…, Cancel.
                  width: '19.5rem',
                  render: (row) =>
                    row.state === 'pending' ? (
                      <CellActions>
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
                          title="Tomorrow at 10:00 am IST"
                        >
                          +1 day
                        </button>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => void postpone(row, 7)}
                          title="A week from today at 10:00 am IST"
                        >
                          +1 week
                        </button>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id || staff === null}
                          onClick={() => {
                            setNotice(null);
                            setMoving({ followUp: row });
                          }}
                        >
                          Move…
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
                      </CellActions>
                    ) : (
                      <span className="tc-muted">—</span>
                    ),
                },
              ]}
            />
          )}
        </LoadingOverlay>
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

      {moving ? (
        <MoveFollowUpDialog
          key={moving.followUp.id}
          followUp={moving.followUp}
          employees={activeStaff}
          initialAssignedTo={moving.assignedTo}
          onClose={closeMove}
          onMoved={handleMoved}
          onStale={handleStale}
          onUnauthorized={onUnauthorized}
          onShowExisting={showExisting}
        />
      ) : null}
    </>
  );
}
