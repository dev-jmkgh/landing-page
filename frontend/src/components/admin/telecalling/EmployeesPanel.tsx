'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  EMPLOYEE_ROLES,
  EMPLOYEE_ROLE_LABELS,
  formatDateTime,
  humanise,
  telecallingApi,
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
 */

const PAGE_SIZE = 25;

type NewEmployee = {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: EmployeeRole;
};

const BLANK: NewEmployee = { name: '', email: '', phone: '', password: '', role: 'telecaller' };

export function EmployeesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState<EmployeeRole | 'all'>('all');

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
  }, [debounced, role]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await telecallingApi.listEmployees(
          { page, pageSize: PAGE_SIZE, role, q: debounced || undefined },
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
  }, [page, role, debounced, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abort.current?.abort(), []);

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

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setShowForm((value) => !value)}
          >
            <Icon name="users" size={16} />
            {showForm ? 'Cancel' : 'Add employee'}
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {showForm ? (
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
        <EmptyPanel
          title="No employees"
          message="Add the first telecaller to start assigning leads."
          actionLabel="Add employee"
          onAction={() => setShowForm(true)}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Last signed in</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((employee) => (
                <tr key={employee.id} aria-busy={busyId === employee.id}>
                  <td>
                    <strong>{employee.name}</strong>
                    <br />
                    <span className="tc-muted">{employee.email}</span>
                    <br />
                    <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                    {employee.phone ? (
                      <>
                        <br />
                        <span className="tc-muted">{employee.phone}</span>
                      </>
                    ) : null}
                  </td>

                  <td>
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
                  </td>

                  <td>
                    {employee.isActive ? (
                      <Tag tone="good">Active</Tag>
                    ) : (
                      <Tag tone="bad">Deactivated</Tag>
                    )}
                    <br />
                    <span className="tc-muted">{humanise(employee.availability)}</span>
                  </td>

                  <td>{formatDateTime(employee.lastLoginAt)}</td>

                  <td>
                    <div className="tc-row-actions">
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          noun="employee"
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
