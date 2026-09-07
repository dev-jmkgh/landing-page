'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  CALL_OUTCOMES,
  CALL_OUTCOME_LABELS,
  formatDateTime,
  formatDuration,
  humanise,
  telecallingApi,
  type Call,
  type CallOutcome,
  type CallQuery,
  type Employee,
  type Paginated,
  type Recording,
} from '@/lib/telecalling';
import { EmptyPanel, Pager, RangePicker, Tag, TableSkeleton, downloadCsv, rangeFor, type RangePreset } from './shared';

/**
 * Call monitoring and recordings (spec: Admin Modules 6 and 7).
 *
 * Two tabs on one screen: every call, and the subset that has audio. They share the
 * employee and date filters, which is the reason they are together — a manager
 * investigating one employee's day wants both views of it without re-filtering.
 */

const PAGE_SIZE = 25;

type Tab = 'calls' | 'recordings';

export function CallsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>('calls');
  const [preset, setPreset] = useState<RangePreset>('week');
  const [employeeId, setEmployeeId] = useState<number | 'all'>('all');
  const [outcome, setOutcome] = useState<CallOutcome | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [calls, setCalls] = useState<Paginated<Call> | null>(null);
  const [recordings, setRecordings] = useState<Paginated<Recording> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** The recording currently expanded for playback. */
  const [playingId, setPlayingId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [tab, preset, employeeId, outcome, debounced]);

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

  const range = useMemo(() => rangeFor(preset), [preset]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      if (tab === 'calls') {
        const query: CallQuery = {
          page,
          pageSize: PAGE_SIZE,
          userId: employeeId,
          outcome,
          q: debounced || undefined,
          ...range,
        };
        setCalls(await telecallingApi.listCalls(query, controller.signal));
      } else {
        setRecordings(
          await telecallingApi.listRecordings(
            {
              page,
              pageSize: PAGE_SIZE,
              userId: employeeId,
              q: debounced || undefined,
              ...range,
            },
            controller.signal,
          ),
        );
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
          'Your role can see call activity but not the recordings. Ask an administrator if you need access.',
        );
        return;
      }

      setError(caught instanceof ApiError ? caught.message : 'Could not load call activity.');
    } finally {
      setLoading(false);
    }
  }, [tab, page, employeeId, outcome, debounced, range, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const exportCalls = () => {
    if (!calls) return;

    downloadCsv(
      `jmk-calls-${new Date().toISOString().slice(0, 10)}.csv`,
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
        call.source === 'call_log' ? 'Measured' : call.source === 'manual' ? 'Self-reported' : 'Provider',
        call.hasRecording ? 'Yes' : 'No',
      ]),
    );
  };

  const current = tab === 'calls' ? calls : recordings;

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Call view">
          <button
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === 'calls'}
            onClick={() => setTab('calls')}
          >
            All calls
          </button>
          <button
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={tab === 'recordings'}
            onClick={() => setTab('recordings')}
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
              onChange={(event) =>
                setEmployeeId(event.target.value === 'all' ? 'all' : Number(event.target.value))
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

          {tab === 'calls' ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-call-outcome">
                Outcome
              </label>
              <select
                id="tc-call-outcome"
                className="select"
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as CallOutcome | 'all')}
              >
                <option value="all">All outcomes</option>
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

          {tab === 'calls' ? (
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
        <RangePicker value={preset} onChange={setPreset} />
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {loading && !current ? (
        <TableSkeleton />
      ) : tab === 'calls' ? (
        !calls || calls.items.length === 0 ? (
          <EmptyPanel
            title="No calls in this period"
            message="Widen the date range, or check that telecallers are logging calls from the mobile app."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Employee</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Duration</th>
                  <th scope="col">How logged</th>
                </tr>
              </thead>
              <tbody>
                {calls.items.map((call) => (
                  <tr key={call.id}>
                    <td>{formatDateTime(call.startedAt)}</td>
                    <td>{call.userName ?? '—'}</td>
                    <td>
                      <strong>{call.leadName ?? 'Unknown number'}</strong>
                      <br />
                      <span className="tc-muted">{call.phone}</span>
                      {call.leadReference ? (
                        <>
                          <br />
                          <span className="tc-muted tc-mono">{call.leadReference}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <Tag tone={call.outcome === 'answered' ? 'good' : 'neutral'}>
                        {CALL_OUTCOME_LABELS[call.outcome]}
                      </Tag>
                      <br />
                      <span className="tc-muted">{humanise(call.direction)}</span>
                      {!call.followedUp && call.outcome !== 'answered' ? (
                        <>
                          <br />
                          <Tag tone="bad">Callback pending</Tag>
                        </>
                      ) : null}
                    </td>
                    <td>{formatDuration(call.durationSeconds)}</td>
                    <td>
                      {/*
                        Surfaced deliberately. A duration read from the Android call log is
                        measured; one typed into the post-call sheet on an iPhone is
                        remembered. A manager comparing two telecallers on different
                        platforms needs to know which is which.
                      */}
                      {call.source === 'call_log' ? (
                        <Tag tone="good">Measured</Tag>
                      ) : call.source === 'provider' ? (
                        <Tag tone="good">Provider</Tag>
                      ) : (
                        <Tag>Self-reported</Tag>
                      )}
                      {call.hasRecording ? (
                        <>
                          <br />
                          <Tag tone="progress">Recorded</Tag>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !recordings || recordings.items.length === 0 ? (
        <EmptyPanel
          title="No recordings"
          message="Call recording is not available through the device dialler — Android 10+ and every version of iOS block it. Recordings appear here once calls are routed through a telephony provider."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Call</th>
                <th scope="col">Employee</th>
                <th scope="col">Customer</th>
                <th scope="col">Length</th>
                <th scope="col">Listen</th>
              </tr>
            </thead>
            <tbody>
              {recordings.items.map((recording) => (
                <tr key={recording.id}>
                  <td>{formatDateTime(recording.callStartedAt ?? recording.createdAt)}</td>
                  <td>{recording.userName ?? '—'}</td>
                  <td>
                    <strong>{recording.leadName ?? '—'}</strong>
                    {recording.leadReference ? (
                      <>
                        <br />
                        <span className="tc-muted tc-mono">{recording.leadReference}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{formatDuration(recording.durationSeconds)}</td>
                  <td>
                    {playingId === recording.id ? (
                      /*
                       * The audio element is mounted only after the manager asks for it.
                       * Rendering twenty-five of them would fire twenty-five authenticated
                       * requests for customer call audio — and write twenty-five
                       * access-audit entries — for a page that was merely scrolled past.
                       */
                      <audio
                        controls
                        autoPlay
                        preload="none"
                        src={telecallingApi.recordingAudioUrl(recording.id)}
                        style={{ maxWidth: '15rem' }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        onClick={() => setPlayingId(recording.id)}
                      >
                        <Icon name="phone" size={15} />
                        Play
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current ? (
        <Pager
          page={current.page}
          totalPages={current.totalPages}
          total={current.total}
          noun={tab === 'calls' ? 'call' : 'recording'}
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
