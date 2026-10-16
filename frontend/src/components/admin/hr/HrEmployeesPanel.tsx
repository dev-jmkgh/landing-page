'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/telecalling';
import {
  hrApi,
  pageCount,
  type HrEmployee,
  type HrPaginated,
} from '@/lib/hr';
import { EmptyPanel, Pager, Tag, TableSkeleton } from '../telecalling/shared';
import { AddEmployeeDialog } from './people/AddEmployeeDialog';
import { EmployeeDetail } from './people/EmployeeDetail';
import { EmployeeDirectory } from './people/EmployeeDirectory';
import { isAbort } from './people/shared';
import { useOrgLists } from './people/useOrgLists';

/**
 * HR employees: the directory, one employee's full record, and the queue of people
 * waiting to be let in.
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
 * THE THREE TABS
 * --------------
 * Employees is the directory (`GET /employees`), alphabetical and filterable. Pending
 * approval and Rejected are the signup queue (`GET /registrations`), ordered by who has
 * waited longest — the order that queue is worked in. Opening anybody, from any tab,
 * shows their record in place of the list; the list stays mounted behind it so Back
 * returns to the same page and filters.
 *
 * Employees can now also be ADDED here: the backend gained an admin-create endpoint, so an
 * administrator can vouch for somebody directly instead of waiting for them to sign up.
 */

const PAGE_SIZE = 25;

type Tab = 'directory' | 'pending' | 'rejected';

const TABS: { key: Tab; label: string }[] = [
  { key: 'directory', label: 'Employees' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'rejected', label: 'Rejected' },
];

