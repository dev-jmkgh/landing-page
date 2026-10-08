'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  APPROVAL_STATUSES,
  EMPLOYEE_ROLES,
  EMPLOYEE_ROLE_LABELS,
  companyPhoneKey,
  formatCompanyPhone,
  formatDateTime,
  humanise,
  telecallingApi,
  type ApprovalStatus,
  type CompanySim,
  type Employee,
  type EmployeeRole,
  type Paginated,
} from '@/lib/telecalling';
import { DeactivateEmployeeDialog, type DeactivateEmployeeMode } from './DeactivateEmployeeDialog';
import { useTelecallingNav } from './nav';
import { DateTimeCell, EmptyPanel, Pager, Tag, TableSkeleton } from './shared';
import { readEnum, readPage, readText } from './urlState';

/**
 * Employee management (spec: Admin Module 3).
 *
 * Add, edit, activate, deactivate, reset a password, set the company SIM number, and hand
 * a departing employee's follow-ups to someone else. Deactivating an account revokes every
 * mobile session it holds server-side, so it takes effect within one access-token lifetime
 * rather than whenever the handset next signs out — and it is refused while the employee
 * still holds pending follow-ups, which the deactivation dialog moves first.
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
 *
 * Filters live in the address: the dashboard's "Active employees" tile opens this list on
 * Status: Active, and a refresh or Back returns to the same view.
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

/** The Status filter on the Employees tab, as the `active` the API takes. */
type StatusFilter = 'all' | 'active' | 'inactive';

type NewEmployee = {
  name: string;
  email: string;
  /** Personal number, optional. */
  phone: string;
  /** The company SIM; required for a telecaller. */
  companyPhone: string;
  password: string;
  role: EmployeeRole;
};

const BLANK: NewEmployee = {
  name: '',
  email: '',
  phone: '',
  companyPhone: '',
  password: '',
  role: 'telecaller',
};

type Filters = {
  tab: ApprovalStatus;
  status: StatusFilter;
  role: EmployeeRole | 'all';
  simMissing: boolean;
  q: string;
  page: number;
};

