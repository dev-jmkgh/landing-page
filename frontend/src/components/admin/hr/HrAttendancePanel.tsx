'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate, formatTime, todayIso } from '@/lib/telecalling';
import {
  REGISTER_STATUS_FILTERS,
  REGISTER_STATUS_FILTER_LABELS,
  WORK_MODE_LABELS,
  attendanceAdminApi,
  minutesAsHours,
  pageCount,
  type RegisterEntry,
  type RegisterPage,
  type RegisterStatusFilter,
  type WorkLocation,
} from '@/lib/hr';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '../telecalling/shared';
import { CorrectDayDialog } from './attendance/CorrectDayDialog';
import { AttendanceStatusTag, DayMarkers, DayStatusTag } from './attendance/dayStatus';
import { EmployeeAttendanceView } from './attendance/EmployeeAttendanceView';
import { ExceptionsView } from './attendance/ExceptionsView';
import { isAbort } from './people/shared';
import { useOrgLists } from './people/useOrgLists';

/**
 * The day register — who is in, who is late, who has not appeared — and the review queue
 * for days with a missing or flagged punch.
 *
 * The date defaults to the server's idea of today rather than the browser's. The two
 * differ for five and a half hours out of every twenty-four, and an administrator
 * opening this at 06:00 should see this morning's register, not yesterday's.
 *
 * THE REGISTER IS PAGED, so it carries no head counts. Counting the rows of one page would
 * print "3 late" on a day twelve people were late; the status filter gives the true list
 * (and the pager its true total) for any one status instead.
 */

const PAGE_SIZE = 25;

type Tab = 'register' | 'exceptions';

/** The employee whose month is open, and the register date it was opened from. */
type Viewing = { userId: number; name: string; date: string | null };

