'use client';

import { useCallback, useEffect, useState } from 'react';
import { AREAS } from '@/components/admin/AdminNav';
import { AdminShell } from '@/components/admin/AdminShell';
import { useAdminSession } from '@/components/admin/useAdminSession';
import { FormAlert } from '@/components/forms/Fields';
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
 * One route with internal sections rather than seven routes. Under a static export each
 * route is a separate HTML document, so seven routes would mean seven full page loads,
 * seven session checks, and the sign-in gate re-evaluated on every navigation between
 * them. Sections share one authenticated shell and one session.
 *
 * The trade is that a section is not separately bookmarkable. It is recovered from
 * `?section=` on load and pushed into the history on change, so a link to a section and
 * the browser Back button both work — see `useSection`.
 *
 * The shell, the sidebar and the session gate are shared with the website records admin
 * (`AdminApp`) rather than duplicated here. That sharing is the point: the two used to
 * be mutually invisible, and anyone who landed on the enquiries screen had no way to
 * discover that any of this existed.
 */

/*
 * The section list lives in `AdminNav`, which renders the sidebar for both admin areas.
 * Declaring it twice would let the sidebar and the panel switch disagree, and the
 * sidebar is the half that has to match reality.
 */
const TELECALLING = AREAS.find((group) => group.area === 'telecalling');

if (!TELECALLING) {
  throw new Error('AdminNav has no telecalling area — the sidebar and this shell disagree.');
}

const SECTIONS = TELECALLING.items;

type Section =
  | 'dashboard'
  | 'leads'
  | 'followups'
  | 'calls'
  | 'employees'
  | 'reports'
  | 'settings';

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
  const { status, email, configError, handleUnauthorized, signOut } = useAdminSession();
  const [section, setSection] = useSection();

  if (status === 'checking') {
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

  if (status === 'unavailable') {
    return (
      <div className="admin-login">
        <div className="admin-login__card">
          <p className="eyebrow">JMK Global Holdings</p>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>Admin unavailable</h1>
          <div style={{ marginTop: '1.25rem' }}>
            <FormAlert variant="error">{configError}</FormAlert>
          </div>
        </div>
      </div>
    );
  }

  // 'signedOut' — a redirect to /admin/login/ is already in flight, so render nothing
  // rather than flashing an empty dashboard on the way out.
  if (status !== 'signedIn') return null;

  const label = SECTIONS.find((item) => item.key === section)?.label ?? 'Telecalling';

  return (
    <AdminShell
      area="telecalling"
      activeKey={section}
      onNavigate={(key) => {
        if (isSection(key)) setSection(key);
      }}
      title={label}
      email={email}
      onSignOut={() => void signOut()}
    >
      {/*
        Each panel is mounted only while visible and unmounts on switch, so its in-flight
        requests are aborted and it refetches on return. Keeping all seven mounted would
        hold seven sets of stale data and fire seven refreshes whenever the window
        regained focus.
      */}
      {section === 'dashboard' ? <DashboardPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'leads' ? <LeadsPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'followups' ? <FollowUpsPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'calls' ? <CallsPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'employees' ? <EmployeesPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'reports' ? <ReportsPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'settings' ? <SettingsPanel onUnauthorized={handleUnauthorized} /> : null}
    </AdminShell>
  );
}
