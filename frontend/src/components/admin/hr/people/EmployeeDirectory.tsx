'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '@/components/admin/telecalling/shared';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/telecalling';
import {
  HR_APPROVAL_LABELS,
  HR_EMPLOYMENT_STATUSES,
  HR_EMPLOYMENT_STATUS_LABELS,
  HR_EMPLOYMENT_TYPE_LABELS,
  HR_ROLE_LABELS,
  WORK_MODES,
  WORK_MODE_LABELS,
  hrApi,
  pageCount,
  peopleApi,
  type Department,
  type Designation,
  type HrApprovalStatus,
  type HrEmployee,
  type HrEmploymentStatus,
  type HrPaginated,
  type WorkMode,
} from '@/lib/hr';
import { AssignmentDialog } from '../AssignmentDialog';
import { EmployeePicker, type PickedEmployee } from './EmployeePicker';
import { isAbort } from './shared';

/**
 * The employee directory: everyone with an HR account, alphabetical, one page at a time,
 * narrowed on the server by any combination of the filters.
 *
 * Approved accounts by default — the everyday population — with the approval filter
 * there for finding an applicant by department or manager. The pending and rejected TABS
 * stay the place to work the signup queue: they are ordered by who has waited longest,
 * which an alphabetical list is not.
 */

const PAGE_SIZE = 25;

type ApprovalFilter = HrApprovalStatus | 'all';
type AccessFilter = 'all' | 'true' | 'false';

