'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  EMPLOYEE_ROLES,
  EMPLOYEE_ROLE_LABELS,
  formatDateTime,
  humanise,
  telecallingApi,
  type ApprovalStatus,
  type Employee,
  type EmployeeRole,
  type Paginated,
} from '@/lib/telecalling';
import { EmptyPanel, Pager, Tag, TableSkeleton } from './shared';

/**
 * Employee management (spec: Admin Module 3).
 *
 * Add, edit, activate, deactivate, reset a password, and hand a departing employee's
 * follow-ups to someone else. Deactivating an account revokes every mobile session it
 * holds server-side, so it takes effect within one access-token lifetime rather than
 * whenever the handset next signs out.
 *
 * This screen is also where self-registrations are granted access. An employee who signs
 * up in the mobile app cannot sign in until someone approves them here — the backend has
 * always enforced that, but there was no surface for it, so applicants were stranded on
 * the app's "waiting for approval" screen with nobody able to act.
 *
 * The three tabs are one list filtered by `approvalStatus`, not three data sources. That
 * matters because the states are a cycle, not a hierarchy: a rejection can be reopened
 * back to pending, and an approved account can later be deactivated without leaving the
 * approved state.
 */

const PAGE_SIZE = 25;

/**
 * The tabs, which are approval states plus their labels.
 *
 * `approved` is first and is the default: the everyday task on this screen is managing
 * staff, not processing signups. The pending tab carries a count badge so a waiting
 * applicant is visible without opening it.
 */
const TABS: { key: ApprovalStatus; label: string }[] = [
  { key: 'approved', label: 'Employees' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'rejected', label: 'Rejected' },
];

type NewEmployee = {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: EmployeeRole;
};

const BLANK: NewEmployee = { name: '', email: '', phone: '', password: '', role: 'telecaller' };

/**
 * How long an applicant has been waiting, in words.
 *
 * Shown next to the signup date because the date alone does not convey urgency: "12 Sept,
 * 09:14" reads the same whether it was this morning or three weeks ago, and someone who
 * cannot work until they are approved is a different problem on day one and day ten.
 */
