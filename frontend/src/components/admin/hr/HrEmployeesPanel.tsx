'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/telecalling';
import {
  HR_ROLE_LABELS,
  hrApi,
  type HrApprovalStatus,
  type HrEmployee,
  type HrPaginated,
} from '@/lib/hr';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '../telecalling/shared';

/**
 * HR employees, and the queue of people waiting to be let in.
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * Employees register themselves in the HR app and cannot sign in until somebody approves
 * them. The backend has enforced that from the start, but there was no surface for it —
 * so an applicant sat on the app's "waiting for approval" screen and the only way to let
 * them in was to call the API by hand. That made HR self-signup unusable in practice.
 *
 * WHY IT IS NOT THE TELECALLING EMPLOYEES SCREEN
 * ----------------------------------------------
 * HR accounts are a different table with different roles (backend migration 017). The
 * same person can hold a telecalling account AND an HR account, on the same email, with
 * different passwords — which is the point, since a telecaller also takes leave. Folding
 * both into one screen would mean one row standing for two accounts whose states move
 * independently: approving here does not approve there, and deactivating here does not
 * touch their lead access.
 *
 * `formatDateTime` is imported from the telecalling lib rather than duplicated. It is a
 * date formatter, not domain vocabulary — the separation is about accounts and tokens,
 * not about owning a second copy of `toLocaleString`.
 */

const PAGE_SIZE = 25;

/**
 * `approved` first and by default: the everyday task here is managing staff, not
 * processing signups. The pending tab carries a count so a waiting applicant is visible
 * without opening it.
 */
const TABS: { key: HrApprovalStatus; label: string }[] = [
  { key: 'approved', label: 'Employees' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'rejected', label: 'Rejected' },
];

/**
 * How long somebody has been waiting, in words.
 *
 * Shown next to the signup date because the date alone carries no urgency: "12 Sept,
 * 09:14" reads the same whether it was this morning or three weeks ago, and an employee
 * locked out of the app is a different problem on day one and day ten.
 */