function readFilters(params: URLSearchParams): Filters {
  const active = params.get('active');
  return {
    tab: readEnum(params, 'approval', APPROVAL_STATUSES, 'approved'),
    status: active === 'true' ? 'active' : active === 'false' ? 'inactive' : 'all',
    role: readEnum<EmployeeRole | 'all'>(params, 'role', EMPLOYEE_ROLES, 'all'),
    simMissing: params.get('companySim') === 'missing',
    q: readText(params, 'q'),
    page: readPage(params),
  };
}

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
  const nav = useTelecallingNav();
  const { replaceParams, leadId: openLeadId } = nav;

  // Read once: from here on the state is the source and the address follows it.
  const [initial] = useState(() => readFilters(nav.params));

  const [tab, setTab] = useState<ApprovalStatus>(initial.tab);
  const [status, setStatus] = useState<StatusFilter>(initial.status);
  const [role, setRole] = useState<EmployeeRole | 'all'>(initial.role);
  /*
   * Telecallers with no company number, or whose phone has not confirmed the company SIM
   * yet: the people whose incoming calls are not being recorded, to chase after rollout.
   */
  const [simMissing, setSimMissing] = useState(initial.simMissing);
  const [search, setSearch] = useState(initial.q);
  const [debounced, setDebounced] = useState(initial.q);
  const [page, setPage] = useState(initial.page);

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

  /** The employee in the deactivation / move-follow-ups dialog. */
  const [managing, setManaging] = useState<{
    employee: Employee;
    mode: DeactivateEmployeeMode;
  } | null>(null);

  const abort = useRef<AbortController | null>(null);

  /** Filters that only mean something on the Employees tab. */
  const approvedTab = tab === 'approved';

  /*
   * The search box, debounced. The page goes back to 1 only when the settled text really
   * changes — never on mount, where the page came from the address.
   */
  useEffect(() => {
    const next = search.trim();
    if (next === debounced) return undefined;

    const timer = window.setTimeout(() => {
      setDebounced(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, debounced]);

  /* A lead opening over this screen closes the dialog, which would otherwise stay open behind it. */
  useEffect(() => {
    if (openLeadId !== null) setManaging(null);
  }, [openLeadId]);

  /* -------------------------------------------------------- the address */

  useEffect(() => {
    replaceParams(
      {
        approval: tab,
        active: approvedTab && status !== 'all' ? status === 'active' : undefined,
        role,
        companySim: approvedTab && simMissing ? 'missing' : undefined,
        q: debounced,
        page,
      },
      { approval: 'approved', page: 1 },
    );
  }, [replaceParams, tab, approvedTab, status, role, simMissing, debounced, page]);

  /* ------------------------------------------------------------ loading */

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await telecallingApi.listEmployees(
        {
          page,
          pageSize: PAGE_SIZE,
          role,
          approval: tab,
          active: approvedTab && status !== 'all' ? status === 'active' : undefined,
          companySim: approvedTab && simMissing ? 'missing' : undefined,
          q: debounced || undefined,
        },
        controller.signal,
      );
      setData(result);
      // A page past the end — an approval just emptied it, or the address is older than
      // the list — comes back as the last page. The page follows, so the address matches.
      if (result.page !== page && !controller.signal.aborted) setPage(result.page);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load employees.');
    } finally {
      // An aborted request's `finally` must not clear the spinner of the one replacing it.
      if (abort.current === controller) setLoading(false);
    }
  }, [page, role, tab, approvedTab, status, simMissing, debounced, onUnauthorized]);

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

  /** Puts a changed employee back into the list in place. */
  const patchRow = useCallback((updated: Employee) => {
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((row) => (row.id === updated.id ? updated : row)),
          }
        : current,
    );
  }, []);

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

      // A company number that belongs to someone else comes back against the field.
      setError(
        caught instanceof ApiError
          ? (caught.fieldErrors.companyPhone ?? caught.message)
          : 'Could not update that registration.',
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
     *
     * An applicant from an older app build may have no company SIM number on record, and
     * the server will not approve without one — incoming calls are only ever counted from
     * that line. Asking for it here, in the same step, saves a refusal and a second try.
     */
    let companyPhone: string | undefined;

    if (employee.companyPhone === null) {
      const answer = window.prompt(
        `Approve ${employee.name} (${employee.email})? They will be able to sign in to the mobile app immediately and see the leads assigned to them.\n\nFirst enter their company SIM number. Check it against the SIM cards the company issued.`,
        '',
      );
      if (answer === null) return;

      const key = companyPhoneKey(answer);
      if (key === null) {
        setError(
          `Enter a 10-digit mobile number for ${employee.name}'s company SIM, then approve again.`,
        );
        return;
      }
      companyPhone = `+91${key}`;
    } else {
      const confirmed = window.confirm(
        `Approve ${employee.name} (${employee.email}) with the company SIM ${formatCompanyPhone(employee.companyPhone)}? Check the number against the SIM cards the company issued.\n\nThey will be able to sign in to the mobile app immediately and see the leads assigned to them.`,
      );
      if (!confirmed) return;
    }

    await decide(
      employee,
      () => telecallingApi.approveRegistration(employee.id, companyPhone),
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

    /*
     * The company SIM is required for a telecaller: their incoming calls are recorded
     * only when they reach this number, so a telecaller without one has none recorded at
     * all. Other roles may have one. Checked here with the server's own rule so a typo is
     * named before the round trip; the server checks again and also refuses a number
     * another employee already holds.
     */
    const companyText = form.companyPhone.trim();
    const companyKey = companyText ? companyPhoneKey(companyText) : null;
    if (form.role === 'telecaller' && !companyText) {
      localErrors.companyPhone = 'Enter the company SIM number for this telecaller.';
    } else if (companyText && companyKey === null) {
      localErrors.companyPhone = 'Enter a 10-digit mobile number.';
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
        companyPhone: companyKey !== null ? `+91${companyKey}` : null,
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

  /**
   * Reactivation stays a single click; deactivation goes through the dialog, which deals
   * with the follow-ups the server would otherwise refuse it over.
   */
  const reactivate = async (employee: Employee) => {
    setBusyId(employee.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await telecallingApi.updateEmployee(employee.id, { isActive: true });
      patchRow(updated);
      setNotice(`${updated.name} reactivated. They can sign in to the mobile app again.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.status === 403) {
        setError('Only an administrator can reactivate employees.');
        return;
      }
      // Their company number may have been given to someone since: that comes back
      // against the field, with the holder named.
      setError(
        caught instanceof ApiError
          ? (caught.fieldErrors.companyPhone ?? caught.message)
          : 'Could not reactivate the employee.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = async (employee: Employee, next: EmployeeRole) => {
    setBusyId(employee.id);
    setError(null);

    try {
      const updated = await telecallingApi.updateEmployee(employee.id, { role: next });
      patchRow(updated);
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

  /**
   * Sets, changes or removes the company SIM number.
   *
   * A prompt, like Reset password: one value, and the server's answer — a number already
   * held by someone else is refused, with the holder named — shows in the banner above.
   * Changing it clears the SIM their phone confirmed, so the app asks them to choose
   * their company SIM again.
   */
  const editCompanyNumber = async (employee: Employee) => {
    const current = employee.companyPhone ? formatCompanyPhone(employee.companyPhone) : '';
    const answer = window.prompt(
      `${employee.name}'s company SIM number — the SIM card the company issued them. Incoming calls are recorded only when they reach this number.\n\nChanging it asks them to choose their company SIM again in the app. Leave it blank to remove the number.`,
      current,
    );

    if (answer === null) return;

    const trimmed = answer.trim();
    let companyPhone: string | null;

    if (trimmed === '') {
      if (employee.companyPhone === null) return;

      const confirmed = window.confirm(
        `Remove ${employee.name}'s company number?${
          employee.role === 'telecaller'
            ? ' Their incoming calls will not be recorded until a number is added again.'
            : ''
        }`,
      );
      if (!confirmed) return;
      companyPhone = null;
    } else {
      const key = companyPhoneKey(trimmed);
      if (key === null) {
        setError(`Enter a 10-digit mobile number for ${employee.name}'s company SIM.`);
        return;
      }
      companyPhone = `+91${key}`;
      if (companyPhone === employee.companyPhone) return;
    }

    setBusyId(employee.id);
    setError(null);
    setNotice(null);

    try {
      const updated = await telecallingApi.updateEmployee(employee.id, { companyPhone });
      patchRow(updated);
      setNotice(
        updated.companyPhone
          ? `${updated.name}'s company number is now ${formatCompanyPhone(updated.companyPhone)}. The app will ask them to choose their company SIM again.`
          : `${updated.name}'s company number was removed.`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.status === 403) {
        setError('Only an administrator can change an employee’s company number.');
        return;
      }
      setError(
        caught instanceof ApiError
          ? (caught.fieldErrors.companyPhone ?? caught.message)
          : 'Could not save the company number.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const closeManaging = useCallback((summary: string | null) => {
    setManaging(null);
    if (summary) setNotice(summary);
  }, []);

  const handleDeactivated = useCallback(
    (updated: Employee, message: string) => {
      setManaging(null);
      setError(null);
      patchRow(updated);
      setNotice(message);
    },
    [patchRow],
  );

  /* ------------------------------------------------------------- render */

  const filtered =
    debounced !== '' || role !== 'all' || (approvedTab && (status !== 'all' || simMissing));

  const clearFilters = () => {
    setSearch('');
    setDebounced('');
    setRole('all');
    setStatus('all');
    setSimMissing(false);
    setPage(1);
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
              onClick={() => {
                if (item.key === tab) return;
                setTab(item.key);
                setPage(1);
              }}
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
              onChange={(event) => {
                setRole(event.target.value as EmployeeRole | 'all');
                setPage(1);
              }}
            >
              <option value="all">All roles</option>
              {EMPLOYEE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {EMPLOYEE_ROLE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          {approvedTab ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-emp-status">
                Status
              </label>
              <select
                id="tc-emp-status"
                className="select"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as StatusFilter);
                  setPage(1);
                }}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Deactivated</option>
              </select>
            </div>
          ) : null}

          {approvedTab ? (
            <div className="field">
              <label className="field__label" htmlFor="tc-emp-sim">
                Company SIM
              </label>
              <select
                id="tc-emp-sim"
                className="select"
                value={simMissing ? 'missing' : 'any'}
                onChange={(event) => {
                  setSimMissing(event.target.value === 'missing');
                  setPage(1);
                }}
              >
                <option value="any">Any</option>
                <option value="missing">Number missing or SIM not set up</option>
              </select>
            </div>
          ) : null}

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          {/*
            Only on the Employees tab. Creating an account by hand while looking at a
            queue of people asking for one is a confusing pair of controls to offer
            together, and an admin-created account skips approval entirely.
          */}
          {approvedTab ? (
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

      {showForm && approvedTab ? (
        <div className="tc-card tc-form">
          <h3 className="tc-section-title" style={{ marginTop: 0 }}>
            New employee
          </h3>

          <div className="tc-form__grid">
            <div className={`field${formErrors.name ? ' field--invalid' : ''}`}>
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

            <div className={`field${formErrors.email ? ' field--invalid' : ''}`}>
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

            <div className={`field${formErrors.companyPhone ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor="tc-new-company-phone">
                Company SIM number
                {form.role === 'telecaller' ? (
                  <span className="field__required" aria-hidden="true">
                    *
                  </span>
                ) : (
                  ' (optional)'
                )}
              </label>
              <input
                id="tc-new-company-phone"
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="98765 43210"
                required={form.role === 'telecaller'}
                aria-describedby="tc-new-company-phone-hint"
                value={form.companyPhone}
                onChange={(event) => setForm({ ...form, companyPhone: event.target.value })}
              />
              {formErrors.companyPhone ? (
                <p className="field__error">{formErrors.companyPhone}</p>
              ) : (
                <p className="field__hint" id="tc-new-company-phone-hint">
                  The SIM card the company issued them. Incoming calls are recorded only when
                  they reach this number{form.role === 'telecaller' ? '.' : ' — needed for telecallers.'}
                </p>
              )}
            </div>

            <div className={`field${formErrors.phone ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor="tc-new-phone">
                Personal phone (optional)
              </label>
              <input
                id="tc-new-phone"
                className="input"
                type="tel"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
              {formErrors.phone ? <p className="field__error">{formErrors.phone}</p> : null}
            </div>

            <div className={`field${formErrors.password ? ' field--invalid' : ''}`}>
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
            aria-busy={creating || undefined}
          >
            {creating ? <ButtonSpinner /> : null}
            Add employee
          </button>
        </div>
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
                message="Try another search, or clear the filters to see everyone on this tab."
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            ) : tab === 'pending' ? (
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
              minWidth="60rem"
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
                  key: 'companySim',
                  header: 'Company SIM',
                  width: '12rem',
                  render: (employee) => (
                    <CellStack
                      primary={
                        employee.companyPhone ? (
                          formatCompanyPhone(employee.companyPhone)
                        ) : (
                          /*
                            Older app builds did not ask for it. Approve asks for it, so
                            this is a warning about the next step, not a dead end.
                          */
                          <Tag tone="warn">Not given</Tag>
                        )
                      }
                      secondary={employee.phone ? `Personal: ${employee.phone}` : null}
                    />
                  ),
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
              /*
               * Fits beside the sidebar on a 1440px screen with the actions in view: they
               * stack one per line, about as tall as the employee's own details beside them.
               */
              minWidth="68rem"
              caption="Employees, with company SIM, role, status and administrative actions"
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  render: (employee) => (
                    <CellStack primary={employee.name} secondary={employee.email}>
                      <span className="tc-muted tc-mono">{employee.employeeCode}</span>
                      {employee.phone ? (
                        <span className="tc-muted">Personal: {employee.phone}</span>
                      ) : null}
                    </CellStack>
                  ),
                },
                {
                  key: 'companySim',
                  header: 'Company SIM',
                  width: '14rem',
                  render: (employee) => (
                    <CompanySimCell
                      employee={employee}
                      busy={busyId === employee.id}
                      onEdit={() => void editCompanyNumber(employee)}
                    />
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  // Wide enough for the select to show "Administrator" whole.
                  width: '11.5rem',
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
                  width: '8.5rem',
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
                  width: '8rem',
                  render: (employee) => <DateTimeCell value={employee.lastLoginAt} />,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  align: 'end',
                  // One button per line; wide enough that "Move follow-ups" stays on one.
                  width: '12rem',
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

                      {/*
                        Offered for deactivated employees too: follow-ups left on someone
                        who has gone are exactly the ones that need moving.
                      */}
                      <button
                        type="button"
                        className="btn btn--outline btn--sm"
                        disabled={busyId === employee.id}
                        onClick={() => {
                          setNotice(null);
                          setManaging({ employee, mode: 'move' });
                        }}
                      >
                        Move follow-ups
                      </button>

                      {employee.isActive ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === employee.id}
                          onClick={() => {
                            setNotice(null);
                            setManaging({ employee, mode: 'deactivate' });
                          }}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          disabled={busyId === employee.id}
                          onClick={() => void reactivate(employee)}
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
        </LoadingOverlay>
      )}

      {data ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          noun={approvedTab ? 'employee' : 'registration'}
          busy={loading}
          onChange={setPage}
        />
      ) : null}

      {managing ? (
        <DeactivateEmployeeDialog
          key={`${managing.mode}-${managing.employee.id}`}
          employee={managing.employee}
          mode={managing.mode}
          onClose={closeManaging}
          onDeactivated={handleDeactivated}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}

/**
 * The company number and what the employee's phone last said about the SIM.
 *
 * "SIM not set up" is the state that silently loses incoming calls — the number is on
 * record but no phone has confirmed which SIM holds it — so it is the one in warning
 * colour. A telecaller with no number at all is the same problem one step earlier.
 */
function CompanySimCell({
  employee,
  busy,
  onEdit,
}: {
  employee: Employee;
  busy: boolean;
  /** Adds or changes the number — here, beside it, rather than among the row's actions. */
  onEdit: () => void;
}) {
  const edit = (
    <button type="button" className="tc-text-button" disabled={busy} onClick={onEdit}>
      {employee.companyPhone ? 'Change number' : 'Add number'}
    </button>
  );

  if (!employee.companyPhone) {
    return employee.role === 'telecaller' ? (
      <CellStack primary={<span className="tc-muted">No company number</span>}>
        <Tag tone="warn">Incoming calls not recorded</Tag>
        {edit}
      </CellStack>
    ) : (
      <CellStack primary={<span className="tc-muted">—</span>}>{edit}</CellStack>
    );
  }

  return (
    <CellStack primary={formatCompanyPhone(employee.companyPhone)}>
      <SimStatus sim={employee.companySim} />
      {edit}
    </CellStack>
  );
}

function SimStatus({ sim }: { sim: CompanySim | null }) {
  if (sim === null) return <Tag tone="warn">SIM not set up</Tag>;

  const reported = `Reported ${formatDateTime(sim.at)}${sim.device ? ` from ${sim.device}` : ''}`;

  if (sim.status === 'declined') {
    // The employee said the company SIM is not in this phone, so nothing can be read from it.
    return (
      <span title={reported}>
        <Tag>Not on phone</Tag>
      </span>
    );
  }

  const details = [sim.label, sim.slot !== null ? `SIM ${sim.slot + 1}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <span title={reported}>
      <Tag tone="good">SIM confirmed{details ? ` · ${details}` : ''}</Tag>
    </span>
  );
}
