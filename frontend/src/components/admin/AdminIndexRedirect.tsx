'use client';

import { useEffect } from 'react';
import { adminApi } from '@/lib/api';
import { BASE_PATH } from '@/lib/paths';
import { AdminSessionLoader } from '@/components/admin/Loader';
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

  return <AdminSessionLoader message="Opening the admin area…" />;
}
