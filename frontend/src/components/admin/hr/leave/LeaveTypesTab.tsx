'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { LEAVE_KIND_LABELS, formatDays, leaveAdminApi, type LeaveType } from '@/lib/hrLeave';
import { EmptyPanel, Tag, TableSkeleton } from '../../telecalling/shared';
import { LeaveTypeDialog } from './LeaveTypeDialog';
import { isAbort, readFailure } from './shared';

/**
 * The leave types employees can apply for, inactive ones included so a retired type can
 * be found and switched back on.
 *
 * A configuration list of a handful of rows, returned whole by the server — a bounded
 * aggregate rather than a history, so it is not paged.
 */

export function LeaveTypesTab({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [items, setItems] = useState<LeaveType[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The type being edited, `'new'` for the create form, or null. */
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      setItems(await leaveAdminApi.listTypes(controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load the leave types.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const handleSaved = useCallback(
    (_saved: LeaveType, message: string) => {
      setEditing(null);
      setNotice(message);
      void load();
    },
    [load],
  );

  return (
    <>
      <div className="admin-toolbar">
        <p className="hrl-toolbar-text">
          What employees can apply for in the HR app. Work from home and field work are
          arrangements, not time off, and never carry a balance.
        </p>
        <div className="admin-filters">
          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setNotice(null);
              setEditing('new');
            }}
          >
            <Icon name="add" size={16} />
            Add leave type
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {items === null ? (
        loading ? (
          <TableSkeleton rows={5} />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {items.length === 0 ? (
            <EmptyPanel
              title="No leave types yet"
              message="Add the kinds of leave employees can apply for — casual, sick, earned — and any work-from-home or field arrangement."
              actionLabel="Add leave type"
              onAction={() => setEditing('new')}
            />
          ) : (
            <DataTable
              rows={items}
              rowKey={(row) => row.id}
              rowTone={(row) => (row.isActive ? undefined : 'warn')}
              minWidth="64rem"
              caption="Leave types, with their kind, pay, quota, half-day rule, order and state"
              onRowDoubleClick={(row) => setEditing(row)}
              rowTitle={() => 'Double-click to edit'}
              columns={[
                {
                  key: 'name',
                  header: 'Leave type',
                  render: (row) => (
                    <CellStack primary={row.name}>
                      <span className="tc-mono tc-muted">{row.code}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'kind',
                  header: 'Kind',
                  width: '10rem',
                  nowrap: true,
                  render: (row) =>
                    row.kind === 'leave' ? (
                      LEAVE_KIND_LABELS[row.kind]
                    ) : (
                      <Tag tone="progress">{LEAVE_KIND_LABELS[row.kind]}</Tag>
                    ),
                },
                {
                  key: 'paid',
                  header: 'Pay',
                  width: '6rem',
                  nowrap: true,
                  render: (row) => (row.isPaid ? 'Paid' : <Tag tone="warn">Unpaid</Tag>),
                },
                {
                  key: 'quota',
                  header: 'Annual quota',
                  width: '10rem',
                  nowrap: true,
                  render: (row) =>
                    row.isCompOff ? (
                      <span className="tc-muted">Earned by working days off</span>
                    ) : row.annualQuota !== null ? (
                      formatDays(row.annualQuota)
                    ) : (
                      <span className="tc-muted">Not tracked</span>
                    ),
                },
                {
                  key: 'half',
                  header: 'Half days',
                  width: '7rem',
                  nowrap: true,
                  render: (row) => (row.allowHalfDay ? 'Allowed' : <span className="tc-muted">No</span>),
                },
                {
                  key: 'order',
                  header: 'Order',
                  align: 'end',
                  width: '5rem',
                  nowrap: true,
                  render: (row) => row.sortOrder,
                },
                {
                  key: 'state',
                  header: 'State',
                  width: '7rem',
                  nowrap: true,
                  render: (row) =>
                    row.isActive ? <Tag tone="good">Active</Tag> : <Tag>Inactive</Tag>,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '7rem',
                  nowrap: true,
                  render: (row) => (
                    <CellActions>
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        onClick={() => {
                          setNotice(null);
                          setEditing(row);
                        }}
                        aria-label={`Edit ${row.name}`}
                      >
                        Edit
                      </button>
                    </CellActions>
                  ),
                },
              ]}
            />
          )}
        </LoadingOverlay>
      )}

      {editing ? (
        <LeaveTypeDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={closeEdit}
          onSaved={handleSaved}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
