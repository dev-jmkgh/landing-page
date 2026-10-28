'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '@/components/admin/telecalling/shared';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateTime, formatTime } from '@/lib/telecalling';
import {
  attendanceAdminApi,
  minutesAsHours,
  pageCount,
  type AttendanceException,
  type ExceptionQuery,
  type ExceptionSession,
  type HrPaginated,
  type PunchFlag,
} from '@/lib/hr';
import { isAbort } from '../people/shared';
import { readUrlDate, readUrlEnum, useUrlParams } from '../reports/shared';
import { CorrectDayDialog } from './CorrectDayDialog';
import { AttendanceStatusTag, FlagTags } from './dayStatus';
import { ReviewExceptionDialog } from './ReviewExceptionDialog';

/**
 * The attendance review queue: days with a forgotten check-out the system closed, and
 * days with a punch flagged as suspicious (mock location, a phone clock well off the
 * server's, a location fix too imprecise to trust).
 *
 * Every punch's evidence is on the row — flags, distance from the site, GPS accuracy, and
 * what the phone's own clock said — because a review is a judgement on that evidence and
 * opening each day one by one to see it is what makes a queue go unreviewed.
 *
 * Nothing here refuses or deletes a punch. Flags are recorded, never used to reject: a
 * false positive must not strand an honest employee. The two outcomes are "reviewed" (the
 * hours stand) and "correct day" (the hours change).
 */

const PAGE_SIZE = 20;

const TYPE_FILTERS = ['all', 'missing_punch', 'flagged'] as const;
type TypeFilter = (typeof TYPE_FILTERS)[number];
const REVIEWED_FILTERS = ['false', 'true', 'all'] as const;
type ReviewedFilter = (typeof REVIEWED_FILTERS)[number];

