'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/telecalling';
import { attendanceAdminApi, type Regularisation } from '@/lib/hr';
import { EmptyPanel, Tag, TableSkeleton } from '../telecalling/shared';

/**
 * Attendance corrections waiting on a decision.
 *
 * Approving one WRITES the attendance day, which is why it is confirmed: the corrected
 * hours feed anything built on attendance later, and the request's own record is the
 * only trace of who asked for them and why.
 */

const TABS: { key: 'pending' | 'approved' | 'rejected'; label: string }[] = [
  { key: 'pending', label: 'Waiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const TONE: Record<string, 'good' | 'bad' | 'progress'> = {
  pending: 'progress',
  approved: 'good',
  rejected: 'bad',
};

/** `HH:MM` from an ISO timestamp, for the requested punch times. */
function timeOf(iso: string | null): string {
  if (!iso) return '—';
  const parts = formatDateTime(iso).split(', ');
  return parts[1] ?? '—';
}

export function HrCorrectionsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [items, setItems] = useState<Regularisation[] | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setItems(await attendanceAdminApi.listRegularisations(tab, controller.signal));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load corrections.');
    } finally {
      setLoading(false);
    }
  }, [tab, onUnauthorized]);

  const refreshCount = useCallback(async () => {
    try {
      setPending(await attendanceAdminApi.regularisationCount());
    } catch {
      setPending(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  useEffect(() => () => abort.current?.abort(), []);

  const decide = async (
    item: Regularisation,
    action: () => Promise<Regularisation>,
    success: string,
  ) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
      await load();
      await refreshCount();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.status === 403) {
        setError('Only an administrator can decide corrections.');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not update that request.');
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (item: Regularisation) => {
    const confirmed = window.confirm(
      `Approve ${item.employeeName}'s correction for ${formatDate(item.workDate)}?\n\n` +
        `In: ${timeOf(item.requestedCheckInAt)}   Out: ${timeOf(item.requestedCheckOutAt)}\n\n` +
        'This writes the attendance for that day.',
    );
    if (!confirmed) return;

    await decide(
      item,
      () => attendanceAdminApi.approveRegularisation(item.id, null),
      `${item.employeeName}'s attendance for ${formatDate(item.workDate)} has been corrected.`,
    );
  };

  const reject = async (item: Regularisation) => {
    const note = window.prompt(
      `Reject ${item.employeeName}'s correction for ${formatDate(item.workDate)}?\n\n` +
        'Give a reason — it is shown to them in the app, and it is the only message they get.\n\n' +
        'Leave blank to reject without one.',
    );
    if (note === null) return;

    const trimmed = note.trim();
    if (trimmed.length > 500) {
      setError('Keep the reason under 500 characters.');
      return;
    }

    await decide(
      item,
      () => attendanceAdminApi.rejectRegularisation(item.id, trimmed || null),
      `${item.employeeName}'s correction was rejected.`,
    );
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Correction state">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
              {item.key === 'pending' && pending !== null && pending > 0 ? (
                <span className="tc-tab-count">{pending}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !items ? (
        <TableSkeleton />
      ) : !items || items.length === 0 ? (
        <EmptyPanel
          title={tab === 'pending' ? 'Nothing waiting' : 'Nothing here'}
          message={
            tab === 'pending'
              ? 'When somebody asks for a missing punch to be corrected, it appears here.'
              : 'Decisions you have made appear here.'
          }
        />
      ) : (
        <DataTable
          rows={items}
          rowKey={(row) => row.id}
          rowBusy={(row) => busyId === row.id}
          minWidth="62rem"
          caption="Attendance correction requests"
          columns={[
            {
              key: 'who',
              header: 'Employee',
              render: (row) => (
                <CellStack primary={row.employeeName ?? '—'}>
                  <span className="tc-muted tc-mono">{row.employeeCode}</span>
                </CellStack>
              ),
            },
            {
              key: 'day',
              header: 'Day',
              width: '9rem',
              nowrap: true,
              render: (row) => formatDate(row.workDate),
            },
            {
              key: 'times',
              header: 'Asked for',
              width: '11rem',
              nowrap: true,
              render: (row) => (
                <CellStack
                  primary={`${timeOf(row.requestedCheckInAt)} → ${timeOf(row.requestedCheckOutAt)}`}
                  secondary={`raised ${formatDate(row.createdAt)}`}
                />
              ),
            },
            {
              key: 'reason',
              header: 'Why',
              render: (row) => row.reason,
            },
            {
              key: 'actions',
              header: tab === 'pending' ? 'Actions' : 'Outcome',
              align: 'end',
              width: '15rem',
              nowrap: true,
              render: (row) =>
                row.status === 'pending' ? (
                  <CellActions>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={busyId === row.id}
                      onClick={() => void approve(row)}
                    >
                      <Icon name="check" size={15} />
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busyId === row.id}
                      onClick={() => void reject(row)}
                    >
                      Reject
                    </button>
                  </CellActions>
                ) : (
                  <CellStack
                    primary={<Tag tone={TONE[row.status] ?? 'progress'}>{row.status}</Tag>}
                    secondary={row.reviewNote ?? undefined}
                  />
                ),
            },
          ]}
        />
      )}
    </>
  );
}
