'use client';

import { useCallback, useEffect, useState } from 'react';
import { AREAS } from '@/components/admin/AdminNav';
import { AdminShell } from '@/components/admin/AdminShell';
import { useAdminSession } from '@/components/admin/useAdminSession';
import { FormAlert } from '@/components/forms/Fields';
import { HrAttendancePanel } from './HrAttendancePanel';
import { HrCorrectionsPanel } from './HrCorrectionsPanel';
import { HrEmployeesPanel } from './HrEmployeesPanel';
import { HrWorkplacesPanel } from './HrWorkplacesPanel';

/**
 * The HR admin application.
 *
 * One route with internal sections, matching `TelecallingApp` and for the same reason:
 * under a static export each route is a separate document, so four routes would mean
 * four full page loads and four session checks to move between them.
 *
 * The section list lives in `AdminNav`, which renders the sidebar for every admin area.
 * Declaring it twice would let the sidebar and the panel switch disagree, and the
 * sidebar is the half that has to match reality.
 */

const HR = AREAS.find((group) => group.area === 'hr');

if (!HR) {
  throw new Error('AdminNav has no hr area — the sidebar and this shell disagree.');
}

const SECTIONS = HR.items;

type Section = 'people' | 'attendance' | 'corrections' | 'workplaces';

function isSection(value: string | null): value is Section {
  return value !== null && SECTIONS.some((section) => section.key === value);
}

/**
 * Keeps the visible section in the URL.
 *
 * There is no router to lean on: the page is a static document and Next's router would
 * trigger a navigation. `history.pushState` plus a `popstate` listener gives shareable
 * links and a working Back button without one.
 */
function useSection(): [Section, (next: Section) => void] {
  const [section, setSection] = useState<Section>('people');

  // Read on mount rather than during render — `window` does not exist while the page
  // is prerendered at build time.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('section');
    if (isSection(initial)) setSection(initial);

    const onPop = () => {
      const value = new URLSearchParams(window.location.search).get('section');
      setSection(isSection(value) ? value : 'people');
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

export function HrApp() {
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
  // rather than flashing an empty screen on the way out.
  if (status !== 'signedIn') return null;

  const label = SECTIONS.find((item) => item.key === section)?.label ?? 'HR';

  return (
    <AdminShell
      area="hr"
      activeKey={section}
      onNavigate={(key) => {
        if (isSection(key)) setSection(key);
      }}
      title={label}
      email={email}
      onSignOut={() => void signOut()}
    >
      {/*
        Each panel is mounted only while visible and unmounts on switch, so its
        in-flight requests are aborted and it refetches on return.
      */}
      {section === 'people' ? <HrEmployeesPanel onUnauthorized={handleUnauthorized} /> : null}
      {section === 'attendance' ? (
        <HrAttendancePanel onUnauthorized={handleUnauthorized} />
      ) : null}
      {section === 'corrections' ? (
        <HrCorrectionsPanel onUnauthorized={handleUnauthorized} />
      ) : null}
      {section === 'workplaces' ? (
        <HrWorkplacesPanel onUnauthorized={handleUnauthorized} />
      ) : null}
    </AdminShell>
  );
}