function waitingFor(registeredAt: string | null): string | null {
  if (!registeredAt) return null;

  const since = new Date(registeredAt).getTime();
  if (Number.isNaN(since)) return null;

  const minutes = Math.floor((Date.now() - since) / 60_000);

  // A clock skew or a just-created row should not read "waiting -1 minutes".
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `waiting ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `waiting ${days} day${days === 1 ? '' : 's'}`;
}

export function EmployeesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<ApprovalStatus>('approved');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState<EmployeeRole | 'all'>('all');

  /**
   * The badge count, loaded separately from the list.
   *
   * Kept independent so the number is right while the admin is looking at the Employees
   * tab — deriving it from `data.total` would only be correct on the tab that is already
   * showing the queue, which is the one tab where a badge is redundant.
   */
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  const [data, setData] = useState<Paginated<Employee> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewEmployee>(BLANK);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [tab, debounced, role]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await telecallingApi.listEmployees(
          { page, pageSize: PAGE_SIZE, role, approval: tab, q: debounced || undefined },
          controller.signal,
        ),
      );
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load employees.');
    } finally {
      setLoading(false);
    }
  }, [page, role, tab, debounced, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Refreshes the pending badge.
   *
   * Deliberately not aborted along with the list request: it is a two-field response
   * that is cheap to let finish, and cancelling it on every keystroke in the search box
   * would leave the badge blank more often than not. A failure is swallowed — a missing
   * badge is a much smaller problem than an error banner over a working screen.
   */
  const refreshPendingCount = useCallback(async () => {
    try {
      setPendingCount(await telecallingApi.pendingRegistrationCount());
    } catch {
      setPendingCount(null);
    }
  }, []);

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  useEffect(() => () => abort.current?.abort(), []);

  /* ------------------------------------------------ registration approval */

  /**
   * Runs one approval action and reloads.
   *
   * Reloads rather than patching the row in place, for two reasons. The row usually
   * leaves the tab it was acted on from — an approved applicant is no longer pending —
   * and the server refuses a second decision with 400 "just decided by someone else",
   * which is only recoverable by re-reading. Two admins working the queue together is
   * exactly when this screen is busiest.
   */
  const decide = async (
    employee: Employee,
    action: () => Promise<Employee>,
    success: string,
  ) => {
    setBusyId(employee.id);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
      await load();
      await refreshPendingCount();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();

      /*
       * Reading the queue is open to supervisors; deciding it is administrator-only. A
       * supervisor reaching this point is hitting a role gate, not a fault, so it is
       * named as such — the same treatment CallsPanel gives a supervisor who opens the
       * recordings tab.
       */
      if (caught instanceof ApiError && caught.status === 403) {
        setError(
          'Only an administrator can approve or reject registrations. You can see who is waiting, but not grant access.',
        );
        return;
      }

      setError(
        caught instanceof ApiError ? caught.message : 'Could not update that registration.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (employee: Employee) => {
    /*
     * Confirmed because it grants access to customer personal data: an approved
     * telecaller can sign in and read the phone numbers, addresses and call history of
     * every lead assigned to them.
     */
    const confirmed = window.confirm(
      `Approve ${employee.name} (${employee.email})? They will be able to sign in to the mobile app immediately and see the leads assigned to them.`,
    );
    if (!confirmed) return;

    await decide(
      employee,
      () => telecallingApi.approveRegistration(employee.id),
      `${employee.name} approved. They can sign in to the mobile app now.`,
    );
  };

  const reject = async (employee: Employee) => {
    const reason = window.prompt(
      `Reject ${employee.name}'s registration? Give a reason — it is shown to them the next time they try to sign in, and it is the only message they will get.\n\nLeave blank to reject without one.`,
    );

    // Cancelled, as opposed to submitted empty, which is a valid "no reason given".
    if (reason === null) return;

    const trimmed = reason.trim();

    // The server's limit, checked here so a long reason is not lost to a 422.
    if (trimmed.length > 255) {
      setError('Keep the reason under 255 characters.');
      return;
    }

    await decide(
      employee,
      () => telecallingApi.rejectRegistration(employee.id, trimmed || null),
      `${employee.name}'s registration was rejected. They will be told when they next try to sign in.`,
    );
  };

  const reopen = async (employee: Employee) => {
    await decide(
      employee,
      () => telecallingApi.reopenRegistration(employee.id),
      `${employee.name} is back in the pending queue. Approve them from the Pending approval tab.`,
    );
  };

  /* ------------------------------------------------------------------ actions */

  const create = async () => {
    setFormErrors({});
    setError(null);
    setNotice(null);

    const localErrors: Record<string, string> = {};
    if (form.name.trim().length < 2) localErrors.name = 'Enter the full name.';
    if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(form.email.trim())) {
      localErrors.email = 'Enter a valid email address.';
    }
    // The server requires twelve; checking here saves a round trip and says why.
    if (form.password.length < 12) localErrors.password = 'Use at least 12 characters.';

    if (Object.keys(localErrors).length > 0) {
      setFormErrors(localErrors);
      return;
    }

    setCreating(true);

    try {
      const created = await telecallingApi.createEmployee({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim() || null,
        password: form.password,
        role: form.role,
      });

      setNotice(
        `${created.name} added as ${EMPLOYEE_ROLE_LABELS[created.role]} (${created.employeeCode}). Give them the password you just set — it cannot be retrieved later.`,
      );
      setForm(BLANK);
      setShowForm(false);
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFormErrors(caught.fieldErrors);
      } else {
        setError('Could not add the employee.');
      }
    } finally {
      setCreating(false);
    }
  };

  const setActive = async (employee: Employee, isActive: boolean) => {
    if (!isActive) {
      /**
       * Confirmed, because it is not only a flag: the server revokes every mobile session
       * the employee holds. Someone mid-shift is signed out of the app, which is the
       * intent when offboarding and a surprise otherwise.
       */
      const confirmed = window.confirm(
        `Deactivate ${employee.name}? They will be signed out of the mobile app immediately and cannot receive new leads. Their existing leads stay assigned to them until you reassign them.`,
      );
      if (!confirmed) return;
    }

    setBusyId(employee.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await telecallingApi.updateEmployee(employee.id, { isActive });
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((row) => (row.id === updated.id ? updated : row)),
            }
          : current,
      );
      setNotice(
        isActive ? `${updated.name} reactivated.` : `${updated.name} deactivated and signed out.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not update the employee.');
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = async (employee: Employee, next: EmployeeRole) => {
    setBusyId(employee.id);
    setError(null);

    try {
      const updated = await telecallingApi.updateEmployee(employee.id, { role: next });
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((row) => (row.id === updated.id ? updated : row)),
            }
          : current,
      );
      setNotice(`${updated.name} is now ${EMPLOYEE_ROLE_LABELS[updated.role]}.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      // The server refuses a self-demotion, which is the common case here — surface its
      // message rather than a generic one.
      setError(caught instanceof ApiError ? caught.message : 'Could not change the role.');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const resetPassword = async (employee: Employee) => {
    const password = window.prompt(
      `Set a new password for ${employee.name}. At least 12 characters. Every device they are signed in on will be signed out.`,
    );

    if (password === null) return;

    if (password.length < 12) {
      setError('The password must be at least 12 characters.');
      return;
    }

    setBusyId(employee.id);
    setError(null);

    try {
      await telecallingApi.resetEmployeePassword(employee.id, password);
      setNotice(
        `Password reset for ${employee.name}. They have been signed out everywhere — give them the new password directly.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not reset the password.');
    } finally {
      setBusyId(null);
    }
  };

  const handover = async (employee: Employee) => {
    if (!data) return;

    const candidates = data.items.filter((row) => row.isActive && row.id !== employee.id);

    if (candidates.length === 0) {
      setError('There is no other active employee to hand the follow-ups to.');
      return;
    }

    const answer = window.prompt(
      `Move ${employee.name}'s pending follow-ups to which employee? Enter the employee code.\n\n${candidates
        .map((row) => `${row.employeeCode} — ${row.name}`)
        .join('\n')}`,
    );

    if (answer === null) return;

    const target = candidates.find(
      (row) => row.employeeCode.toLowerCase() === answer.trim().toLowerCase(),
    );

    if (!target) {
      setError('That employee code did not match anyone active.');
      return;
    }

    setBusyId(employee.id);
    setError(null);

    try {
      const result = await telecallingApi.handoverFollowUps(employee.id, target.id);
      setNotice(
        `Moved ${result.moved} pending follow-up${result.moved === 1 ? '' : 's'} from ${employee.name} to ${target.name}.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(caught instanceof ApiError ? caught.message : 'Could not move the follow-ups.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="Employee approval state">
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
              {/*
                The badge appears only on the Pending tab and only when something is
                waiting. A "0" would be a permanent piece of furniture drawing the eye to
                a tab with nothing in it.
              */}
              {item.key === 'pending' && pendingCount !== null && pendingCount > 0 ? (
                <span className="tc-tab-count">{pendingCount}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="tc-emp-search">
              Search
            </label>
            <input
              id="tc-emp-search"
              className="input"
              type="search"
              value={search}
              placeholder="Name, email or code"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '15rem' }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-emp-role">
              Role
            </label>
            <select
              id="tc-emp-role"
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as EmployeeRole | 'all')}
            >
              <option value="all">All roles</option>
              {EMPLOYEE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {EMPLOYEE_ROLE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          {/*
            Only on the Employees tab. Creating an account by hand while looking at a
            queue of people asking for one is a confusing pair of controls to offer
            together, and an admin-created account skips approval entirely.
          */}
          {tab === 'approved' ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setShowForm((value) => !value)}
            >
              <Icon name="users" size={16} />
              {showForm ? 'Cancel' : 'Add employee'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {showForm && tab === 'approved' ? (
        <div className="tc-card tc-form">
          <h3 className="tc-section-title" style={{ marginTop: 0 }}>
            New employee
          </h3>

          <div className="tc-form__grid">
            <div className="field">
              <label className="field__label" htmlFor="tc-new-name">
                Full name
              </label>
              <input
                id="tc-new-name"
                className="input"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              {formErrors.name ? <p className="field__error">{formErrors.name}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-new-email">
                Email address
              </label>
              <input
                id="tc-new-email"
                className="input"
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
              {formErrors.email ? <p className="field__error">{formErrors.email}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-new-phone">
                Phone (optional)
              </label>
              <input
                id="tc-new-phone"
                className="input"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-new-role">
                Role
              </label>
              <select
                id="tc-new-role"
                className="select"
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value as EmployeeRole })}
              >
                {EMPLOYEE_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {EMPLOYEE_ROLE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tc-new-password">
                Password
              </label>
              <input
                id="tc-new-password"
                className="input"
                type="text"
                autoComplete="off"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              {formErrors.password ? (
                <p className="field__error">{formErrors.password}</p>
              ) : (
                <p className="field__hint">
                  {/*
                    Shown as plain text, not masked. An administrator has to read this out
                    or write it down to hand over — masking it guarantees a typo that
                    neither party can see, and it is about to be given to the employee
                    anyway.
                  */}
                  At least 12 characters. Shown in plain text because you need to pass it on
                  — it cannot be retrieved afterwards.
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Adding…' : 'Add employee'}
          </button>
        </div>
      ) : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data || data.items.length === 0 ? (
        tab === 'pending' ? (
          <EmptyPanel
            title="Nobody is waiting for approval"
            message="When an employee signs up in the mobile app they appear here, and cannot sign in until you approve them."
          />
        ) : tab === 'rejected' ? (
          <EmptyPanel
            title="No rejected registrations"
            message="Registrations you turn down are kept here, so one refused by mistake can be reopened rather than signed up again."
          />
        ) : (
          <EmptyPanel
            title="No employees"
            message="Add the first telecaller to start assigning leads."
            actionLabel="Add employee"
            onAction={() => setShowForm(true)}
          />
        )
      ) : tab === 'pending' ? (
        /* ------------------------------------------------ the signup queue */
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="58rem"
          caption="Employees who have signed up in the mobile app and are waiting for approval"
          columns={[
            {
              key: 'applicant',
              header: 'Applicant',
              render: (employee) => (
                <CellStack primary={employee.name} secondary={employee.email}>
                  <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                </CellStack>
              ),
            },
            {
              key: 'phone',
              header: 'Phone',
              width: '10rem',
              nowrap: true,
              render: (employee) => employee.phone ?? <span className="tc-muted">—</span>,
            },
            {
              key: 'registered',
              header: 'Signed up',
              width: '11rem',
              nowrap: true,
              render: (employee) => (
                <CellStack
                  primary={formatDateTime(employee.registeredAt)}
                  /*
                    The queue is ordered oldest-first server-side, so the person who has
                    been waiting longest is at the top of page one.
                  */
                  secondary={waitingFor(employee.registeredAt)}
                />
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'end',
              width: '15rem',
              nowrap: true,
              render: (employee) => (
                <CellActions>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void approve(employee)}
                  >
                    <Icon name="check" size={15} />
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void reject(employee)}
                  >
                    Reject
                  </button>
                </CellActions>
              ),
            },
          ]}
        />
      ) : tab === 'rejected' ? (
        /* ------------------------------------------ turned down, reopenable */
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="58rem"
          caption="Rejected registrations, which can be reopened"
          columns={[
            {
              key: 'applicant',
              header: 'Applicant',
              width: '16rem',
              render: (employee) => (
                <CellStack primary={employee.name} secondary={employee.email}>
                  <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                </CellStack>
              ),
            },
            {
              key: 'decided',
              header: 'Decided',
              width: '11rem',
              nowrap: true,
              /*
                `approvedAt` despite the name: the server writes that column on rejection
                too, so on these rows it is the decision time. Labelled "Decided" rather
                than "Approved" for that reason.
              */
              render: (employee) => formatDateTime(employee.approvedAt),
            },
            {
              key: 'reason',
              header: 'Reason given',
              render: (employee) =>
                employee.rejectionReason ?? (
                  <span className="tc-muted">No reason recorded</span>
                ),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'end',
              width: '10rem',
              nowrap: true,
              render: (employee) => (
                <CellActions>
                  {/*
                    Reopen, not Approve. The server refuses approving a rejected
                    registration outright and says to reopen it first, so offering
                    Approve here would be a button that always errors.
                  */}
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void reopen(employee)}
                  >
                    <Icon name="refresh" size={15} />
                    Reopen
                  </button>
                </CellActions>
              ),
            },
          ]}
        />
      ) : (
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="66rem"
          caption="Employees, with role, status and administrative actions"
          columns={[
            {
              key: 'employee',
              header: 'Employee',
              render: (employee) => (
                <CellStack primary={employee.name} secondary={employee.email}>
                  <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                  {employee.phone ? <span className="tc-muted">{employee.phone}</span> : null}
                </CellStack>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              width: '10rem',
              render: (employee) => (
                <select
                  className="select select--sm"
                  value={employee.role}
                  disabled={busyId === employee.id}
                  onChange={(event) =>
                    void changeRole(employee, event.target.value as EmployeeRole)
                  }
                  aria-label={`Change role for ${employee.name}`}
                >
                  {EMPLOYEE_ROLES.map((value) => (
                    <option key={value} value={value}>
                      {EMPLOYEE_ROLE_LABELS[value]}
                    </option>
                  ))}
                </select>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: '9rem',
              render: (employee) => (
                <CellStack
                  primary={
                    employee.isActive ? (
                      <Tag tone="good">Active</Tag>
                    ) : (
                      <Tag tone="bad">Deactivated</Tag>
                    )
                  }
                  secondary={humanise(employee.availability)}
                />
              ),
            },
            {
              key: 'lastLogin',
              header: 'Last signed in',
              width: '10rem',
              nowrap: true,
              render: (employee) => formatDateTime(employee.lastLoginAt),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'end',
              width: '20rem',
              render: (employee) => (
                <CellActions>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void resetPassword(employee)}
                  >
                    Reset password
                  </button>

                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void handover(employee)}
                  >
                    Move follow-ups
                  </button>

                  {employee.isActive ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busyId === employee.id}
                      onClick={() => void setActive(employee, false)}
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      disabled={busyId === employee.id}
                      onClick={() => void setActive(employee, true)}
                    >
                      Reactivate
                    </button>
                  )}
                </CellActions>
              ),
            },
          ]}
        />
      )}

      {data ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          noun={tab === 'approved' ? 'employee' : 'registration'}
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