export function HrEmployeesPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const org = useOrgLists(onUnauthorized);

  const [tab, setTab] = useState<Tab>('directory');
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The employee whose record is open, if any. The list stays mounted underneath. */
  const [opened, setOpened] = useState<HrEmployee | null>(null);
  /** Bumped when an employee changed elsewhere, so the list behind re-reads its page. */
  const [reloadToken, setReloadToken] = useState(0);

  /** Whatever opened the record, to hand focus back to on Back. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const tabList = useRef<HTMLDivElement | null>(null);

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

  const open = useCallback((employee: HrEmployee) => {
    // The name button that was pressed. A row double-click leaves focus on the page
    // itself, and "returning" there would drop a keyboard user at the top.
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setNotice(null);
    setOpened(employee);
  }, []);

  const back = () => {
    setOpened(null);
    window.setTimeout(() => {
      const target = returnFocus.current;
      // The row may have left the page while the record was open; fall back to the tabs.
      if (target && target.isConnected) target.focus();
      else tabList.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }, 0);
  };

  const changed = useCallback(() => {
    setReloadToken((value) => value + 1);
    void refreshPendingCount();
  }, [refreshPendingCount]);

  return (
    <>
      {/*
        `hidden`, not unmounted: the list keeps its page, filters and scroll while a
        record is open, and Back returns to exactly where the administrator was.
      */}
      <div hidden={opened !== null}>
        <div className="admin-toolbar hrp-tabbar">
          <div className="admin-tabs" role="tablist" aria-label="HR employees" ref={tabList}>
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                className="admin-tab"
                aria-selected={tab === item.key}
                onClick={() => {
                  if (item.key === tab) return;
                  setNotice(null);
                  setTab(item.key);
                }}
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

          {tab === 'directory' ? (
            <div className="admin-filters">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setNotice(null);
                  setAdding(true);
                }}
              >
                <Icon name="users" size={16} />
                Add employee
              </button>
            </div>
          ) : null}
        </div>

        {org.error ? <FormAlert variant="info">{org.error}</FormAlert> : null}
        {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

        {tab === 'directory' ? (
          <EmployeeDirectory
            departments={org.departments}
            designations={org.designations}
            reloadToken={reloadToken}
            onOpen={open}
            onAdd={() => setAdding(true)}
            onNotice={setNotice}
            onUnauthorized={onUnauthorized}
          />
        ) : (
          <RegistrationQueue
            // Keyed so switching between Pending and Rejected starts on page one.
            key={tab}
            approval={tab}
            reloadToken={reloadToken}
            onOpen={open}
            onNotice={setNotice}
            onDecided={changed}
            onUnauthorized={onUnauthorized}
          />
        )}
      </div>

      {opened ? (
        <EmployeeDetail
          key={opened.id}
          initial={opened}
          departments={org.departments}
          designations={org.designations}
          onBack={back}
          onChanged={changed}
          onUnauthorized={onUnauthorized}
        />
      ) : null}

      {adding ? (
        <AddEmployeeDialog
          departments={org.departments}
          designations={org.designations}
          onClose={() => setAdding(false)}
          onCreated={(employee) => {
            setAdding(false);
            setTab('directory');
            setNotice(
              `${employee.name} added (${employee.employeeCode}). They can sign in to the HR app now with the password you set — give it to them directly; it cannot be retrieved later.`,
            );
            changed();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The signup queue                                                            */
/* -------------------------------------------------------------------------- */

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

function RegistrationQueue({
  approval,
  reloadToken,
  onOpen,
  onNotice,
  onDecided,
  onUnauthorized,
}: {
  approval: 'pending' | 'rejected';
  reloadToken: number;
  onOpen: (employee: HrEmployee) => void;
  onNotice: (message: string | null) => void;
  onDecided: () => void;
  onUnauthorized: () => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  const [data, setData] = useState<HrPaginated<HrEmployee> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

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
      const result = await hrApi.listEmployees(
        { page, pageSize: PAGE_SIZE, approval, q: debounced || undefined },
        controller.signal,
      );
      // A page past the end — its last applicant was just decided — steps back one.
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
      setError(caught instanceof ApiError ? caught.message : 'Could not load registrations.');
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [page, approval, debounced, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => () => abort.current?.abort(), []);

  /**
   * Runs one decision and reloads.
   *
   * Reloads rather than patching the row in place: the row leaves the tab it was acted
   * on from, and the server refuses a second decision with a 400, which is only
   * recoverable by re-reading. Two administrators working the queue together is exactly
   * when this screen is busiest.
   */
  const act = async (employee: HrEmployee, action: () => Promise<HrEmployee>, success: string) => {
    setBusyId(employee.id);
    setError(null);
    onNotice(null);

    try {
      await action();
      onNotice(success);
      onDecided();
      await load();
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
      await load();
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

  const nameButton = (employee: HrEmployee) => (
    <button type="button" className="tc-link-button hrp-name-link" onClick={() => onOpen(employee)}>
      {employee.name}
    </button>
  );

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor={`hr-queue-search-${approval}`}>
              Search
            </label>
            <input
              id={`hr-queue-search-${approval}`}
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

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      {data === null ? (
        loading ? (
          <TableSkeleton />
        ) : null
      ) : (
        <LoadingOverlay busy={loading}>
          {data.items.length === 0 ? (
            debounced ? (
              <EmptyPanel
                title="Nobody matches that search"
                message="Try another name, email or code."
                actionLabel="Clear search"
                onAction={() => {
                  setSearch('');
                  setDebounced('');
                  setPage(1);
                }}
              />
            ) : approval === 'pending' ? (
              <EmptyPanel
                title="Nobody is waiting for approval"
                message="When somebody signs up in the HR app they appear here, and cannot sign in until you approve them."
              />
            ) : (
              <EmptyPanel
                title="No rejected registrations"
                message="Registrations you turn down are kept here so there is a record of the decision and the reason given."
              />
            )
          ) : approval === 'pending' ? (
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
                    <CellStack primary={nameButton(employee)} secondary={employee.email}>
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
                    The single most useful column on this tab. An unconfirmed address
                    cannot be approved, so without this the administrator clicks Approve,
                    gets a refusal, and has no way to tell whether the queue is theirs to
                    clear or the applicant's.
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
                          missing button reads as a bug, a disabled one plus the Email
                          column beside it reads as "not yet".
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
          ) : (
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
                    <CellStack primary={nameButton(employee)} secondary={employee.email}>
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
                    `approvedAt` despite the name: the server writes that column on
                    rejection too, so on these rows it is the decision time. Labelled
                    "Decided" for that reason.
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
          )}
        </LoadingOverlay>
      )}

      {data && data.total > 0 ? (
        <Pager
          page={data.page}
          totalPages={pageCount(data)}
          total={data.total}
          noun="registration"
          busy={loading}
          onChange={setPage}
        />
      ) : null}
    </>
  );
}
