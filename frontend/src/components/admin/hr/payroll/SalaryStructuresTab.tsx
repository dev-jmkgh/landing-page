'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  formatCalendarDate,
  formatInr,
  payrollApi,
  type PayrollDepartment,
  type PayrollEmployee,
  type PayrollPage,
} from '@/lib/hrPayroll';
import { EmptyPanel, Pager, TableSkeleton, Tag } from '../../telecalling/shared';
import { EmployeeStructures } from './EmployeeStructures';
import { isAbort, readFailure } from './shared';

/**
 * Who is set up for payroll, and each employee's salary structures.
 *
 * A structure is what an employee is paid in a full month — earnings and deductions —
 * from a date. Payroll uses, for each pay period, the structure with the latest
 * `effectiveFrom` on or before the period's last day; an employee with none is left out
 * of the period (and its "Not included" card names them). So the question this list
 * answers first is "who is not set up", which is why the Set up filter exists and why a
 * pay period links here — on one employee, with the filter set to No behind them.
 *
 * Every employee approved in the HR app is listed, active or not: an account switched
 * off mid-month still worked part of it and is still paid for that part.
 */

const PAGE_SIZE = 20;

export type SetUpFilter = 'all' | 'true' | 'false';

/**
 * Where another screen sends this tab: a Set up filter, and optionally one employee to
 * open straight away — from a pay period's "Not included" list, which knows the person
 * only by id and code.
 */
export type StructuresTarget = {
  setUp: SetUpFilter;
  employee?: { userId: number; employeeCode: string };
};