function waitingFor(registeredAt: string | null): string | null {
  if (!registeredAt) return null;

  const since = new Date(registeredAt).getTime();
  if (Number.isNaN(since)) return null;

  const minutes = Math.floor((Date.now() - since) / 60_000);

  // Clock skew or a just-created row must not read "waiting -1 minutes".
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `waiting ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `waiting ${days} day${days === 1 ? '' : 's'}`;
}

export function HrEmployeesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tab, setTab] = useState<HrApprovalStatus>('approved');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [data, setData] = useState<HrPaginated<HrEmployee> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [tab, debounced]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await hrApi.listEmployees(
          { page, pageSize: PAGE_SIZE, approval: tab, q: debounced || undefined },
          controller.signal,
        ),
      );
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load HR employees.');
    } finally {
      setLoading(false);
    }
  }, [page, tab, debounced, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The badge count, loaded separately and allowed to fail quietly.
   *
   * A missing badge is a far smaller problem than an error banner over a working screen,
   * and cancelling this on every keystroke would leave it blank more often than not.
   */
  const refreshPendingCount = useCallback(async () => {
    try {
      setPendingCount(await hrApi.pendingCount());
    } catch {
      setPendingCount(null);
    }
  }, []);

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  useEffect(() => () => abort.current?.abort(), []);

  /* ------------------------------------------------ decisions */

  /**
   * Runs one action and reloads.
   *
   * Reloads rather than patching the row in place: the row usually leaves the tab it was
   * acted on from, and the server refuses a second decision with a 400, which is only
   * recoverable by re-reading. Two administrators working the queue together is exactly
   * when this screen is busiest.
   */
  const act = async (
    employee: HrEmployee,
    action: () => Promise<HrEmployee>,
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
       * supervisor landing here has hit a role gate, not a fault, so it is named as one.
       */
      if (caught instanceof ApiError && caught.status === 403) {
        setError(
          'Only an administrator can approve or reject registrations. You can see who is waiting, but not grant access.',
        );
        return;
      }

      setError(caught instanceof ApiError ? caught.message : 'Could not update that account.');
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (employee: HrEmployee) => {
    /*
     * The server refuses this anyway — `approveHrUser` carries
     * `email_verified_at IS NOT NULL` in its WHERE clause — but catching it here turns a
     * 400 into an explanation of whose move it is. Nothing the administrator can do
     * unblocks an applicant who has not opened their email.
     */
    if (employee.emailVerifiedAt === null) {
      setError(
        `${employee.name} has not confirmed their email address yet. They need to enter the code sent to ${employee.email} before the account can be approved.`,
      );
      return;
    }

    const confirmed = window.confirm(
      `Approve ${employee.name} (${employee.email})? They will be able to sign in to the HR app immediately.`,
    );
    if (!confirmed) return;

    await act(
      employee,
      () => hrApi.approve(employee.id),
      `${employee.name} approved. They can sign in to the HR app now.`,
    );
  };

  const reject = async (employee: HrEmployee) => {
    const reason = window.prompt(
      `Reject ${employee.name}'s registration? Give a reason — it is shown to them the next time they try to sign in, and it is the only message they will get.\n\nLeave blank to reject without one.`,
    );

    // Cancelled, as opposed to submitted empty, which is a valid "no reason given".
    if (reason === null) return;

    const trimmed = reason.trim();

    // The server's limit, checked here so a long reason is not lost to a 422.
    if (trimmed.length > 500) {
      setError('Keep the reason under 500 characters.');
      return;
    }

    await act(
      employee,
      () => hrApi.reject(employee.id, trimmed || null),
      `${employee.name}'s registration was rejected. They will be told when they next try to sign in.`,
    );
  };

  const setActive = async (employee: HrEmployee, active: boolean) => {
    if (!active) {
      const confirmed = window.confirm(
        `Switch off ${employee.name}'s HR access? They are signed out of the HR app on every device straight away.\n\nThis does NOT affect any telecalling account they hold — that is a separate login.`,
      );
      if (!confirmed) return;
    }

    await act(
      employee,
      () => hrApi.setActive(employee.id, active),
      active
        ? `${employee.name} can sign in to the HR app again.`
        : `${employee.name}'s HR access is switched off and their devices are signed out.`,
    );
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist" aria-label="HR account approval state">
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
                Only on Pending, and only when something is waiting. A "0" would be
                permanent furniture drawing the eye to an empty tab.
              */}
              {item.key === 'pending' && pendingCount !== null && pendingCount > 0 ? (
                <span className="tc-tab-count">{pendingCount}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-emp-search">
              Search
            </label>
            <input
              id="hr-emp-search"
              className="input"
              type="search"
              value={search}
              placeholder="Name, email or code"
              onChange={(event) => setSearch(event.target.value)}
              style={{ minWidth: '15rem' }}
            />
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>
        </div>
      </div>

      {/*
        There is no "Add employee" button, and that is not an omission.

        The HR backend has no admin-create endpoint: every HR account begins as a
        self-registration, because the flow depends on the person confirming their own
        email address. A button here would have to invent a password on their behalf and
        skip the confirmation the approval gate relies on.
      */}

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton />
      ) : !data || data.items.length === 0 ? (
        tab === 'pending' ? (
          <EmptyPanel
            title="Nobody is waiting for approval"
            message="When somebody signs up in the HR app they appear here, and cannot sign in until you approve them."
          />
        ) : tab === 'rejected' ? (
          <EmptyPanel
            title="No rejected registrations"
            message="Registrations you turn down are kept here so there is a record of the decision and the reason given."
          />
        ) : (
          <EmptyPanel
            title="No HR employees yet"
            message="Employees register themselves in the HR app. Approved accounts appear here."
          />
        )
      ) : tab === 'pending' ? (
        /* ---------------------------------------------- the signup queue */
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="62rem"
          caption="People who have signed up in the HR app and are waiting for approval"
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
              key: 'email-confirmed',
              header: 'Email',
              width: '10rem',
              nowrap: true,
              /*
                The single most useful column on this tab. An unconfirmed address cannot
                be approved, so without this the administrator clicks Approve, gets a
                refusal, and has no way to tell whether the queue is theirs to clear or
                the applicant's.
              */
              render: (employee) =>
                employee.emailVerifiedAt ? (
                  <Tag tone="good">Confirmed</Tag>
                ) : (
                  <Tag tone="bad">Not confirmed</Tag>
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
                    disabled={busyId === employee.id || employee.emailVerifiedAt === null}
                    /*
                      Disabled rather than hidden while the address is unconfirmed: a
                      missing button reads as a bug, a disabled one plus the Email column
                      beside it reads as "not yet".
                    */
                    title={
                      employee.emailVerifiedAt === null
                        ? 'They have not confirmed their email address yet'
                        : undefined
                    }
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
        /* -------------------------------------------------- turned down */
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="58rem"
          caption="Rejected HR registrations"
          columns={[
            {
              key: 'applicant',
              header: 'Applicant',
              width: '18rem',
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
                too, so on these rows it is the decision time. Labelled "Decided" for
                that reason.
              */
              render: (employee) => formatDateTime(employee.approvedAt),
            },
            {
              key: 'reason',
              header: 'Reason given',
              render: (employee) =>
                employee.rejectionReason ?? <span className="tc-muted">No reason recorded</span>,
            },
          ]}
        />
      ) : (
        /* ----------------------------------------------- approved staff */
        <DataTable
          rows={data.items}
          rowKey={(employee) => employee.id}
          rowBusy={(employee) => busyId === employee.id}
          minWidth="62rem"
          caption="HR app employees"
          columns={[
            {
              key: 'employee',
              header: 'Employee',
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
              key: 'role',
              header: 'Access level',
              width: '10rem',
              nowrap: true,
              render: (employee) => HR_ROLE_LABELS[employee.role] ?? employee.role,
            },
            {
              key: 'state',
              header: 'State',
              width: '8rem',
              nowrap: true,
              render: (employee) =>
                employee.isActive ? (
                  <Tag tone="good">Active</Tag>
                ) : (
                  <Tag tone="bad">Switched off</Tag>
                ),
            },
            {
              key: 'last-login',
              header: 'Last signed in',
              width: '11rem',
              nowrap: true,
              /*
                Their last sign-in TO THE HR APP. It does not move when they use the
                telecaller app — that is a different account with its own timestamp.
              */
              render: (employee) =>
                employee.lastLoginAt ? (
                  formatDateTime(employee.lastLoginAt)
                ) : (
                  <span className="tc-muted">Never</span>
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
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busyId === employee.id}
                    onClick={() => void setActive(employee, !employee.isActive)}
                  >
                    {employee.isActive ? 'Switch off' : 'Switch on'}
                  </button>
                </CellActions>
              ),
            },
          ]}
        />
      )}

      {data && data.items.length > 0 ? (
        <Pager
          page={data.page}
          totalPages={totalPages}
          total={data.total}
          noun={tab === 'approved' ? 'employee' : 'registration'}
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
