'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { todayIso } from '@/lib/telecalling';
import { formatCalendarDay, leaveAdminApi, type Holiday } from '@/lib/hrLeave';
import { EmptyPanel, Tag, TableSkeleton } from '../../telecalling/shared';
import { HolidayDialog } from './HolidayDialog';
import { YearSwitcher, isAbort, readFailure, writeFailure } from './shared';

/**
 * The company holiday calendar, one year at a time.
 *
 * A year of holidays is a bounded aggregate (the server returns it whole), so the list is
 * not paged; the year switcher is the paging. Past holidays stay listed, muted — they are
 * the reason last month's attendance and payroll read the way they do.
 */

export function HolidaysTab({ onUnauthorized }: { onUnauthorized: () => void }) {
  const dialogs = useDialogs();
  const today = todayIso();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [items, setItems] = useState<Holiday[] | null>(null);
  const [loadedYear, setLoadedYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Holiday | 'new' | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);

    try {
      const result = await leaveAdminApi.holidays(year, controller.signal);
      setItems(result.items);
      setLoadedYear(result.year);
    } catch (caught) {
      if (isAbort(caught)) return;
      const message = readFailure(caught, onUnauthorized, 'Could not load the holidays.');
      if (message !== null) setError(message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [year, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const handleSaved = useCallback(
    (saved: Holiday, message: string) => {
      setEditing(null);
      setNotice(message);
      const savedYear = Number(saved.date.slice(0, 4));
      // A holiday added for another year: show that year, where it now is.
      if (savedYear !== year) setYear(savedYear);
      else void load();
    },
    [load, year],
  );

  const remove = async (holiday: Holiday) => {
    const confirmed = await dialogs.confirm({
      title: `Remove ${holiday.name} (${formatCalendarDay(holiday.date)}) from the holiday calendar?`,
      message:
        'That date becomes a normal working day for attendance and payroll. Leave requests already raised across it keep their day count.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    setBusyId(holiday.id);
    setError(null);
    setNotice(null);

    try {
      await leaveAdminApi.deleteHoliday(holiday.id);
      setNotice(`${holiday.name} is removed from the ${year} calendar.`);
      await load();
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can change the holiday calendar.',
        'The holiday could not be removed.',
      );
      if (message !== null) setError(message);
    } finally {
      setBusyId(null);
    }
  };

  const showing = items !== null && loadedYear === year;
  const offDays = showing ? items.filter((holiday) => !holiday.isOptional).length : 0;

  return (
    <>
      <div className="admin-toolbar">
        <div className="field">
          <span className="field__label">Year</span>
          <YearSwitcher
            year={year}
            onChange={(next) => {
              setYear(next);
              setNotice(null);
            }}
            label="Holiday year"
          />
        </div>
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
            Add holiday
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {items === null ? (
        loading ? (
          <TableSkeleton rows={6} />
        ) : null
      ) : (
        <LoadingOverlay busy={loading || !showing}>
          {items.length === 0 ? (
            <EmptyPanel
              title={`No holidays in ${loadedYear ?? year}`}
              message="Add the company's holidays so attendance, leave and payroll treat those dates as days off."
              actionLabel="Add holiday"
              onAction={() => setEditing('new')}
            />
          ) : (
            <>
              <p className="hrl-filter-hint">
                {offDays} {offDays === 1 ? 'holiday' : 'holidays'} off in {loadedYear}
                {items.length > offDays ? `, plus ${items.length - offDays} optional` : ''}.
              </p>
              <DataTable
                rows={items}
                rowKey={(row) => row.id}
                rowBusy={(row) => busyId === row.id}
                minWidth="40rem"
                caption={`Holidays in ${loadedYear}`}
                onRowDoubleClick={(row) => setEditing(row)}
                rowTitle={() => 'Double-click to edit'}
                columns={[
                  {
                    key: 'date',
                    header: 'Date',
                    width: '11rem',
                    nowrap: true,
                    render: (row) =>
                      row.date < today ? (
                        <span className="tc-muted">{formatCalendarDay(row.date)}</span>
                      ) : (
                        formatCalendarDay(row.date)
                      ),
                  },
                  {
                    key: 'name',
                    header: 'Holiday',
                    render: (row) => (
                      <CellStack primary={row.name}>
                        {row.isOptional ? <Tag tone="progress">Optional</Tag> : null}
                        {row.date === today ? <Tag tone="good">Today</Tag> : null}
                      </CellStack>
                    ),
                  },
                  {
                    key: 'actions',
                    header: 'Actions',
                    align: 'end',
                    width: '12rem',
                    nowrap: true,
                    render: (row) => (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => {
                            setNotice(null);
                            setEditing(row);
                          }}
                          aria-label={`Edit ${row.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === row.id}
                          onClick={() => void remove(row)}
                          aria-label={`Remove ${row.name}`}
                        >
                          Remove
                        </button>
                      </CellActions>
                    ),
                  },
                ]}
              />
            </>
          )}
        </LoadingOverlay>
      )}

      {editing ? (
        <HolidayDialog
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
