'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { peopleApi, type Department, type Designation } from '@/lib/hr';
import { EmptyPanel, Tag, TableSkeleton } from '../telecalling/shared';
import { HrSettingsCard } from './people/HrSettingsCard';
import { OrgEntryDialog } from './people/OrgEntryDialog';
import { isAbort } from './people/shared';

/**
 * How the company is organised for HR: departments, designations, and the company-wide
 * HR settings.
 *
 * Departments and designations are bounded lists — tens, not thousands — and the server
 * returns them whole by design, so there is no pager here. Each shows how many ACTIVE,
 * APPROVED employees it holds, the same headcount the HR dashboard reports.
 *
 * Nothing is ever deleted. An entry is switched off instead: the people already in it
 * stay (nobody is silently moved), but nobody new can be put into it. That keeps every
 * past record, report and payslip pointing at a name that still exists.
 */

type Editing =
  | { kind: 'department'; entry: Department | null }
  | { kind: 'designation'; entry: Designation | null };

export function HrOrganisationPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const dialogs = useDialogs();
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [designations, setDesignations] = useState<Designation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [d, g] = await Promise.all([
          peopleApi.listDepartments(signal),
          peopleApi.listDesignations(signal),
        ]);
        setDepartments(d);
        setDesignations(g);
      } catch (caught) {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load departments and designations.',
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const toggle = async (kind: 'department' | 'designation', entry: Department | Designation) => {
    const noun = kind === 'department' ? 'department' : 'designation';

    if (entry.isActive) {
      const people =
        entry.employeeCount === 0
          ? 'Nobody is in it.'
          : entry.employeeCount === 1
            ? 'The 1 active employee in it stays in it.'
            : `The ${entry.employeeCount} active employees in it stay in it.`;
      const confirmed = await dialogs.confirm({
        title: `Switch off ${entry.name}?`,
        message: `${people} Nobody new can be put into this ${noun} until it is switched back on.`,
        confirmLabel: 'Switch off',
        danger: true,
      });
      if (!confirmed) return;
    }

    setBusyKey(`${kind}-${entry.id}`);
    setError(null);
    setNotice(null);

    try {
      if (kind === 'department') {
        await peopleApi.updateDepartment(entry.id, { isActive: !entry.isActive });
      } else {
        await peopleApi.updateDesignation(entry.id, { isActive: !entry.isActive });
      }
      setNotice(
        entry.isActive
          ? `${entry.name} is switched off. Nobody new can be put into it.`
          : `${entry.name} is switched on again.`,
      );
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(
        caught instanceof ApiError && caught.status === 403
          ? `Only an administrator can change ${noun}s.`
          : caught instanceof ApiError
            ? caught.message
            : `Could not update that ${noun}.`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const stateTag = (entry: { isActive: boolean }) =>
    entry.isActive ? <Tag tone="good">In use</Tag> : <Tag tone="bad">Switched off</Tag>;

  const headcount = (count: number) => (count === 0 ? <span className="tc-muted">0</span> : count);

  return (
    <>
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      <div className="hrp-org-grid">
        {/* ------------------------------------------------------ departments */}
        <section aria-labelledby="hr-org-departments">
          <div className="admin-toolbar hrp-section-head">
            <h3 className="tc-section-title" id="hr-org-departments" style={{ margin: 0 }}>
              Departments
            </h3>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setNotice(null);
                setEditing({ kind: 'department', entry: null });
              }}
            >
              <Icon name="add" size={15} />
              Add a department
            </button>
          </div>

          {departments === null ? (
            loading ? (
              <TableSkeleton rows={3} />
            ) : null
          ) : departments.length === 0 ? (
            <EmptyPanel
              title="No departments yet"
              message="Add the departments people work in, so the directory, reports and payroll can be filtered by them."
              actionLabel="Add a department"
              onAction={() => setEditing({ kind: 'department', entry: null })}
            />
          ) : (
            <LoadingOverlay busy={loading}>
              <DataTable
                rows={departments}
                rowKey={(row) => row.id}
                rowBusy={(row) => busyKey === `department-${row.id}`}
                minWidth="34rem"
                caption="Departments, with the number of active employees in each"
                columns={[
                  {
                    key: 'name',
                    header: 'Department',
                    render: (row) => (
                      <CellStack primary={row.name}>
                        {row.code ? <span className="tc-muted tc-mono">{row.code}</span> : null}
                      </CellStack>
                    ),
                  },
                  {
                    key: 'people',
                    header: 'Employees',
                    width: '6.5rem',
                    align: 'end',
                    nowrap: true,
                    render: (row) => headcount(row.employeeCount),
                  },
                  {
                    key: 'state',
                    header: 'State',
                    width: '7.5rem',
                    nowrap: true,
                    render: stateTag,
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    align: 'end',
                    width: '10rem',
                    render: (row) => (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyKey === `department-${row.id}`}
                          onClick={() => {
                            setNotice(null);
                            setEditing({ kind: 'department', entry: row });
                          }}
                          aria-label={`Edit ${row.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyKey === `department-${row.id}`}
                          onClick={() => void toggle('department', row)}
                          aria-label={`${row.isActive ? 'Switch off' : 'Switch on'} ${row.name}`}
                        >
                          {row.isActive ? 'Switch off' : 'Switch on'}
                        </button>
                      </CellActions>
                    ),
                  },
                ]}
              />
            </LoadingOverlay>
          )}
        </section>

        {/* ----------------------------------------------------- designations */}
        <section aria-labelledby="hr-org-designations">
          <div className="admin-toolbar hrp-section-head">
            <h3 className="tc-section-title" id="hr-org-designations" style={{ margin: 0 }}>
              Designations
            </h3>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setNotice(null);
                setEditing({ kind: 'designation', entry: null });
              }}
            >
              <Icon name="add" size={15} />
              Add a designation
            </button>
          </div>

          {designations === null ? (
            loading ? (
              <TableSkeleton rows={3} />
            ) : null
          ) : designations.length === 0 ? (
            <EmptyPanel
              title="No designations yet"
              message="Add job titles such as Executive or Team Lead, so each employee record can say what they do."
              actionLabel="Add a designation"
              onAction={() => setEditing({ kind: 'designation', entry: null })}
            />
          ) : (
            <LoadingOverlay busy={loading}>
              <DataTable
                rows={designations}
                rowKey={(row) => row.id}
                rowBusy={(row) => busyKey === `designation-${row.id}`}
                minWidth="34rem"
                caption="Designations, with the number of active employees holding each"
                columns={[
                  { key: 'name', header: 'Designation', render: (row) => row.name },
                  {
                    key: 'people',
                    header: 'Employees',
                    width: '6.5rem',
                    align: 'end',
                    nowrap: true,
                    render: (row) => headcount(row.employeeCount),
                  },
                  {
                    key: 'state',
                    header: 'State',
                    width: '7.5rem',
                    nowrap: true,
                    render: stateTag,
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    align: 'end',
                    width: '10rem',
                    render: (row) => (
                      <CellActions>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyKey === `designation-${row.id}`}
                          onClick={() => {
                            setNotice(null);
                            setEditing({ kind: 'designation', entry: row });
                          }}
                          aria-label={`Rename ${row.name}`}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyKey === `designation-${row.id}`}
                          onClick={() => void toggle('designation', row)}
                          aria-label={`${row.isActive ? 'Switch off' : 'Switch on'} ${row.name}`}
                        >
                          {row.isActive ? 'Switch off' : 'Switch on'}
                        </button>
                      </CellActions>
                    ),
                  },
                ]}
              />
            </LoadingOverlay>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------- settings */}
      <HrSettingsCard onUnauthorized={onUnauthorized} />

      {editing ? (
        <OrgEntryDialog
          key={`${editing.kind}-${editing.entry?.id ?? 'new'}`}
          kind={editing.kind}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
