'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  CALL_LINES,
  CALL_LINE_LABELS,
  CALL_OUTCOMES,
  CALL_OUTCOME_FILTERS,
  CALL_OUTCOME_FILTER_LABELS,
  CALL_OUTCOME_LABELS,
  CALL_SOURCE_LABELS,
  NOTE_KIND_LABELS,
  SIM_MATCH_LABELS,
  formatCompanyPhone,
  formatCount,
  formatDateTime,
  formatDuration,
  humanise,
  listCallsOnLine,
  telecallingApi,
  todayIso,
  type Call,
  type CallDirection,
  type CallLine,
  type CallList,
  type CallOutcomeFilter,
  type CallQuery,
  type DateRange,
  type Employee,
  type Paginated,
  type Recording,
} from '@/lib/telecalling';
import { LeadLink, useTelecallingNav } from './nav';
import {
  EmptyPanel,
  Pager,
  RangePicker,
  Tag,
  TableSkeleton,
  downloadCsv,
  rangeFor,
  type RangePreset,
} from './shared';
import { readCustomRange, readEnum, readId, readPage, readRange, readText } from './urlState';

/**
 * Call monitoring and recordings (spec: Admin Modules 6 and 7).
 *
 * Three tabs on one screen: every call, the incoming calls on their own, and the subset
 * that has audio. They share the employee and date filters, which is the reason they are
 * together — a manager investigating one employee's day wants every view of it without
 * re-filtering.
 *
 * The filters live in the address (urlState.ts), so a refresh, a shared link, the Back
 * button and a dashboard tile all land on exactly this view. A tile's link may carry an
 * explicit `from`/`to` instead of a preset — a chart bucket opened onto the days it
 * counted — shown as a removable chip in the range picker.
 */

const PAGE_SIZE = 25;

const TABS = ['calls', 'incoming', 'recordings'] as const;
type Tab = (typeof TABS)[number];

type DirectionFilter = 'all' | CallDirection;
const DIRECTION_FILTERS: readonly DirectionFilter[] = ['all', 'outgoing', 'incoming'];

/*
 * Two filter values the address would otherwise lose. urlState leaves `all` out of every
 * address, because every select spells "no filter" that way — but these two defaults are
 * not "everything": the range defaults to the last 7 days and the line to the company SIM.
 * "All time" and "every line" are choices of their own, so they get spellings that survive.
 */
const ALL_TIME_PARAM = 'all-time';
const ANY_LINE_PARAM = 'any';

/** A note longer than this, or one with a line break, gets a "Show more" toggle. */
const NOTE_PREVIEW_CHARS = 140;

type Filters = {
  tab: Tab;
  preset: RangePreset;
  /** An explicit range from a link, standing in for the preset until it is removed. */
  custom: DateRange | null;
  employeeId: number | 'all';
  direction: DirectionFilter;
  outcome: CallOutcomeFilter | 'all';
  line: CallLine;
  q: string;
  page: number;
};

/** The view the address describes. Anything unreadable falls back to its default. */
function readFilters(params: URLSearchParams): Filters {
  return {
    tab: readEnum(params, 'tab', TABS, 'calls'),
    preset: params.get('range') === ALL_TIME_PARAM ? 'all' : readRange(params, 'week'),
    custom: readCustomRange(params),
    employeeId: readId(params, 'userId') ?? 'all',
    direction: readEnum(params, 'direction', DIRECTION_FILTERS, 'all'),
    outcome: readEnum<CallOutcomeFilter | 'all'>(params, 'outcome', CALL_OUTCOME_FILTERS, 'all'),
    line: params.get('line') === ANY_LINE_PARAM ? 'all' : readEnum(params, 'line', CALL_LINES, 'company'),
    q: readText(params, 'q'),
    page: readPage(params),
  };
}