export function SalaryStructuresTab({
  initialSetUp = 'all',
  initialEmployee,
  onUnauthorized,
  onRestricted,
}: {
  /** Where the tab starts — "No" when opened from a pay period that left people out. */
  initialSetUp?: SetUpFilter;
  /** An employee to open on arrival; the list (with `initialSetUp`) is where Back goes. */
  initialEmployee?: StructuresTarget['employee'];
  onUnauthorized: () => void;
  onRestricted: () => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [setUp, setSetUp] = useState<SetUpFilter>(initialSetUp);
  const [page, setPage] = useState(1);

  const [departments, setDepartments] = useState<PayrollDepartment[] | null>(null);
  const [data, setData] = useState<PayrollPage<PayrollEmployee> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<PayrollEmployee | null>(null);
  /** True while `initialEmployee` is being looked up, so the list does not flash first. */
  const [opening, setOpening] = useState(Boolean(initialEmployee));

  const abort = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusListOnReturn = useRef(false);

  /* The search applies once typing pauses, and starts again from page 1. */
  useEffect(() => {
    const next = search.trim();
    if (next === query) return undefined;
    const timer = window.setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  /*
   * Departments for the filter: a bounded list, loaded once and allowed to fail quietly.
   * Without it the filter is simply not offered — the list itself still works, and an
   * error banner over a working screen for the sake of a dropdown would be worse.
   */
  useEffect(() => {
    const controller = new AbortController();
    payrollApi
      .listDepartments(controller.signal)
      .then(setDepartments)
      .catch(() => {
        if (!controller.signal.aborted) setDepartments([]);
      });
    return () => controller.abort();
  }, []);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await payrollApi.listEmployees(
          {
            q: query || undefined,
            departmentId: departmentId ? Number(departmentId) : undefined,
            setUp,
            page,
            pageSize: PAGE_SIZE,
          },
          controller.signal,
        ),
      );
    } catch (caught) {
      if (isAbort(caught)) return;
      setError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load the employees.'));
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [query, departmentId, setUp, page, onUnauthorized, onRestricted]);

  /*
   * Opening one employee on arrival. There is no single-employee payroll endpoint, so it
   * is the list searched by employee code and matched on id (as EmployeeStructures
   * refreshes itself). If they are not found, the list is left searched by their code,
   * which shows what payroll does know about them.
   */
  useEffect(() => {
    if (!initialEmployee) return undefined;
    const controller = new AbortController();
    payrollApi
      .listEmployees({ q: initialEmployee.employeeCode, page: 1, pageSize: PAGE_SIZE }, controller.signal)
      .then((result) => {
        const found = result.items.find((item) => item.user.id === initialEmployee.userId);
        if (found) {
          setSelected(found);
        } else {
          setSearch(initialEmployee.employeeCode);
          setQuery(initialEmployee.employeeCode);
        }
      })
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        const message = readFailure(caught, { onUnauthorized, onRestricted }, 'Could not open that employee.');
        if (message) setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOpening(false);
      });
    return () => controller.abort();
  }, [initialEmployee, onUnauthorized, onRestricted]);

  // Read while the list is showing, and again on the way back from an employee — their
  // structures may have changed, and with them what this row says.
  useEffect(() => {
    if (selected === null && !opening) void load();
  }, [load, selected, opening]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (selected === null && focusListOnReturn.current) {
      focusListOnReturn.current = false;
      headingRef.current?.focus();
    }
  }, [selected]);

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(1);
  }, [data, page]);

  const clearFilters = () => {
    setSearch('');
    setQuery('');
    setDepartmentId('');
    setSetUp('all');
    setPage(1);
  };

  /* -------------------------------------------------------- one employee */

  if (opening) {
    return <LoaderBlock label={`Opening ${initialEmployee?.employeeCode ?? 'the employee'}…`} />;
  }

  if (selected) {
    return (
      <EmployeeStructures
        key={selected.user.id}
        employee={selected}
        onBack={() => {
          focusListOnReturn.current = true;
          setSelected(null);
        }}
        onUnauthorized={onUnauthorized}
        onRestricted={onRestricted}
      />
    );
  }

  /* ---------------------------------------------------------------- list */

  const filtered = query !== '' || departmentId !== '' || setUp !== 'all';
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="admin-toolbar">
        <h2 className="tc-section-title" style={{ margin: 0 }} ref={headingRef} tabIndex={-1}>
          Salary structures
        </h2>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-pay-emp-search">
              Search
            </label>
            <input
              id="hr-pay-emp-search"
              className="input hr-pay-search-input"
              type="search"
              value={search}
              placeholder="Name, email or code"
              maxLength={120}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {departments && departments.length > 0 ? (
            <div className="field">
              <label className="field__label" htmlFor="hr-pay-emp-dept">
                Department
              </label>
              <select
                id="hr-pay-emp-dept"
                className="select"
                value={departmentId}
                onChange={(event) => {
                  setDepartmentId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                    {department.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor="hr-pay-emp-setup">
              Set up for payroll
            </label>
            <select
              id="hr-pay-emp-setup"
              className="select"
              value={setUp}
              onChange={(event) => {
                setSetUp(event.target.value as SetUpFilter);
                setPage(1);
              }}
            >
              <option value="all">Everyone</option>
              <option value="true">Yes — has a structure</option>
              <option value="false">No — no structure</option>
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data ? (
        <EmptyPanel
          title="Employees not loaded"
          message="The employee list could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : data.items.length === 0 ? (
        filtered ? (
          <EmptyPanel
            title={setUp === 'false' && query === '' && departmentId === '' ? 'Everyone is set up' : 'Nobody matches these filters'}
            message={
              setUp === 'false' && query === '' && departmentId === ''
                ? 'Every approved employee has a salary structure, so nobody is left out of a pay period for want of one.'
                : 'Try a different search or department, or clear the filters.'
            }
            actionLabel="Clear filters"
            onAction={clearFilters}
          />
        ) : (
          <EmptyPanel
            title="No employees yet"
            message="Employees appear here once their HR app account is approved. Then give each a salary structure."
          />
        )
      ) : (
        <LoadingOverlay busy={loading} label="Updating…">
          <DataTable
            rows={data.items}
            rowKey={(row) => row.user.id}
            minWidth="64rem"
            caption="Employees and the salary structure each is paid by"
            onRowDoubleClick={(row) => setSelected(row)}
            rowTitle={() => 'Double-click to open the salary structures'}
            rowTone={(row) => (row.currentStructure || row.upcomingStructure ? undefined : 'warn')}
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                render: (row) => (
                  <CellStack
                    primary={
                      <button type="button" className="hr-pay-link" onClick={() => setSelected(row)}>
                        {row.user.name}
                      </button>
                    }
                    secondary={row.user.email}
                  >
                    <span className="tc-muted tc-mono">{row.user.employeeCode}</span>
                    {!row.user.isActive ? <Tag tone="bad">Switched off</Tag> : null}
                    {row.user.employmentStatus === 'exited' ? <Tag>Exited</Tag> : null}
                  </CellStack>
                ),
              },
              {
                key: 'department',
                header: 'Department',
                width: '11rem',
                render: (row) => (
                  <CellStack
                    primary={
                      <span className="hr-pay-plain">
                        {row.user.departmentName ?? <span className="tc-muted">No department</span>}
                      </span>
                    }
                    secondary={row.user.designationName ?? undefined}
                  />
                ),
              },
              {
                key: 'current',
                header: 'Current structure',
                width: '12rem',
                render: (row) =>
                  row.currentStructure ? (
                    <CellStack
                      primary={
                        <span className="hr-pay-net">{formatInr(row.currentStructure.totals.net)}</span>
                      }
                      secondary={`Net a month · from ${formatCalendarDate(row.currentStructure.effectiveFrom)}`}
                    />
                  ) : row.upcomingStructure ? (
                    <span className="tc-muted">None yet</span>
                  ) : (
                    <Tag tone="warn">Not set up</Tag>
                  ),
              },
              {
                key: 'upcoming',
                header: 'Upcoming',
                width: '12rem',
                render: (row) =>
                  row.upcomingStructure ? (
                    <CellStack
                      primary={
                        <span className="hr-pay-net">{formatInr(row.upcomingStructure.totals.net)}</span>
                      }
                      secondary={`Net a month · from ${formatCalendarDate(row.upcomingStructure.effectiveFrom)}`}
                    />
                  ) : (
                    <span className="tc-muted">—</span>
                  ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'end',
                width: '9.5rem',
                nowrap: true,
                render: (row) => (
                  <button
                    type="button"
                    className={
                      row.currentStructure || row.upcomingStructure
                        ? 'btn btn--outline btn--sm'
                        : 'btn btn--primary btn--sm'
                    }
                    onClick={() => setSelected(row)}
                    aria-label={`${
                      row.currentStructure || row.upcomingStructure ? 'Salary structures for' : 'Set up a salary structure for'
                    } ${row.user.name}`}
                  >
                    {row.currentStructure || row.upcomingStructure ? 'Structures' : 'Set up'}
                  </button>
                ),
              },
            ]}
          />

          <Pager
            page={data.page}
            totalPages={totalPages}
            total={data.total}
            noun="employee"
            busy={loading}
            onChange={setPage}
          />
        </LoadingOverlay>
      )}
    </>
  );
}