/** "phone 09:10 · 16 min behind", from the device time against the server's stamp. */
function deviceClock(serverAt: string | null, deviceAt: string | null): string | null {
  if (!deviceAt) return null;
  const phone = formatTime(deviceAt);
  if (!serverAt) return `phone said ${phone}`;
  const minutes = Math.round((new Date(deviceAt).getTime() - new Date(serverAt).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return `phone said ${phone}`;
  if (minutes === 0) return `phone said ${phone} · matched`;
  const size = Math.abs(minutes);
  const amount = size >= 120 ? `${Math.round(size / 60)} h` : `${size} min`;
  return `phone said ${phone} · ${amount} ${minutes > 0 ? 'ahead' : 'behind'}`;
}

function mapLink(latitude: number | null, longitude: number | null): ReactNode {
  if (latitude === null || longitude === null) return null;
  const text = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return (
    <a
      className="tc-link"
      href={`https://www.google.com/maps?q=${latitude},${longitude}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {text}
      <span className="sr-only"> (opens a map in a new tab)</span>
    </a>
  );
}

/** One punch (check-in or check-out) of a session, as a line of evidence. */
function Punch({
  label,
  at,
  flags,
  distance,
  accuracy,
  deviceAt,
  latitude,
  longitude,
  missing,
}: {
  label: string;
  at: string | null;
  flags: PunchFlag[];
  distance: number | null;
  accuracy: number | null;
  deviceAt: string | null;
  latitude: number | null;
  longitude: number | null;
  missing?: string;
}) {
  const facts = [
    distance !== null ? `${distance} m from the site` : null,
    accuracy !== null ? `accurate to ${accuracy} m` : null,
    deviceClock(at, deviceAt),
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <div className="hrp-evidence__punch">
      <span className="hrp-evidence__label">{label}</span>
      <span className="hrp-evidence__body">
        <span>
          {missing ? <span className="tc-cell-bad">{missing}</span> : formatTime(at)}
          {flags.length > 0 ? <> <FlagTags flags={flags} /></> : null}
        </span>
        {facts.length > 0 ? <span className="tc-muted">{facts.join(' · ')}</span> : null}
        {latitude !== null ? <span className="tc-muted">{mapLink(latitude, longitude)}</span> : null}
      </span>
    </div>
  );
}

function SessionEvidence({ session, index }: { session: ExceptionSession; index: number }) {
  return (
    <li className="hrp-evidence__session">
      <span className="hrp-evidence__title">
        Session {index + 1}
        {session.minutes !== null ? ` · ${minutesAsHours(session.minutes)}` : ''}
        {session.autoClosed ? (
          <>
            {' '}
            <Tag tone="bad">Closed by the system</Tag>
          </>
        ) : null}
      </span>
      <Punch
        label="In"
        at={session.startedAt}
        flags={session.inFlags}
        distance={session.inDistanceMetres}
        accuracy={session.inAccuracyMetres}
        deviceAt={session.inDeviceAt}
        latitude={session.inLatitude}
        longitude={session.inLongitude}
      />
      <Punch
        label="Out"
        at={session.endedAt}
        flags={session.outFlags}
        distance={session.outDistanceMetres}
        accuracy={session.outAccuracyMetres}
        deviceAt={session.outDeviceAt}
        latitude={session.outLatitude}
        longitude={session.outLongitude}
        missing={
          session.autoClosed
            ? 'No check-out recorded'
            : session.endedAt === null
              ? 'Still checked in'
              : undefined
        }
      />
    </li>
  );
}

export function ExceptionsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  // In the address, so the dashboard's punch figures open this queue already filtered.
  const [type, setType] = useState<TypeFilter>(() => readUrlEnum('exc-type', TYPE_FILTERS, 'all'));
  const [reviewed, setReviewed] = useState<ReviewedFilter>(() => readUrlEnum('exc-reviewed', REVIEWED_FILTERS, 'false'));
  const [from, setFrom] = useState(() => readUrlDate('exc-from'));
  const [to, setTo] = useState(() => readUrlDate('exc-to'));
  const [page, setPage] = useState(1);
  useUrlParams({
    'exc-type': type === 'all' ? null : type,
    'exc-reviewed': reviewed === 'false' ? null : reviewed,
    'exc-from': from || null,
    'exc-to': to || null,
  });

  const [data, setData] = useState<HrPaginated<AttendanceException> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reviewing, setReviewing] = useState<AttendanceException | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceException | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    const query: ExceptionQuery = {
      type: type === 'all' ? undefined : type,
      reviewed: reviewed === 'all' ? undefined : reviewed,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: PAGE_SIZE,
    };

    try {
      const result = await attendanceAdminApi.exceptions(query, controller.signal);
      // A page past the end — the last row on it was just reviewed away — steps back.
      if (result.items.length === 0 && result.total > 0 && page > 1) {
        setPage(pageCount(result));
        return;
      }
      setData(result);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not load the exceptions.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [type, reviewed, from, to, page, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const filtered = type !== 'all' || reviewed !== 'false' || from !== '' || to !== '';

  const clearFilters = () => {
    setType('all');
    setReviewed('false');
    setFrom('');
    setTo('');
    setPage(1);
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-exc-type">
              Kind
            </label>
            <select
              id="hr-exc-type"
              className="select"
              value={type}
              onChange={(event) => {
                setType(event.target.value as TypeFilter);
                setPage(1);
              }}
            >
              <option value="all">Both kinds</option>
              <option value="missing_punch">Missing punch</option>
              <option value="flagged">Flagged punch</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-exc-reviewed">
              Review
            </label>
            <select
              id="hr-exc-reviewed"
              className="select"
              value={reviewed}
              onChange={(event) => {
                setReviewed(event.target.value as ReviewedFilter);
                setPage(1);
              }}
            >
              <option value="false">Waiting for review</option>
              <option value="true">Reviewed</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-exc-from">
              From
            </label>
            <input
              id="hr-exc-from"
              className="input"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="hr-exc-to">
              To
            </label>
            <input
              id="hr-exc-to"
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

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
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
          {data.items.length === 0 ? (
            filtered ? (
              <EmptyPanel
                title="Nothing matches these filters"
                message="Try another kind or date range, or clear the filters to see what is waiting for review."
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            ) : (
              <EmptyPanel
                title="Nothing waiting for review"
                message="Days with a forgotten check-out or a flagged punch appear here until somebody reviews them."
              />
            )
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.attendanceId}
              rowTone={(row) => (row.reviewed ? undefined : row.missingPunch ? 'bad' : 'warn')}
              minWidth="72rem"
              caption="Attendance days with a missing or flagged punch, with the evidence for each punch"
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  width: '13rem',
                  render: (row) => (
                    <CellStack primary={row.employeeName}>
                      <span className="tc-muted tc-mono">{row.employeeCode}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'day',
                  header: 'Day',
                  width: '10rem',
                  render: (row) => (
                    <CellStack
                      primary={formatDate(row.workDate)}
                      secondary={
                        row.workedMinutes !== null ? `${minutesAsHours(row.workedMinutes)} worked` : undefined
                      }
                    >
                      <AttendanceStatusTag status={row.status} />
                    </CellStack>
                  ),
                },
                {
                  key: 'kind',
                  header: 'Why it is here',
                  width: '10rem',
                  render: (row) => (
                    <span className="hrp-markers hrp-markers--stack">
                      {row.missingPunch ? <Tag tone="bad">Missing punch</Tag> : null}
                      {row.flagged ? <Tag tone="warn">Flagged punch</Tag> : null}
                    </span>
                  ),
                },
                {
                  key: 'evidence',
                  header: 'Evidence',
                  render: (row) =>
                    row.sessions.length === 0 ? (
                      <span className="tc-muted">No sessions recorded</span>
                    ) : (
                      <ol className="hrp-evidence">
                        {row.sessions.map((session, index) => (
                          <SessionEvidence key={session.id} session={session} index={index} />
                        ))}
                      </ol>
                    ),
                },
                {
                  key: 'review',
                  header: 'Review',
                  align: 'end',
                  width: '12rem',
                  render: (row) =>
                    row.reviewed ? (
                      <CellStack
                        primary={<Tag tone="good">Reviewed</Tag>}
                        secondary={
                          row.review?.reviewedAt
                            ? [row.review.reviewerName, formatDateTime(row.review.reviewedAt)]
                                .filter(Boolean)
                                .join(' · ')
                            : undefined
                        }
                      >
                        {row.review?.note ? <span className="tc-muted">{row.review.note}</span> : null}
                      </CellStack>
                    ) : (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => {
                            setNotice(null);
                            setReviewing(row);
                          }}
                        >
                          <Icon name="check" size={15} />
                          Review
                        </button>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => {
                            setNotice(null);
                            setCorrecting(row);
                          }}
                        >
                          Correct day
                        </button>
                      </CellActions>
                    ),
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

      {reviewing ? (
        <ReviewExceptionDialog
          key={reviewing.attendanceId}
          exception={reviewing}
          onClose={() => setReviewing(null)}
          onReviewed={(_updated, message) => {
            setReviewing(null);
            setNotice(message);
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}

      {correcting ? (
        <CorrectDayDialog
          key={correcting.attendanceId}
          employee={{
            userId: correcting.userId,
            name: correcting.employeeName,
            employeeCode: correcting.employeeCode,
          }}
          date={correcting.workDate}
          onClose={() => setCorrecting(null)}
          onSaved={(_day, message) => {
            setCorrecting(null);
            // The corrected sessions replace the flagged or system-closed ones, so the
            // server clears both markers and the day leaves this queue on reload.
            setNotice(`${message} Its sessions were replaced, so it leaves this list.`);
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
