'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminLogin } from '@/components/admin/AdminLogin';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError, adminApi } from '@/lib/api';
import { CallsPanel } from './CallsPanel';
import { DashboardPanel } from './DashboardPanel';
import { EmployeesPanel } from './EmployeesPanel';
import { FollowUpsPanel } from './FollowUpsPanel';
import { LeadsPanel } from './LeadsPanel';
import { ReportsPanel } from './ReportsPanel';
import { SettingsPanel } from './SettingsPanel';

/**
 * The telecalling admin application.
 *
 * One route with internal sections rather than seven routes, matching the existing
 * `AdminApp`. Under a static export each route is a separate HTML document, so seven
 * routes would mean seven full page loads, seven session checks, and the sign-in gate
 * re-evaluated on every navigation between them. Sections share one authenticated shell
 * and one session.
 *
 * The trade is that a section is not separately bookmarkable. It is recovered from
 * `?section=` on load and pushed into the history on change, so a link to a section and
 * the browser Back button both work — see `useSection`.
 */

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'leads', label: 'Leads' },
  { key: 'followups', label: 'Follow-ups' },
  { key: 'calls', label: 'Calls' },
  { key: 'employees', label: 'Employees' },
  { key: 'reports', label: 'Reports' },
  { key: 'settings', label: 'Settings' },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

function isSection(value: string | null): value is Section {
  return value !== null && SECTIONS.some((section) => section.key === value);
}

/**
 * Keeps the visible section in the URL.
 *
 * There is no router to lean on here: the page is a static document and Next's router
 * would trigger a navigation. `history.pushState` plus a `popstate` listener gives
 * shareable links and a working Back button without one.
 */
function useSection(): [Section, (next: Section) => void] {
  const [section, setSection] = useState<Section>('dashboard');

  // Read once on mount rather than during render — `window` does not exist while the
  // page is being prerendered at build time.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('section');
    if (isSection(initial)) setSection(initial);

    const onPop = () => {
      const value = new URLSearchParams(window.location.search).get('section');
      setSection(isSection(value) ? value : 'dashboard');
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next: Section) => {
    setSection(next);

    const url = new URL(window.location.href);
    url.searchParams.set('section', next);
    window.history.pushState({ section: next }, '', url);
  }, []);

  return [section, go];
}

export function TelecallingApp() {
  const [session, setSession] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [section, setSection] = useSection();

  useEffect(() => {
    let cancelled = false;

    adminApi
      .session()
      .then((value) => {
        if (!cancelled) setSession(value.email);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setSession(null);
        // A configuration problem is worth naming: on a frontend-only deploy the API is
        // simply absent, and "incorrect password" would be a misleading thing to show.
        if (caught instanceof ApiError && caught.code === 'api_not_configured') {
          setNotice(caught.message);
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Passed to every panel so a 401 mid-session returns to the sign-in screen once.
   *
   * Centralised here rather than handled per panel: several panels fetch in parallel,
   * and each one calling its own sign-out would race.
   */
  const handleUnauthorized = useCallback(() => {
    setSession(null);
    setNotice('Your session ended. Please sign in again.');
  }, []);

  const signOut = async () => {
    try {
      await adminApi.logout();
    } finally {
      setSession(null);
      setNotice(null);
    }
  };

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

  if (!session) {
    return (
      <>
        {notice ? (
          <div className="container" style={{ paddingTop: '1.5rem' }}>
            <FormAlert variant="error">{notice}</FormAlert>
          </div>
        ) : null}
        <AdminLogin onSuccess={setSession} />
      </>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div className="container admin-bar__inner">
          <div>
            <p className="eyebrow" style={{ marginBottom: '0.25rem' }}>
              JMK Global Holdings
            </p>
            <h1 style={{ color: '#fff', fontSize: 'var(--text-2xl)' }}>Telecalling</h1>
          </div>
          <div className="admin-bar__user">
            <a className="btn btn--ghost-light btn--sm" href="/admin/enquiries/">
              <Icon name="inbox" size={16} />
              Enquiries
            </a>
            <span>{session}</span>
            <button type="button" className="btn btn--ghost-light btn--sm" onClick={() => void signOut()}>
              <Icon name="logout" size={16} />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <nav className="tc-nav" aria-label="Telecalling sections">
        <div className="container tc-nav__inner">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="tc-nav__link"
              aria-current={section === item.key ? 'page' : undefined}
              onClick={() => setSection(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="container section section--tight" style={{ flex: 1 }}>
        {/*
          Each panel is mounted only while visible and unmounts on switch, so its
          in-flight requests are aborted and it refetches on return. Keeping all seven
          mounted would hold seven sets of stale data and fire seven refreshes whenever
          the window regained focus.
        */}
        {section === 'dashboard' ? <DashboardPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'leads' ? <LeadsPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'followups' ? <FollowUpsPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'calls' ? <CallsPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'employees' ? <EmployeesPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'reports' ? <ReportsPanel onUnauthorized={handleUnauthorized} /> : null}
        {section === 'settings' ? <SettingsPanel onUnauthorized={handleUnauthorized} /> : null}
      </div>
    </div>
  );
}