export function HrAttendancePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<Tab>('register');
  /** Unreviewed exceptions, for the tab badge. Null when unknown — then no badge. */
  const [waiting, setWaiting] = useState<number | null>(null);
  const [viewing, setViewing] = useState<Viewing | null>(null);

  const refreshWaiting = useCallback(async () => {
    try {
      // A one-row page is the count: its `total` is the whole queue.
      const page = await attendanceAdminApi.exceptions({ reviewed: 'false', page: 1, pageSize: 1 });
      setWaiting(page.total);
    } catch {
      setWaiting(null);
    }
  }, []);

  useEffect(() => {
    void refreshWaiting();
  }, [refreshWaiting, tab]);

  /*
   * Back from an employee's month: the register is still there (hidden, not unmounted, so
   * its date, filters and page survive), and focus returns to the name that was clicked.
   */
  const closeEmployee = () => {
    const userId = viewing?.userId;
    setViewing(null);
    window.requestAnimationFrame(() => document.getElementById(`hr-att-name-${userId}`)?.focus());
  };

  return (
    <>
      {viewing ? (
        <EmployeeAttendanceView
          key={viewing.userId}
          userId={viewing.userId}
          initialName={viewing.name}
          initialMonth={viewing.date?.slice(0, 7)}
          initialDate={viewing.date ?? undefined}
          onBack={closeEmployee}
          onUnauthorized={onUnauthorized}
        />
      ) : null}

      <div hidden={viewing !== null}>
        <div className="admin-toolbar hrp-tabbar">
          <div className="admin-tabs" role="tablist" aria-label="Attendance views">
            <button
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === 'register'}
              onClick={() => setTab('register')}
            >
              Register
            </button>
            <button
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === 'exceptions'}
              onClick={() => setTab('exceptions')}
            >
              Exceptions
              {waiting !== null && waiting > 0 ? <span className="tc-tab-count">{waiting}</span> : null}
            </button>
          </div>
        </div>

        {tab === 'register' ? (
          <RegisterView onUnauthorized={onUnauthorized} onOpenEmployee={setViewing} />
        ) : (
          <ExceptionsView onUnauthorized={onUnauthorized} />
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Register                                                                    */
/* -------------------------------------------------------------------------- */

function RegisterView({
  onUnauthorized,
  onOpenEmployee,
}: {
  onUnauthorized: () => void;
  /** Opens the employee's month — the calendar, table and punch views. */
  onOpenEmployee: (viewing: Viewing) => void;
}) {
  /** Empty means "whatever the server calls today". */
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState<RegisterStatusFilter | ''>('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<RegisterPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locations, setLocations] = useState<WorkLocation[] | null>(null);
  const [correcting, setCorrecting] = useState<RegisterEntry | null>(null);

  const org = useOrgLists(onUnauthorized);
  const abort = useRef<AbortController | null>(null);

  // The search box, debounced; the page resets only when the settled text changes.
  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;
    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  // Sites for the filter — a bounded list. A failure only empties that one select.
  useEffect(() => {
    const controller = new AbortController();
    attendanceAdminApi
      .listLocations(controller.signal)
      .then(setLocations)
      .catch(() => setLocations(null));
    return () => controller.abort();
  }, []);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await attendanceAdminApi.register(
        {
          date: date || undefined,
          q: debounced || undefined,
          departmentId: departmentId ? Number(departmentId) : undefined,
          locationId: locationId ? Number(locationId) : undefined,
          status: status || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        controller.signal,
      );
      if (result.items.length === 0 && result.total > 0 && page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load the register.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [date, debounced, departmentId, locationId, status, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const filtered = debounced !== '' || departmentId !== '' || locationId !== '' || status !== '';

  const clearFilters = () => {
    setSearch('');
    setDebounced('');
    setDepartmentId('');
    setLocationId('');
    setStatus('');
    setPage(1);
  };

  /** The date the rows describe — the server's answer, which is "today" when none was picked. */
  const shownDate = data?.date ?? (date || null);
  const canCorrect = shownDate !== null && shownDate <= todayIso();

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters hrp-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-att-date">
              Date
            </label>
            <input
              id="hr-att-date"
              className="input"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-att-search">
              Search
            </label>
            <input
              id="hr-att-search"
              className="input"
              type="search"
              value={search}
              placeholder="Name, email or code"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-att-status">
              Status
            </label>
            <select
              id="hr-att-status"
              className="select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as RegisterStatusFilter | '');
                setPage(1);
              }}
            >
              <option value="">Everyone</option>
              {REGISTER_STATUS_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {REGISTER_STATUS_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-att-department">
              Department
            </label>
            <select
              id="hr-att-department"
              className="select"
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All departments</option>
              {(org.departments ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-att-site">
              Assigned site
            </label>
            <select
              id="hr-att-site"
              className="select"
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All sites</option>
              {(locations ?? []).map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                  {site.isActive ? '' : ' (switched off)'}
                </option>
              ))}
            </select>
          </div>

          <div className="hrp-filters__actions">
            {date ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setDate('');
                  setPage(1);
                }}
              >
                Today
              </button>
            ) : null}
            <button type="button" className="btn btn--outline" onClick={() => void load()}>
              <Icon name="refresh" size={16} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          <p className="tc-muted hrp-caption">
            {formatDate(data.date)}
            {data.date === todayIso() ? ' (today)' : ''} · {data.total}{' '}
            {data.total === 1 ? 'employee' : 'employees'}
            {status ? ` · ${REGISTER_STATUS_FILTER_LABELS[status].toLowerCase()}` : ''}
          </p>

          {data.items.length === 0 ? (
            filtered ? (
              <EmptyPanel
                title="Nobody matches these filters"
                message="Try another status, department or site, or clear the filters to see everyone."
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            ) : (
              <EmptyPanel
                title="No employees"
                message="Approved, active HR employees appear here once they exist."
              />
            )
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.userId}
              rowTone={(row) =>
                row.missingPunch ? 'bad' : row.dayStatus === 'absent' ? 'warn' : undefined
              }
              minWidth="78rem"
              caption="Attendance register for the selected day"
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  render: (row) => (
                    <CellStack
                      primary={
                        <button
                          type="button"
                          id={`hr-att-name-${row.userId}`}
                          className="tc-link-button hra-name"
                          onClick={() => onOpenEmployee({ userId: row.userId, name: row.name, date: shownDate })}
                        >
                          {row.name}
                          <span className="sr-only">: open their attendance month</span>
                        </button>
                      }
                      secondary={
                        [row.designationName, row.departmentName].filter(Boolean).join(' · ') ||
                        undefined
                      }
                    >
                      <span className="tc-muted tc-mono">{row.employeeCode}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'mode',
                  header: 'Mode',
                  width: '6rem',
                  nowrap: true,
                  render: (row) => WORK_MODE_LABELS[row.workMode] ?? row.workMode,
                },
                {
                  key: 'in',
                  header: 'First in',
                  width: '7rem',
                  nowrap: true,
                  render: (row) =>
                    row.checkedInAt ? formatTime(row.checkedInAt) : <span className="tc-muted">—</span>,
                },
                {
                  key: 'out',
                  header: 'Last out',
                  width: '7rem',
                  nowrap: true,
                  /*
                    Null while a session is open, which is the normal state mid-shift —
                    so it reads "in now" rather than as a missing punch.
                  */
                  render: (row) =>
                    row.checkedOutAt ? (
                      formatTime(row.checkedOutAt)
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
                    row.completedSessions > 0 ? row.completedSessions : <span className="tc-muted">—</span>,
                },
                {
                  key: 'worked',
                  header: 'Worked',
                  width: '6.5rem',
                  align: 'end',
                  nowrap: true,
                  /*
                    Null means nothing has closed yet, which is not zero hours. The dash
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
                  width: '11rem',
                  render: (row) =>
                    row.locationName ? (
                      <CellStack
                        primary={row.locationName}
                        /*
                          The measured distance is the evidence behind the geofence
                          decision. A run of punches at 140m from a 150m fence is how an
                          administrator finds the site's pin is in the car park.
                        */
                        secondary={row.distanceMetres === null ? undefined : `${row.distanceMetres} m away`}
                      />
                    ) : (
                      <span className="tc-muted">—</span>
                    ),
                },
                {
                  key: 'day',
                  header: 'Day',
                  width: '11rem',
                  render: (row) => (
                    <CellStack
                      primary={
                        row.dayStatus ? (
                          <DayStatusTag status={row.dayStatus} />
                        ) : (
                          <AttendanceStatusTag status={row.status} />
                        )
                      }
                      secondary={row.leaveTypeName ?? undefined}
                    >
                      <DayMarkers
                        missingPunch={row.missingPunch}
                        flagged={row.flagged}
                        source={row.source}
                      />
                    </CellStack>
                  ),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  align: 'end',
                  width: '8.5rem',
                  render: (row) =>
                    canCorrect ? (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => {
                            setNotice(null);
                            setCorrecting(row);
                          }}
                          aria-label={`Correct ${row.name}’s day`}
                        >
                          Correct day
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
          noun="employee"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {correcting && shownDate ? (
        <CorrectDayDialog
          key={`${correcting.userId}-${shownDate}`}
          employee={{
            userId: correcting.userId,
            name: correcting.name,
            employeeCode: correcting.employeeCode,
          }}
          date={shownDate}
          onClose={() => setCorrecting(null)}
          onSaved={(_day, message) => {
            setCorrecting(null);
            setNotice(message);
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
