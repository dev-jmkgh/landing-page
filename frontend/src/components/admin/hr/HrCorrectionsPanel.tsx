'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert, TextAreaField } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/telecalling';
import {
  attendanceAdminApi,
  companyClock,
  pageCount,
  type HrPaginated,
  type Regularisation,
} from '@/lib/hr';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '../telecalling/shared';
import { isAbort } from './people/shared';

/**
 * Attendance corrections employees have asked for, one page at a time.
 *
 * Approving one WRITES the attendance day, which is why it is confirmed: the corrected
 * hours feed everything built on attendance later — reports, payroll — and the request's
 * own record is the only trace of who asked for them and why.
 *
 * A request may be decided here or by the employee's manager in the HR app; the outcome
 * column names whoever it was, so two people working the same queue can see who acted.
 */

const PAGE_SIZE = 25;

type StatusTab = 'pending' | 'approved' | 'rejected' | 'all';

const TABS: { key: StatusTab; label: string }[] = [
  { key: 'pending', label: 'Waiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

const TONE: Record<Regularisation['status'], 'good' | 'bad' | 'progress'> = {
  pending: 'progress',
  approved: 'good',
  rejected: 'bad',
};

const STATUS_LABEL: Record<Regularisation['status'], string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** `HH:MM` (IST) from a requested punch time, or a dash when that half was not asked for. */
function timeOf(iso: string | null): string {
  return companyClock(iso) || '—';
}

export function HrCorrectionsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<StatusTab>('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HrPaginated<Regularisation> | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /*
   * The request being decided, in a dialog on the page. Not the browser's confirm() and
   * prompt(): a browser told to stop showing a page's dialogs (or an embedded view) makes
   * them return "cancel" silently, and Approve and Reject then appeared to do nothing.
   */
  const [deciding, setDeciding] = useState<{ item: Regularisation; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await attendanceAdminApi.listRegularisations(
        { status: tab, page, pageSize: PAGE_SIZE },
        controller.signal,
      );
      // A page past the end — its last request was just decided — steps back one.
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
      setError(caught instanceof ApiError ? caught.message : 'Could not load corrections.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [tab, page, onUnauthorized]);

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

  const approve = (item: Regularisation) => {
    setNotice(null);
    setDialogError(null);
    setDeciding({ item, action: 'approve' });
  };

  const reject = (item: Regularisation) => {
    setNotice(null);
    setDialogError(null);
    setNote('');
    setDeciding({ item, action: 'reject' });
  };

  /** Runs the decision in the open dialog; it stays open, with the reason, if it fails. */
  const confirmDecision = async () => {
    if (!deciding) return;
    const { item, action } = deciding;
    const trimmed = note.trim();
    if (action === 'reject' && trimmed.length > 500) {
      setDialogError('Keep the reason under 500 characters.');
      return;
    }

    setBusyId(item.id);
    setDialogError(null);
    setError(null);
    try {
      if (action === 'approve') await attendanceAdminApi.approveRegularisation(item.id, null);
      else await attendanceAdminApi.rejectRegularisation(item.id, trimmed || null);
      setDeciding(null);
      setNotice(
        action === 'approve'
          ? `${item.employeeName}'s attendance for ${formatDate(item.workDate)} has been corrected.`
          : `${item.employeeName}'s correction was rejected.`,
      );
      await load();
      await refreshCount();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.status === 403) {
        setDialogError('Only an administrator can decide corrections.');
        return;
      }
      setDialogError(caught instanceof ApiError ? caught.message : 'Could not update that request.');
      // "Already decided" means somebody else got there first — show what they did.
      await load();
      await refreshCount();
    } finally {
      setBusyId(null);
    }
  };

  const items = data?.items ?? [];

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Correction status">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === item.key}
              onClick={() => {
                if (item.key === tab) return;
                setTab(item.key);
                setPage(1);
              }}
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

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {items.length === 0 ? (
            <EmptyPanel
              title={tab === 'pending' ? 'Nothing waiting' : 'Nothing here'}
              message={
                tab === 'pending'
                  ? 'When somebody asks for a missing punch to be corrected, it appears here.'
                  : 'Decisions made here or by managers in the HR app appear here.'
              }
            />
          ) : (
            <DataTable
              rows={items}
              rowKey={(row) => row.id}
              rowBusy={(row) => busyId === row.id}
              minWidth="64rem"
              caption="Attendance correction requests"
              columns={[
                {
                  key: 'who',
                  header: 'Employee',
                  width: '14rem',
                  render: (row) => (
                    <CellStack primary={row.employeeName ?? '—'}>
                      <span className="tc-muted tc-mono">{row.employeeCode}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'day',
                  header: 'Day',
                  width: '8.5rem',
                  nowrap: true,
                  render: (row) => formatDate(row.workDate),
                },
                {
                  key: 'times',
                  header: 'Asked for',
                  width: '10rem',
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
                  render: (row) => <span className="tc-prewrap">{row.reason}</span>,
                },
                {
                  key: 'actions',
                  header: lastColumnHeader(tab),
                  align: 'end',
                  width: '15rem',
                  render: (row) =>
                    row.status === 'pending' ? (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => approve(row)}
                        >
                          <Icon name="check" size={15} />
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => reject(row)}
                        >
                          Reject
                        </button>
                      </CellActions>
                    ) : (
                      <CellStack
                        primary={<Tag tone={TONE[row.status]}>{STATUS_LABEL[row.status]}</Tag>}
                        secondary={
                          [
                            row.reviewerName ? `by ${row.reviewerName}` : null,
                            row.reviewedAt ? formatDateTime(row.reviewedAt) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || undefined
                        }
                      >
                        {row.reviewNote ? <span className="tc-muted">“{row.reviewNote}”</span> : null}
                      </CellStack>
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
          noun="request"
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {deciding ? (
        <ConfirmDialog
          title={
            deciding.action === 'approve'
              ? `Approve ${deciding.item.employeeName}'s correction?`
              : `Reject ${deciding.item.employeeName}'s correction?`
          }
          confirmLabel={deciding.action === 'approve' ? 'Approve' : 'Reject'}
          busyLabel={deciding.action === 'approve' ? 'Approving…' : 'Rejecting…'}
          danger={deciding.action === 'reject'}
          busy={busyId === deciding.item.id}
          error={dialogError}
          onConfirm={() => void confirmDecision()}
          // A typed reason is not thrown away by a stray click beside the panel.
          dismissOnBackdrop={deciding.action === 'approve'}
          onCancel={() => setDeciding(null)}
        >
          <p className="dialog__text">
            {formatDate(deciding.item.workDate)} · In {timeOf(deciding.item.requestedCheckInAt)} · Out{' '}
            {timeOf(deciding.item.requestedCheckOutAt)}
          </p>
          {deciding.item.reason ? <p className="dialog__text tc-muted">“{deciding.item.reason}”</p> : null}
          {deciding.action === 'approve' ? (
            <p className="dialog__text">This writes the attendance for that day.</p>
          ) : (
            <div className="tc-confirm-dialog__field">
              <TextAreaField
                label="Reason (optional)"
                name="reviewNote"
                rows={3}
                maxLength={500}
                value={note}
                hint="Shown to them in the app. It is the only message they get."
                onChange={setNote}
              />
            </div>
          )}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** The last column decides on Waiting and reports on the other tabs. */
function lastColumnHeader(tab: StatusTab): string {
  if (tab === 'pending') return 'Actions';
  if (tab === 'all') return 'Outcome or action';
  return 'Outcome';
}
