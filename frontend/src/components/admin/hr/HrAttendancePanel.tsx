'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/telecalling';
import {
  WORK_MODE_LABELS,
  attendanceAdminApi,
  minutesAsHours,
  type RegisterEntry,
} from '@/lib/hr';
import { EmptyPanel, Tag, TableSkeleton } from '../telecalling/shared';

/**
 * The day register: who is in, who is late, and who has not appeared.
 *
 * The date defaults to the server's idea of today rather than the browser's. The two
 * differ for five and a half hours out of every twenty-four, and an administrator
 * opening this at 06:00 should see this morning's register, not yesterday's.
 */

const STATUS_TONE: Record<string, 'good' | 'bad' | 'progress' | 'neutral'> = {
  present: 'good',
  late: 'progress',
  half_day: 'progress',
  absent: 'bad',
  on_leave: 'neutral',
};

export function HrAttendancePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  /** Empty means "whatever the server calls today". */
  const [date, setDate] = useState('');

  const [data, setData] = useState<RegisterEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await attendanceAdminApi.register(
        { date: date || undefined },
        controller.signal,
      );
      setData(result.items);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load the register.');
    } finally {
      setLoading(false);
    }
  }, [date, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const present = data?.filter((row) => row.status !== 'absent').length ?? 0;
  const absent = data?.filter((row) => row.status === 'absent').length ?? 0;
  const late = data?.filter((row) => row.status === 'late').length ?? 0;
  /* Distinct from `present`: who is mid-session right now, rather than who came in
     at some point today. On a day with lunch breaks the two differ constantly. */
  const inNow = data?.filter((row) => row.currentlyIn).length ?? 0;

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-att-date">
              Date
            </label>
            <input
              id="hr-att-date"
              className="input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          {date ? (
            <button type="button" className="btn btn--ghost" onClick={() => setDate('')}>
              Today
            </button>
          ) : null}

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data || data.length === 0 ? (
        <EmptyPanel
          title="No employees"
          message="Approved HR employees appear here once they exist."
        />
      ) : (
        <>
          <p className="tc-muted" style={{ margin: '0 0 0.75rem' }}>
            {present} in today · {inNow} in right now · {late} late · {absent} not in
          </p>

          <DataTable
            rows={data}
            rowKey={(row) => row.userId}
            rowTone={(row) => (row.status === 'absent' ? 'warn' : undefined)}
            minWidth="66rem"
            caption="Attendance register for the selected day"
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                render: (row) => (
                  <CellStack primary={row.name}>
                    <span className="tc-muted tc-mono">{row.employeeCode}</span>
                  </CellStack>
                ),
              },
              {
                key: 'mode',
                header: 'Mode',
                width: '7rem',
                nowrap: true,
                render: (row) => WORK_MODE_LABELS[row.workMode] ?? row.workMode,
              },
              {
                key: 'in',
                header: 'First in',
                width: '9rem',
                nowrap: true,
                render: (row) =>
                  row.checkedInAt ? (
                    formatDateTime(row.checkedInAt).split(', ')[1]
                  ) : (
                    <span className="tc-muted">—</span>
                  ),
              },
              {
                key: 'out',
                header: 'Last out',
                width: '9rem',
                nowrap: true,
                /*
                  Null while a session is open, which is the normal state mid-shift —
                  so it reads "in now" rather than as a missing punch.
                */
                render: (row) =>
                  row.checkedOutAt ? (
                    formatDateTime(row.checkedOutAt).split(', ')[1]
                  ) : row.currentlyIn ? (
                    <Tag tone="progress">in now</Tag>
                  ) : (
                    <span className="tc-muted">—</span>
                  ),
              },
              {
                key: 'sessions',
                header: 'Sessions',
                width: '6rem',
                align: 'end',
                nowrap: true,
                render: (row) =>
                  row.completedSessions > 0 ? (
                    row.completedSessions
                  ) : (
                    <span className="tc-muted">—</span>
                  ),
              },
              {
                key: 'worked',
                header: 'Worked',
                width: '7rem',
                align: 'end',
                nowrap: true,
                /*
                  Null means the day is still open, which is not zero hours. The dash
                  says "not known yet"; a 0h would be a claim about somebody mid-shift.
                */
                render: (row) =>
                  row.workedMinutes === null ? (
                    <span className="tc-muted">—</span>
                  ) : (
                    minutesAsHours(row.workedMinutes)
                  ),
              },
              {
                key: 'where',
                header: 'Checked in at',
                width: '13rem',
                render: (row) =>
                  row.locationName ? (
                    <CellStack
                      primary={row.locationName}
                      /*
                        The measured distance is shown because it is the evidence
                        behind the geofence decision. A run of punches at 140m from a
                        150m fence is how an administrator discovers the site's pin is
                        in the car park rather than the building.
                      */
                      secondary={
                        row.distanceMetres === null ? undefined : `${row.distanceMetres}m away`
                      }
                    />
                  ) : (
                    <span className="tc-muted">—</span>
                  ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '9rem',
                nowrap: true,
                render: (row) => (
                  <CellActions>
                    <Tag tone={STATUS_TONE[row.status] ?? 'neutral'}>
                      {row.status === 'half_day' ? 'Half day' : row.status.replace('_', ' ')}
                    </Tag>
                    {row.source === 'regularisation' ? (
                      <span className="tc-muted" title="Corrected by an approved request">
                        corrected
                      </span>
                    ) : null}
                  </CellActions>
                ),
              },
            ]}
          />
        </>
      )}
    </>
  );
}
