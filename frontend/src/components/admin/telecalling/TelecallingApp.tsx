'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { AdminSessionLoader } from '@/components/admin/Loader';
import { useAdminSession } from '@/components/admin/useAdminSession';
import { FormAlert } from '@/components/forms/Fields';
import { CallsPanel } from './CallsPanel';
import { DashboardPanel } from './DashboardPanel';
import { EmployeesPanel } from './EmployeesPanel';
import { FollowUpsPanel } from './FollowUpsPanel';
import { LeadView } from './LeadView';
import { LeadsPanel } from './LeadsPanel';
import { TelecallingNavProvider, useTelecallingRouter } from './nav';
import { ReportsPanel } from './ReportsPanel';
import { SettingsPanel } from './SettingsPanel';
import { isSection } from './urlState';

/**
 * The telecalling admin application.
 *
 * One route with internal sections rather than seven routes. Under a static export each
 * route is a separate HTML document, so seven routes would mean seven full page loads,
 * seven session checks, and the sign-in gate re-evaluated on every navigation between
 * them. Sections share one authenticated shell and one session.
 *
 * The trade is that the router is ours. The section, an open lead and each panel's
 * filters live in the query string (urlState.ts), and moving between them pushes history
 * entries (nav.tsx), so a refresh, a shared link and the Back button all reproduce what
 * was on screen — without Next's router, which would treat each move as a navigation.
 *
 * The shell, the sidebar and the session gate are shared with the website records admin
 * (`AdminApp`) rather than duplicated here. That sharing is the point: the two used to
 * be mutually invisible, and anyone who landed on the enquiries screen had no way to
 * discover that any of this existed.
 */
export function TelecallingApp() {
  const { status, email, configError, handleUnauthorized, signOut } = useAdminSession();
  const nav = useTelecallingRouter();

  if (status === 'checking') {
    return <AdminSessionLoader />;
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

  const { section, navKey, leadId } = nav;

  return (
    <AdminShell
      area="telecalling"
      activeKey={section}
      onNavigate={(key) => {
        // A sidebar click always opens the section fresh — clicking the section already
        // on screen is how its filters are cleared — and closes any open lead.
        if (isSection(key)) nav.go(key);
      }}
      title={leadId !== null ? 'Lead details' : nav.sectionLabel}
      email={email}
      onSignOut={() => void signOut()}
    >
      <TelecallingNavProvider value={nav}>
        {leadId !== null ? <LeadView key={leadId} onUnauthorized={handleUnauthorized} /> : null}

        {/*
          The section's panel, mounted only while its section is showing, so leaving a
          section aborts its requests and returning refetches. Keeping all seven mounted
          would hold seven sets of stale data and refresh all of them at once.

          The one exception is an open lead: the panel it was opened from stays mounted
          underneath, hidden, which is what lets Back return to the list exactly as it was
          left. `navKey` remounts the panel whenever it has to start over — a section
          change, or a Back or Forward to different filters. The panel is not mounted at
          all while a lead the page was opened on is showing; it mounts when that closes.
        */}
        <div hidden={leadId !== null}>
          {nav.originReady ? (
            <>
              {section === 'dashboard' ? (
                <DashboardPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'leads' ? (
                <LeadsPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'followups' ? (
                <FollowUpsPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'calls' ? (
                <CallsPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'employees' ? (
                <EmployeesPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'reports' ? (
                <ReportsPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
              {section === 'settings' ? (
                <SettingsPanel key={navKey} onUnauthorized={handleUnauthorized} />
              ) : null}
            </>
          ) : null}
        </div>
      </TelecallingNavProvider>
    </AdminShell>
  );
}