export function CallsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const nav = useTelecallingNav();
  const { replaceParams, openLead, go, leadId: openLeadId } = nav;

  // Read once: from here on the state is the source and the address follows it.
  const [initial] = useState(() => readFilters(nav.params));

  const [tab, setTab] = useState<Tab>(initial.tab);
  const [preset, setPreset] = useState<RangePreset>(initial.preset);
  const [custom, setCustom] = useState<DateRange | null>(initial.custom);
  const [employeeId, setEmployeeId] = useState<number | 'all'>(initial.employeeId);
  const [outcome, setOutcome] = useState<CallOutcomeFilter | 'all'>(initial.outcome);
  /*
   * Incoming calls are read off the telecaller's handset and logged through the same
   * endpoint as outgoing ones, so they arrive in this table mixed in with the rest. A
   * manager asking "how much business is the phone bringing us" cannot answer it from a
   * mixed list, and the direction column alone does not filter.
   */
  const [direction, setDirection] = useState<DirectionFilter>(initial.direction);
  /*
   * Which incoming calls count: those verified as reaching the employee's company SIM
   * (the default, and all any figure counts), the older ones recorded before that check
   * existed, or both.
   */
  const [line, setLine] = useState<CallLine>(initial.line);
  const [search, setSearch] = useState(initial.q);
  const [debounced, setDebounced] = useState(initial.q);
  const [page, setPage] = useState(initial.page);

  const [calls, setCalls] = useState<CallList | null>(null);
  const [recordings, setRecordings] = useState<Paginated<Recording> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** The recording currently expanded for playback. */
  const [playingId, setPlayingId] = useState<number | null>(null);
  /** The call whose note is shown in full rather than cut to two lines. */
  const [expandedNoteId, setExpandedNoteId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  /** The Incoming tab is the call list with the direction fixed. */
  const effectiveDirection: DirectionFilter = tab === 'incoming' ? 'incoming' : direction;
  /** Outgoing calls have no receiving line, so the line filter means nothing for them. */
  const lineApplies = tab !== 'recordings' && effectiveDirection !== 'outgoing';

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
    let cancelled = false;
    telecallingApi
      .assignableEmployees()
      .then((rows) => {
        if (!cancelled) setEmployees(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setEmployeesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The recording player is closed when a lead opens over this screen. The screen stays
   * mounted underneath, hidden, and the shell pauses any audio — but an <audio> left
   * mounted can still start (autoplay landing late) and keeps its stream open. Unmounting
   * it is the certain stop.
   */
  useEffect(() => {
    if (openLeadId !== null) setPlayingId(null);
  }, [openLeadId]);

  /* -------------------------------------------------------- the address */

  useEffect(() => {
    replaceParams(
      {
        tab,
        range: preset === 'all' ? ALL_TIME_PARAM : preset,
        from: custom?.from,
        to: custom?.to,
        userId: employeeId,
        // Only the filters that apply to what is showing, so the address never claims a
        // filter the screen is not using.
        direction: tab === 'calls' ? direction : undefined,
        outcome: tab === 'recordings' ? undefined : outcome,
        line: lineApplies ? (line === 'all' ? ANY_LINE_PARAM : line) : undefined,
        q: debounced,
        page,
      },
      { tab: 'calls', range: 'week', line: 'company', page: 1 },
    );
  }, [replaceParams, tab, preset, custom, employeeId, direction, outcome, line, lineApplies, debounced, page]);

  /* ------------------------------------------------------------ loading */

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    // Worked out on every load, not memoised on the preset: Refresh on a screen left open
    // past IST midnight must ask for today, not keep yesterday's window.
    const range = custom ?? rangeFor(preset);

    setLoading(true);
    setError(null);

    /*
     * A page past the end — from an address older than the list — comes back from the
     * server as its last page. The page follows, so the address names the page on screen.
     */
    const followPage = (served: number) => {
      if (served !== page && !controller.signal.aborted) setPage(served);
    };

    try {
      if (tab === 'recordings') {
        const result = await telecallingApi.listRecordings(
          {
            page,
            pageSize: PAGE_SIZE,
            userId: employeeId,
            q: debounced || undefined,
            ...range,
          },
          controller.signal,
        );
        setRecordings(result);
        followPage(result.page);
      } else {
        const query: CallQuery = {
          page,
          pageSize: PAGE_SIZE,
          userId: employeeId,
          outcome,
          direction: effectiveDirection,
          line: lineApplies ? line : undefined,
          q: debounced || undefined,
          ...range,
        };
        const result = await listCallsOnLine(query, controller.signal);
        setCalls(result);
        followPage(result.page);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }

      /**
       * A 403 on the recordings tab is expected for a supervisor, not a fault.
       *
       * Recording access is manager-and-above: call metadata says a call happened, a
       * recording is the customer's voice. Saying so plainly stops it being reported as
       * a bug.
       */
      if (caught instanceof ApiError && caught.status === 403) {
        setError(
          tab === 'recordings'
            ? 'Your role can see call activity but not the recordings. Ask an administrator if you need access.'
            : caught.message,
        );
        return;
      }

      setError(caught instanceof ApiError ? caught.message : 'Could not load call activity.');
    } finally {
      // An aborted request's `finally` must not clear the spinner of the one replacing it.
      if (abort.current === controller) setLoading(false);
    }
  }, [tab, page, employeeId, outcome, effectiveDirection, line, lineApplies, debounced, custom, preset, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  /* ------------------------------------------------------------ filters */

  /*
   * Every change goes back to page 1 in its own handler rather than in an effect watching
   * the filters: such an effect also runs on mount, and would overwrite a page number the
   * address asked for.
   */

  const changeTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    // The Incoming tab opens on the verified calls, and so does every tab after it — a
    // line chosen for one view would otherwise quietly narrow the next.
    setLine('company');
    setExpandedNoteId(null);
  };

  const exportCalls = () => {
    if (!calls) return;

    downloadCsv(
      `jmk-${tab === 'incoming' ? 'incoming-calls' : 'calls'}-${todayIso()}.csv`,
      [
        'Started',
        'Employee',
        'Customer',
        'Reference',
        'Number',
        'Direction',
        'Outcome',
        'Duration (seconds)',
        'Source',
        'Recorded',
        // Appended, never inserted: spreadsheets built on this export read columns by
        // position, and every column before these keeps its place.
        'Note',
        'Note by',
        'Received on',
        'Line check',
      ],
      calls.items.map((call) => [
        formatDateTime(call.startedAt),
        call.userName,
        call.leadName ?? 'Unknown number',
        call.leadReference,
        call.phone,
        humanise(call.direction),
        CALL_OUTCOME_LABELS[call.outcome],
        call.durationSeconds,
        // Included because it changes how a duration should be read: measured from the
        // Android call log, or typed in by the telecaller.
        CALL_SOURCE_LABELS[call.source],
        call.hasRecording ? 'Yes' : 'No',
        call.latestNote?.body ?? '',
        call.latestNote ? (call.latestNote.authorName ?? 'Unknown') : '',
        call.direction === 'incoming' ? (call.receivedOnPhone ?? '') : '',
        call.direction === 'incoming'
          ? call.simMatch
            ? SIM_MATCH_LABELS[call.simMatch]
            : 'Not verified'
          : '',
      ]),
    );
  };

  const current = tab === 'recordings' ? recordings : calls;

  /* ------------------------------------------------------------ columns */

  const callColumns: Column<Call>[] = [
    {
      key: 'when',
      header: 'When',
      width: '11rem',
      nowrap: true,
      render: (call) => formatDateTime(call.startedAt),
    },
    {
      key: 'employee',
      header: 'Employee',
      width: '9rem',
      render: (call) => call.userName ?? '—',
    },
    {
      key: 'customer',
      header: 'Customer',
      width: '13rem',
      render: (call) => (
        <CellStack
          primary={
            call.leadId !== null ? (
              <LeadLink leadId={call.leadId}>
                {call.leadName ?? call.leadReference ?? 'Open the lead'}
              </LeadLink>
            ) : (
              'Unknown number'
            )
          }
          secondary={call.phone}
        >
          {call.leadReference ? (
            <span className="tc-muted tc-mono">{call.leadReference}</span>
          ) : null}
        </CellStack>
      ),
    },
    {
      /* No width: the note is the column that absorbs whatever space is left. */
      key: 'notes',
      header: 'Notes',
      render: (call) => (
        <CallNote
          call={call}
          expanded={expandedNoteId === call.id}
          onToggle={() => setExpandedNoteId((id) => (id === call.id ? null : call.id))}
        />
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      width: '11rem',
      render: (call) => (
        <CellStack
          primary={
            <Tag tone={call.outcome === 'answered' ? 'good' : 'neutral'}>
              {CALL_OUTCOME_LABELS[call.outcome]}
            </Tag>
          }
          secondary={humanise(call.direction)}
        >
          {!call.followedUp && call.outcome !== 'answered' ? (
            <Tag tone="bad">Callback pending</Tag>
          ) : null}
        </CellStack>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      /* Right-aligned so a column of durations lines up digit for digit. */
      align: 'end',
      width: '7rem',
      nowrap: true,
      render: (call) => formatDuration(call.durationSeconds),
    },
    {
      key: 'source',
      header: 'How logged',
      width: '9rem',
      render: (call) => (
        <CellStack
          primary={
            /*
              Surfaced deliberately. A duration read from the Android call log is
              measured; one typed into the post-call sheet on an iPhone is
              remembered. A manager comparing two telecallers on different
              platforms needs to know which is which.
            */
            <Tag tone={call.source === 'manual' ? 'neutral' : 'good'}>
              {CALL_SOURCE_LABELS[call.source]}
            </Tag>
          }
        >
          {call.hasRecording ? <Tag tone="progress">Recorded</Tag> : null}
        </CellStack>
      ),
    },
  ];

  /*
   * Which company number an incoming call reached, and how the handset proved it. Only
   * where incoming calls can be listed: on outgoing calls it would be a column of dashes.
   */
  if (lineApplies) {
    callColumns.push({
      key: 'line',
      header: 'Received on',
      width: '11rem',
      render: (call) =>
        call.direction !== 'incoming' ? (
          <span className="tc-muted">—</span>
        ) : call.simMatch ? (
          <CellStack
            primary={
              call.receivedOnPhone ? (
                formatCompanyPhone(call.receivedOnPhone)
              ) : (
                <span className="tc-muted">Number not recorded</span>
              )
            }
          >
            <Tag tone="good">{SIM_MATCH_LABELS[call.simMatch]}</Tag>
          </CellStack>
        ) : (
          /*
            Recorded before calls were checked against the company SIM, so it may have
            been a personal call. Shown, because an admin asked for these, but marked.
          */
          <Tag tone="bad">Not verified</Tag>
        ),
    });
  }

  const recordingColumns: Column<Recording>[] = [
    {
      key: 'call',
      header: 'Call',
      width: '11rem',
      nowrap: true,
      render: (recording) => formatDateTime(recording.callStartedAt ?? recording.createdAt),
    },
    {
      key: 'employee',
      header: 'Employee',
      width: '11rem',
      render: (recording) => recording.userName ?? '—',
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (recording) => (
        <CellStack
          primary={
            recording.leadId !== null ? (
              <LeadLink leadId={recording.leadId}>
                {recording.leadName ?? recording.leadReference ?? 'Open the lead'}
              </LeadLink>
            ) : (
              (recording.leadName ?? '—')
            )
          }
        >
          {recording.leadReference ? (
            <span className="tc-muted tc-mono">{recording.leadReference}</span>
          ) : null}
        </CellStack>
      ),
    },
    {
      key: 'length',
      header: 'Length',
      align: 'end',
      width: '7rem',
      nowrap: true,
      render: (recording) => formatDuration(recording.durationSeconds),
    },
    {
      key: 'listen',
      header: 'Listen',
      align: 'end',
      width: '17rem',
      render: (recording) =>
        playingId === recording.id ? (
          /*
           * The audio element is mounted only after the manager asks for it.
           * Rendering twenty-five of them would fire twenty-five authenticated
           * requests for customer call audio — and write twenty-five access-audit
           * entries — for a page that was merely scrolled past.
           */
          <audio
            controls
            autoPlay
            preload="none"
            src={telecallingApi.recordingAudioUrl(recording.id)}
            style={{ maxWidth: '15rem' }}
          />
        ) : (
          <CellActions>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => setPlayingId(recording.id)}
            >
              <Icon name="phone" size={15} />
              Play
            </button>
          </CellActions>
        ),
    },
  ];

  /* ------------------------------------------------------------- render */

  const showEmployeeFallback =
    employeeId !== 'all' && !employees.some((employee) => employee.id === employeeId);
  /*
   * Who that is, when the page on screen says: its rows are filtered to them, so any row
   * carries their name. Until a row arrives — or when they have none in this period — the
   * option says what it can.
   */
  const fallbackName = showEmployeeFallback
    ? ((tab === 'recordings'
        ? recordings?.items.find((recording) => recording.userId === employeeId)?.userName
        : calls?.items.find((call) => call.userId === employeeId)?.userName) ?? null)
    : null;

  const callsEmpty =
    effectiveDirection === 'incoming' && line === 'unverified' ? (
      <EmptyPanel
        title="No unverified incoming calls"
        message="These are incoming calls recorded before calls were checked against the company SIM, kept for review. None match these filters — widen the date range or choose another employee."
      />
    ) : effectiveDirection === 'incoming' ? (
      <EmptyPanel
        title="No incoming calls in this period"
        message="Incoming calls appear here when a telecaller's company SIM receives them and they open the app. Check that each telecaller has set up their company SIM."
        actionLabel="Show who has not set up their SIM"
        onAction={() => go('employees', { companySim: 'missing' })}
      />
    ) : (
      <EmptyPanel
        title="No calls in this period"
        message="Widen the date range, or check that telecallers are logging calls from the mobile app."
      />
    );

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Call view">
          <button
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === 'calls'}
            onClick={() => changeTab('calls')}
          >
            All calls
          </button>
          <button
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === 'incoming'}
            onClick={() => changeTab('incoming')}
          >
            Incoming
          </button>
          <button
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === 'recordings'}
            onClick={() => changeTab('recordings')}
          >
            Recordings
          </button>
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="tc-call-search">
              Search
            </label>
            <input
              id="tc-call-search"
              className="input"
              type="search"
              value={search}
              placeholder="Customer, employee or number"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '15rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-call-employee">
              Employee
            </label>
            <select
              id="tc-call-employee"
              className="select"
              value={String(employeeId)}
              onChange={(event) => {
                setEmployeeId(event.target.value === 'all' ? 'all' : Number(event.target.value));
                setPage(1);
              }}
            >
              <option value="all">Everyone</option>
              {/*
                An employee in the address who is not in the active list — someone since
                deactivated, from an old link. Without this option the select would show
                "Everyone" while the list is still filtered to them.
              */}
              {showEmployeeFallback ? (
                <option value={String(employeeId)}>
                  {fallbackName
                    ? // "Inactive" only once the active list has arrived without them.
                      employeesLoaded
                      ? `${fallbackName} (inactive)`
                      : fallbackName
                    : employeesLoaded
                      ? 'Former employee (inactive)'
                      : 'Selected employee'}
                </option>
              ) : null}
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>

          {tab === 'calls' ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-call-direction">
                Direction
              </label>
              <select
                id="tc-call-direction"
                className="select"
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value as DirectionFilter);
                  setPage(1);
                }}
              >
                <option value="all">Both directions</option>
                <option value="outgoing">Outgoing</option>
                <option value="incoming">Incoming</option>
              </select>
            </div>
          ) : null}

          {lineApplies ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-call-line">
                Line
              </label>
              <select
                id="tc-call-line"
                className="select"
                value={line}
                onChange={(event) => {
                  setLine(event.target.value as CallLine);
                  setPage(1);
                }}
              >
                {CALL_LINES.map((value) => (
                  <option key={value} value={value}>
                    {CALL_LINE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {tab !== 'recordings' ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-call-outcome">
                Outcome
              </label>
              <select
                id="tc-call-outcome"
                className="select"
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value as CallOutcomeFilter | 'all');
                  setPage(1);
                }}
              >
                <option value="all">All outcomes</option>
                {/*
                  Every unanswered outcome at once — what the dashboard's "Not answered"
                  tile counts. Straight under "All outcomes" because it is the broader of
                  the two kinds of choice here.
                */}
                <option value="unanswered">{CALL_OUTCOME_FILTER_LABELS.unanswered}</option>
                {CALL_OUTCOMES.map((value) => (
                  <option key={value} value={value}>
                    {CALL_OUTCOME_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          {tab !== 'recordings' ? (
            <button
              type="button"
              className="btn btn--outline"
              onClick={exportCalls}
              disabled={!calls || calls.items.length === 0}
            >
              <Icon name="download" size={16} />
              Export page
            </button>
          ) : null}
        </div>
      </div>

      <div className="tc-panel-head">
        <RangePicker
          value={preset}
          onChange={(next) => {
            setPreset(next);
            setCustom(null);
            setPage(1);
          }}
          custom={custom}
          onClearCustom={() => {
            setCustom(null);
            setPage(1);
          }}
        />
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {current === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : tab === 'recordings' ? (
        <LoadingOverlay busy={loading}>
          {recordings === null || recordings.items.length === 0 ? (
            <EmptyPanel
              title="No recordings"
              message="Call recording is not available through the device dialler — Android 10+ and every version of iOS block it. Recordings appear here once calls are routed through a telephony provider."
            />
          ) : (
            <DataTable
              rows={recordings.items}
              rowKey={(recording) => recording.id}
              minWidth="58rem"
              caption="Call recordings available to play"
              columns={recordingColumns}
              onRowDoubleClick={(recording) => {
                if (recording.leadId !== null) openLead(recording.leadId);
              }}
              rowTitle={(recording) =>
                recording.leadId !== null ? 'Double-click to open the lead' : undefined
              }
            />
          )}
        </LoadingOverlay>
      ) : (
        <LoadingOverlay busy={loading}>
          {calls === null || calls.items.length === 0 ? (
            callsEmpty
          ) : (
            <>
              {calls.summary ? <CallSummary total={calls.total} summary={calls.summary} /> : null}
              <DataTable
                rows={calls.items}
                rowKey={(call) => call.id}
                minWidth={lineApplies ? '88rem' : '78rem'}
                caption="Calls, with employee, customer, the latest note, outcome and how the record was captured"
                columns={callColumns}
                /*
                  Double-click opens the call's lead — where it has one. A call from a
                  number that matches no lead has nothing to open, so its row neither
                  reacts nor carries the hint.
                */
                onRowDoubleClick={(call) => {
                  if (call.leadId !== null) openLead(call.leadId);
                }}
                rowTitle={(call) => (call.leadId !== null ? 'Double-click to open the lead' : undefined)}
              />
            </>
          )}
        </LoadingOverlay>
      )}

      {current ? (
        <Pager
          page={current.page}
          totalPages={current.totalPages}
          total={current.total}
          noun={tab === 'recordings' ? 'recording' : tab === 'incoming' ? 'incoming call' : 'call'}
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}

/**
 * The whole filtered list's figures, in one line above the table.
 *
 * From the server's `summary`, which uses the same filter as the total — so on a list
 * opened from a dashboard tile, the talk time and answer rate here are the tile's own.
 * The rate is rounded exactly as the dashboard rounds it.
 */
function CallSummary({
  total,
  summary,
}: {
  total: number;
  summary: NonNullable<CallList['summary']>;
}) {
  if (total === 0) return null;

  const rate = Math.round((summary.answered / total) * 100);

  return (
    <p className="tc-call-summary">
      <span>
        <strong>{formatCount(total)}</strong> {total === 1 ? 'call' : 'calls'}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong>{formatCount(summary.answered)}</strong> answered ({rate}%)
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong>{formatCount(summary.unanswered)}</strong> not answered
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {summary.talkTimeSeconds > 0 ? (
          <>
            <strong>{formatDuration(summary.talkTimeSeconds)}</strong> talk time
          </>
        ) : (
          'no talk time'
        )}
      </span>
    </p>
  );
}

/**
 * The newest note written against a call, cut to two lines.
 *
 * A call can be written up more than once, so this is the latest note plus a count of the
 * rest. The count links to the lead's call history, where every note sits under its call.
 * The full text is in the tooltip, and behind "Show more" for a note too long to skim.
 */
function CallNote({
  call,
  expanded,
  onToggle,
}: {
  call: Call;
  expanded: boolean;
  onToggle: () => void;
}) {
  const note = call.latestNote;
  if (!note) return <span className="tc-muted">—</span>;

  const long = note.body.length > NOTE_PREVIEW_CHARS || note.body.includes('\n');
  const earlier = call.noteCount - 1;
  const kind = note.kind === 'call_note' ? null : NOTE_KIND_LABELS[note.kind];

  return (
    <CellStack
      primary={
        <span className={expanded ? 'tc-note tc-note--open' : 'tc-note'} title={expanded ? undefined : note.body}>
          {note.body}
        </span>
      }
      secondary={[kind, note.authorName ?? 'Unknown', formatDateTime(note.createdAt)]
        .filter(Boolean)
        .join(' · ')}
    >
      {long ? (
        <button type="button" className="tc-text-button" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      {earlier > 0 ? (
        call.leadId !== null ? (
          <LeadLink
            leadId={call.leadId}
            focus="calls"
            className="tc-badge tc-badge--neutral tc-badge-link"
            title="Open the lead's call history to read every note"
          >
            +{earlier} earlier
          </LeadLink>
        ) : (
          <Tag>+{earlier} earlier</Tag>
        )
      ) : null}
    </CellStack>
  );
}
