'use client';

import { useEffect } from 'react';
import { adminApi } from '@/lib/api';
import { BASE_PATH } from '@/lib/paths';
import { loginUrl } from '@/components/admin/useAdminSession';

/**
 * Sends `/admin/` somewhere useful.
 *
 * A client-side redirect rather than a config rewrite, because the site is exported as
 * static HTML and served by Apache — there is no Node runtime to evaluate `redirects()`.
 *
 * The session is checked first so the destination is right on the first hop: sending
 * everyone to the dashboard and letting it bounce unauthenticated visitors back to the
 * login page would flash two page loads to get to a password field.
 */
export function AdminIndexRedirect() {
  useEffect(() => {
    let cancelled = false;

    adminApi
      .session()
      .then(() => {
        if (!cancelled) window.location.replace(`${BASE_PATH}/admin/telecalling/`);
      })
      .catch(() => {
        if (!cancelled) window.location.replace(loginUrl());
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="admin-login">
      <div className="admin-login__card" aria-busy="true">
        <p className="eyebrow">JMK Global Holdings</p>
        <p style={{ color: 'var(--ink-500)', marginTop: '0.5rem' }}>Opening the admin area…</p>
        <div className="skeleton" style={{ height: '2.75rem', marginTop: '1.5rem' }} />
      </div>
    </div>
  );
}
