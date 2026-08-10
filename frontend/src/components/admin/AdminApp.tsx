'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminLogin } from '@/components/admin/AdminLogin';
import { ApplicationsTable, EnquiriesTable } from '@/components/admin/RecordsTable';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  ApiError,
  adminApi,
  type AdminApplication,
  type AdminEnquiry,
  type ApplicationStatus,
  type EnquiryStatus,
  type RecordStatus,
  type Paginated,
} from '@/lib/api';
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  ENQUIRY_STATUSES,
  ENQUIRY_STATUS_LABELS,
} from '@/lib/constants';

type Tab = 'enquiries' | 'applications';
type StatusFilter = RecordStatus | 'all';

const PAGE_SIZE = 20;
const EMPTY_PAGE = { items: [], page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1 };

export function AdminApp() {
  const [session, setSession] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const [tab, setTab] = useState<Tab>('enquiries');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [enquiries, setEnquiries] = useState<Paginated<AdminEnquiry>>(EMPTY_PAGE);
  const [applications, setApplications] = useState<Paginated<AdminApplication>>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  /* ---------------------------------------------------------------- session */

  useEffect(() => {
    let cancelled = false;
    adminApi
      .session()
      .then((value) => {
        if (!cancelled) setSession(value.email);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* --------------------------------------------------------------- filtering */

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [tab, status, debouncedSearch]);

  const load = useCallback(async () => {
    if (!session) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const query = { status, q: debouncedSearch || undefined, page, pageSize: PAGE_SIZE };

    try {
      if (tab === 'enquiries') {
        setEnquiries(await adminApi.listEnquiries(query, controller.signal));
      } else {
        setApplications(await adminApi.listApplications(query, controller.signal));
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not load records.');
    } finally {
      setLoading(false);
    }
  }, [session, tab, status, debouncedSearch, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* ------------------------------------------------------------------ actions */

  /**
   * Each table offers only its own statuses, but the handler is shared, so the value is
   * checked against the active tab's vocabulary before it reaches the typed API call.
   */
  async function changeStatus(id: number, next: RecordStatus) {
    setBusyId(id);
    setError(null);
    try {
      if (tab === 'enquiries') {
        if (!ENQUIRY_STATUSES.includes(next as EnquiryStatus)) return;
        const updated = await adminApi.updateEnquiryStatus(id, next as EnquiryStatus);
        setEnquiries((current) => ({
          ...current,
          items: current.items.map((item) => (item.id === id ? updated : item)),
        }));
      } else {
        if (!APPLICATION_STATUSES.includes(next as ApplicationStatus)) return;
        const updated = await adminApi.updateApplicationStatus(id, next as ApplicationStatus);
        setApplications((current) => ({
          ...current,
          items: current.items.map((item) => (item.id === id ? updated : item)),
        }));
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not update the status.');
    } finally {
      setBusyId(null);
    }
  }

  async function signOut() {
    try {
      await adminApi.logout();
    } finally {
      setSession(null);
      setEnquiries(EMPTY_PAGE);
      setApplications(EMPTY_PAGE);
    }
  }

  /* -------------------------------------------------------------------- views */

  if (checking) {
    return (
      <div className="admin-login">
        <div className="admin-login__card" aria-busy="true">
          <div className="skeleton" style={{ height: '1.5rem', width: '60%' }} />
          <div className="skeleton" style={{ height: '1rem', width: '85%', marginTop: '1rem' }} />
          <div className="skeleton" style={{ height: '2.75rem', marginTop: '1.5rem' }} />
        </div>
      </div>
    );
  }

  if (!session) return <AdminLogin onSuccess={setSession} />;

  const current = tab === 'enquiries' ? enquiries : applications;
  const isEmpty = !loading && current.items.length === 0;

  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div className="container admin-bar__inner">
          <div>
            <p className="eyebrow" style={{ marginBottom: '0.25rem' }}>
              JMK Global Holdings
            </p>
            <h1 style={{ color: '#fff', fontSize: 'var(--text-2xl)' }}>Enquiry management</h1>
          </div>
          <div className="admin-bar__user">
            <span>{session}</span>
            <button type="button" className="btn btn--ghost-light btn--sm" onClick={signOut}>
              <Icon name="logout" size={16} />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="container section section--tight" style={{ flex: 1 }}>
        <div className="admin-toolbar">
          <div className="admin-tabs" role="tablist" aria-label="Record type">
            <button
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === 'enquiries'}
              onClick={() => setTab('enquiries')}
            >
              Enquiries
            </button>
            <button
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === 'applications'}
              onClick={() => setTab('applications')}
            >
              Applications
            </button>
          </div>

          <div className="admin-filters">
            <div className="field">
              <label className="field__label" htmlFor="admin-search">
                Search
              </label>
              <input
                id="admin-search"
                className="input"
                type="search"
                value={search}
                placeholder="Name, email, phone or reference"
                onChange={(event) => setSearch(event.target.value)}
                style={{ minWidth: '16rem' }}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="admin-status">
                Status
              </label>
              <select
                id="admin-status"
                className="select"
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              >
                <option value="all">All statuses</option>
                {(tab === 'enquiries' ? ENQUIRY_STATUSES : APPLICATION_STATUSES).map((value) => (
                  <option key={value} value={value}>
                    {tab === 'enquiries'
                      ? ENQUIRY_STATUS_LABELS[value as EnquiryStatus]
                      : APPLICATION_STATUS_LABELS[value as ApplicationStatus]}
                  </option>
                ))}
              </select>
            </div>

            <button type="button" className="btn btn--outline" onClick={() => void load()}>
              <Icon name="refresh" size={16} />
              Refresh
            </button>
          </div>
        </div>

        {error ? <FormAlert variant="error">{error}</FormAlert> : null}

        {loading ? (
          <div className="table-wrap" style={{ padding: '1rem' }} aria-busy="true">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="skeleton" style={{ height: '3rem', marginBottom: '0.6rem' }} />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="table-wrap">
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                <Icon name="inbox" size={24} />
              </span>
              <p style={{ fontWeight: 600, color: 'var(--ink-700)' }}>Nothing to show</p>
              <p>No {tab} match the current filters.</p>
            </div>
          </div>
        ) : tab === 'enquiries' ? (
          <EnquiriesTable rows={enquiries.items} busyId={busyId} onStatusChange={changeStatus} />
        ) : (
          <ApplicationsTable
            rows={applications.items}
            busyId={busyId}
            onStatusChange={changeStatus}
            resumeUrl={adminApi.resumeUrl}
          />
        )}

        <div className="pagination">
          <span>
            {current.total} record{current.total === 1 ? '' : 's'} · page {current.page} of{' '}
            {current.totalPages}
          </span>
          <div className="pagination__controls">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={current.page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <Icon name="arrowLeft" size={15} />
              Previous
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={current.page >= current.totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
              <Icon name="arrowRight" size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