export function EmployeeDirectory({
  departments,
  designations,
  reloadToken,
  onOpen,
  onAdd,
  onNotice,
  onUnauthorized,
}: {
  departments: Department[] | null;
  designations: Designation[] | null;
  /** Changes whenever something elsewhere (the detail view, Add) changed an employee. */
  reloadToken: number;
  onOpen: (employee: HrEmployee) => void;
  onAdd: () => void;
  onNotice: (message: string | null) => void;
  onUnauthorized: () => void;
}) {
  const dialogs = useDialogs();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [manager, setManager] = useState<PickedEmployee | null>(null);
  const [workMode, setWorkMode] = useState<WorkMode | ''>('');
  const [employmentStatus, setEmploymentStatus] = useState<HrEmploymentStatus | ''>('');
  const [access, setAccess] = useState<AccessFilter>('all');
  const [approval, setApproval] = useState<ApprovalFilter>('approved');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<HrPaginated<HrEmployee> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState<HrEmployee | null>(null);

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

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await peopleApi.directory(
        {
          page,
          pageSize: PAGE_SIZE,
          q: debounced || undefined,
          departmentId: departmentId ? Number(departmentId) : undefined,
          designationId: designationId ? Number(designationId) : undefined,
          managerId: manager?.id,
          workMode: workMode || undefined,
          employmentStatus: employmentStatus || undefined,
          active: access === 'all' ? undefined : access,
          approval: approval === 'all' ? undefined : approval,
        },
        controller.signal,
      );
      // A page past the end — the list shrank under a filter or an edit — steps back.
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
      setError(caught instanceof ApiError ? caught.message : 'Could not load the directory.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [
    page,
    debounced,
    departmentId,
    designationId,
    manager,
    workMode,
    employmentStatus,
    access,
    approval,
    onUnauthorized,
  ]);

  // `reloadToken` is here on purpose: a change made elsewhere re-reads the current page.
  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => () => abort.current?.abort(), []);

  const setActive = async (employee: HrEmployee, active: boolean) => {
    if (!active) {
      const confirmed = await dialogs.confirm({
        title: `Switch off ${employee.name}'s HR access?`,
        message:
          'They are signed out of the HR app on every device straight away.\n\nThis does NOT affect any telecalling account they hold — that is a separate login.',
        confirmLabel: 'Switch off',
        danger: true,
      });
      if (!confirmed) return;
    }

    setBusyId(employee.id);
    setError(null);
    onNotice(null);

    try {
      await hrApi.setActive(employee.id, active);
      onNotice(
        active
          ? `${employee.name} can sign in to the HR app again.`
          : `${employee.name}'s HR access is switched off and their devices are signed out.`,
      );
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(
        caught instanceof ApiError && caught.status === 403
          ? 'Only an administrator can switch HR access on or off.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not update that account.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const filtered =
    debounced !== '' ||
    departmentId !== '' ||
    designationId !== '' ||
    manager !== null ||
    workMode !== '' ||
    employmentStatus !== '' ||
    access !== 'all' ||
    approval !== 'approved';

  const clearFilters = () => {
    setSearch('');
    setDebounced('');
    setDepartmentId('');
    setDesignationId('');
    setManager(null);
    setWorkMode('');
    setEmploymentStatus('');
    setAccess('all');
    setApproval('approved');
    setPage(1);
  };

  /** Every filter change goes back to page 1 — in the handler, never in an effect. */
  const change =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };

  return (
    <>
      <div className="hrp-filters" role="search" aria-label="Filter the employee directory">
        <div className="field">
          <label className="field__label" htmlFor="hr-dir-search">
            Search
          </label>
          <input
            id="hr-dir-search"
            className="input"
            type="search"
            value={search}
            placeholder="Name, email, phone or code"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-department">
            Department
          </label>
          <select
            id="hr-dir-department"
            className="select"
            value={departmentId}
            onChange={(event) => change(setDepartmentId)(event.target.value)}
          >
            <option value="">All departments</option>
            {(departments ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
                {department.isActive ? '' : ' (switched off)'}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-designation">
            Designation
          </label>
          <select
            id="hr-dir-designation"
            className="select"
            value={designationId}
            onChange={(event) => change(setDesignationId)(event.target.value)}
          >
            <option value="">All designations</option>
            {(designations ?? []).map((designation) => (
              <option key={designation.id} value={designation.id}>
                {designation.name}
                {designation.isActive ? '' : ' (switched off)'}
              </option>
            ))}
          </select>
        </div>

        <EmployeePicker
          label="Reports to"
          layout="popover"
          value={manager}
          onChange={change(setManager)}
          onUnauthorized={onUnauthorized}
        />

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-mode">
            Works
          </label>
          <select
            id="hr-dir-mode"
            className="select"
            value={workMode}
            onChange={(event) => change(setWorkMode)(event.target.value as WorkMode | '')}
          >
            <option value="">Any way</option>
            {WORK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {WORK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-employment">
            Employment
          </label>
          <select
            id="hr-dir-employment"
            className="select"
            value={employmentStatus}
            onChange={(event) =>
              change(setEmploymentStatus)(event.target.value as HrEmploymentStatus | '')
            }
          >
            <option value="">Any status</option>
            {HR_EMPLOYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {HR_EMPLOYMENT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-access">
            App access
          </label>
          <select
            id="hr-dir-access"
            className="select"
            value={access}
            onChange={(event) => change(setAccess)(event.target.value as AccessFilter)}
          >
            <option value="all">Either</option>
            <option value="true">Can sign in</option>
            <option value="false">Switched off</option>
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="hr-dir-approval">
            Approval
          </label>
          <select
            id="hr-dir-approval"
            className="select"
            value={approval}
            onChange={(event) => change(setApproval)(event.target.value as ApprovalFilter)}
          >
            <option value="approved">Approved</option>
            <option value="pending">Pending approval</option>
            <option value="rejected">Rejected</option>
            <option value="all">Any state</option>
          </select>
        </div>

        <div className="hrp-filters__actions">
          {filtered ? (
            <button type="button" className="btn btn--ghost" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {assigning ? (
        <AssignmentDialog
          employee={assigning}
          onUnauthorized={onUnauthorized}
          onClose={() => setAssigning(null)}
          onSaved={(message) => {
            setAssigning(null);
            onNotice(message);
            void load();
          }}
        />
      ) : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {data.items.length === 0 ? (
            filtered ? (
              <EmptyPanel
                title="Nobody matches these filters"
                message="Try another search, or clear the filters to see every approved employee."
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            ) : (
              <EmptyPanel
                title="No HR employees yet"
                message="Add an employee here, or approve somebody who signed up in the HR app."
                actionLabel="Add employee"
                onAction={onAdd}
              />
            )
          ) : (
            <DataTable
              rows={data.items}
              rowKey={(employee) => employee.id}
              rowBusy={(employee) => busyId === employee.id}
              /*
               * Fits beside the sidebar at 1440px with the actions in view: the reporting
               * line shares the team column rather than taking a column of its own.
               */
              minWidth="70rem"
              caption="HR employee directory"
              onRowDoubleClick={onOpen}
              rowTitle={(employee) => `Double-click to open ${employee.name}`}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  render: (employee) => (
                    <CellStack
                      primary={
                        <button
                          type="button"
                          className="tc-link-button hrp-name-link"
                          onClick={() => onOpen(employee)}
                        >
                          {employee.name}
                        </button>
                      }
                      secondary={employee.email}
                    >
                      <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                      {employee.role !== 'employee' ? <Tag tone="progress">{HR_ROLE_LABELS[employee.role]}</Tag> : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'team',
                  header: 'Team',
                  width: '13rem',
                  render: (employee) => (
                    <CellStack
                      primary={
                        employee.designationName ?? <span className="tc-muted">No designation</span>
                      }
                      secondary={employee.departmentName ?? 'No department'}
                    >
                      {employee.managerName ? (
                        <span className="tc-muted">Reports to {employee.managerName}</span>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'employment',
                  header: 'Employment',
                  width: '10rem',
                  render: (employee) => (
                    <CellStack
                      primary={HR_EMPLOYMENT_TYPE_LABELS[employee.employmentType]}
                      secondary={
                        employee.joiningDate ? `Joined ${formatDate(employee.joiningDate)}` : 'Joining date not recorded'
                      }
                    >
                      {employee.employmentStatus !== 'active' ? (
                        <Tag tone={employee.employmentStatus === 'exited' ? 'bad' : 'warn'}>
                          {HR_EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]}
                        </Tag>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'rule',
                  header: 'Attendance rule',
                  width: '12rem',
                  render: (employee) => (
                    <CellStack
                      primary={WORK_MODE_LABELS[employee.workMode] ?? employee.workMode}
                      /*
                        An office worker with no site cannot check in at all, so that gap
                        is called out rather than left blank — this column is the only
                        place an administrator would notice it before the employee does.
                      */
                      secondary={
                        employee.workMode === 'office'
                          ? (employee.workLocationName ?? 'no site — cannot check in')
                          : 'no location check'
                      }
                    >
                      <span className="tc-muted">{employee.shiftName ?? 'no shift'}</span>
                    </CellStack>
                  ),
                },
                {
                  key: 'access',
                  header: 'App access',
                  width: '8.5rem',
                  render: (employee) =>
                    employee.approvalStatus !== 'approved' ? (
                      <Tag tone={employee.approvalStatus === 'rejected' ? 'bad' : 'warn'}>
                        {HR_APPROVAL_LABELS[employee.approvalStatus]}
                      </Tag>
                    ) : employee.isActive ? (
                      <Tag tone="good">Can sign in</Tag>
                    ) : (
                      <Tag tone="bad">Switched off</Tag>
                    ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  width: '9rem',
                  render: (employee) => (
                    <CellActions>
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        disabled={busyId === employee.id}
                        onClick={() => {
                          onNotice(null);
                          setAssigning(employee);
                        }}
                        aria-label={`Attendance rule for ${employee.name}`}
                      >
                        <Icon name="pin" size={14} />
                        Rule
                      </button>
                      {employee.approvalStatus === 'approved' ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === employee.id}
                          onClick={() => void setActive(employee, !employee.isActive)}
                          aria-label={`${employee.isActive ? 'Switch off' : 'Switch on'} ${employee.name}’s HR access`}
                        >
                          {employee.isActive ? 'Switch off' : 'Switch on'}
                        </button>
                      ) : null}
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
          noun="employee"
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
