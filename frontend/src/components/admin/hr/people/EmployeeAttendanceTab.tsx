'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '@/components/admin/telecalling/shared';
import { FormAlert } from '@/components/forms/Fields';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateRange, formatTime, todayIso } from '@/lib/telecalling';
import {
  companyClock,
  minutesAsHours,
  pageCount,
  peopleApi,
  type AttendanceDay,
  type HrEmployee,
  type HrPaginated,
} from '@/lib/hr';
import { CorrectDayDialog } from '../attendance/CorrectDayDialog';
import { AttendanceStatusTag, DayMarkers, FlagTags } from '../attendance/dayStatus';
import { isAbort } from './shared';

/**
 * One employee's recorded days, newest first, a page at a time.
 *
 * Only days with an attendance row are listed — a day with no punch is not a row, it is
 * an absence (or a holiday, or leave), and the Calendar tab is where every date of a month
 * is classified. This is the evidence view: sessions, who corrected what, and why.
 */

const PAGE_SIZE = 20;

export function EmployeeAttendanceTab({
  employee,
  canCorrect,
  onUnauthorized,
}: {
  employee: HrEmployee;
  /** Approved accounts only — the server refuses to correct anybody else's attendance. */
  canCorrect: boolean;
  onUnauthorized: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(HrPaginated<AttendanceDay> & { from: string; to: string }) | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceDay | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await peopleApi.employeeAttendance(
        employee.id,
        { from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE },
        controller.signal,
      );
      if (result.items.length === 0 && result.total > 0 && page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(
        caught instanceof ApiError
          ? (caught.fieldErrors.from ?? caught.message)
          : 'Could not load their attendance.',
      );
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [employee.id, from, to, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const today = todayIso();

  return (
    <div className="hrp-tab-body">
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor={`hr-emp-att-from-${employee.id}`}>
              From
            </label>
            <input
              id={`hr-emp-att-from-${employee.id}`}
              className="input"
              type="date"
              value={from}
              max={to || today}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`hr-emp-att-to-${employee.id}`}>
              To
            </label>
            <input
              id={`hr-emp-att-to-${employee.id}`}
              className="input"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </div>
          {from || to ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setFrom('');
                setTo('');
                setPage(1);
              }}
            >
              This month
            </button>
          ) : null}
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton rows={4} />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          <p className="tc-muted hrp-caption">
            {formatDateRange({ from: data.from, to: data.to })} · {data.total} recorded{' '}
            {data.total === 1 ? 'day' : 'days'}
          </p>
          {data.items.length === 0 ? (
            <EmptyPanel
              title="No attendance recorded in this range"
              message="Days with no punch are not listed here. The Calendar tab shows how every day of a month was counted."
            />
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.workDate}
              rowTone={(row) => (row.missingPunch ? 'bad' : row.flagged ? 'warn' : undefined)}
              minWidth="70rem"
              caption={`Attendance recorded for ${employee.name}`}
              columns={[
                {
                  key: 'day',
                  header: 'Day',
                  width: '9rem',
                  nowrap: true,
                  render: (row) => formatDate(row.workDate),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '10rem',
                  render: (row) => (
                    <CellStack primary={<AttendanceStatusTag status={row.status} />}>
                      <DayMarkers missingPunch={row.missingPunch} flagged={row.flagged} source={row.source} />
                    </CellStack>
                  ),
                },
                {
                  key: 'in',
                  header: 'First in',
                  width: '6.5rem',
                  nowrap: true,
                  render: (row) => (row.checkedInAt ? formatTime(row.checkedInAt) : '—'),
                },
                {
                  key: 'out',
                  header: 'Last out',
                  width: '6.5rem',
                  nowrap: true,
                  render: (row) =>
                    row.checkedOutAt ? (
                      formatTime(row.checkedOutAt)
                    ) : row.openSessionStartedAt ? (
                      <Tag tone="progress">in now</Tag>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'worked',
                  header: 'Worked',
                  width: '6rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) => minutesAsHours(row.workedMinutes),
                },
                {
                  key: 'late',
                  header: 'Late',
                  width: '5.5rem',
                  align: 'end',
                  nowrap: true,
                  render: (row) =>
                    row.lateMinutes > 0 ? `${row.lateMinutes} min` : <span className="tc-muted">—</span>,
                },
                {
                  key: 'sessions',
                  header: 'Sessions',
                  render: (row) =>
                    row.sessions.length === 0 ? (
                      <span className="tc-muted">—</span>
                    ) : (
                      <ul className="hrp-session-list">
                        {row.sessions.map((session) => (
                          <li key={session.id}>
                            <span className="tc-mono">
                              {companyClock(session.startedAt)}
                              {session.autoClosed
                                ? ''
                                : `–${session.endedAt ? companyClock(session.endedAt) : 'now'}`}
                            </span>
                            {session.autoClosed ? (
                              <span className="tc-cell-bad"> · no check-out</span>
                            ) : null}
                            <FlagTags flags={session.flags} />
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: 'note',
                  header: 'Note',
                  width: '12rem',
                  render: (row) =>
                    row.note ? <span className="tc-prewrap">{row.note}</span> : <span className="tc-muted">—</span>,
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  align: 'end',
                  width: '6.5rem',
                  render: (row) =>
                    canCorrect && row.workDate <= today ? (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => {
                            setNotice(null);
                            setCorrecting(row);
                          }}
                          aria-label={`Correct ${formatDate(row.workDate)}`}
                        >
                          Correct
                        </button>
                      </CellActions>
                    ) : null,
                },
              ]}
            />
          )}
        </LoadingOverlay>
      )}

      {data && data.total > 0 ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="day"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {correcting ? (
        <CorrectDayDialog
          key={correcting.workDate}
          employee={{ userId: employee.id, name: employee.name, employeeCode: employee.employeeCode }}
          date={correcting.workDate}
          day={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={(_day, message) => {
            setCorrecting(null);
            setNotice(message);
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </div>
  );
}
