'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { AREAS } from '@/components/admin/AdminNav';
import { useAdminSession } from '@/components/admin/useAdminSession';
import { FormAlert } from '@/components/forms/Fields';
import { HrEmployeesPanel } from './HrEmployeesPanel';

/**
 * The HR admin application.
 *
 * One section today — the employee list and the approval queue — so this shell is
 * thinner than `TelecallingApp` and deliberately does not carry its `useSection`
 * machinery. Pushing a `?section=` parameter into history to address the only section
 * there is would be ceremony with no behaviour behind it.
 *
 * The shell, sidebar and session gate are shared with the other two admin areas rather
 * than duplicated. That sharing is the point: an administrator signs in once and can see
 * that all three areas exist.
 *
 * When a second HR section lands, lift `useSection` out of `TelecallingApp` into a shared
 * hook rather than copying it here.
 */

const HR = AREAS.find((group) => group.area === 'hr');

if (!HR) {
  throw new Error('AdminNav has no hr area — the sidebar and this shell disagree.');
}

export function HrApp() {
  const { status, email, configError, handleUnauthorized, signOut } = useAdminSession();

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

  return (
    <AdminShell
      area="hr"
      activeKey="people"
      /*
        Within this area there is nowhere else to go, so navigation is a no-op. Moving to
        another AREA is a `next/link` inside AdminNav and does not come through here.
      */
      onNavigate={() => {}}
      title="HR employees"
      email={email}
      onSignOut={() => void signOut()}
    >
      <HrEmployeesPanel onUnauthorized={handleUnauthorized} />
    </AdminShell>
  );
}
