'use client';

import { useEffect, useState } from 'react';
import { AdminLogin } from '@/components/admin/AdminLogin';
import { FormAlert } from '@/components/forms/Fields';
import { adminApi } from '@/lib/api';
import { BASE_PATH } from '@/lib/paths';

/**
 * The sign-in page's behaviour, separated from its route so the route file stays a
 * server component and keeps its `metadata` export.
 *
 * Two things happen here that the bare `<AdminLogin>` form does not do:
 *
 *  1. An already-signed-in visitor is sent onwards instead of being asked to sign in
 *     again. Bookmarking the login page is the natural thing to do once it has its own
 *     URL, and being made to re-enter a password on every visit to that bookmark would
 *     be a step backwards from the inline form it replaces.
 *  2. `?next=` is honoured, so being bounced here from a deep link returns you to it.
 */

const DEFAULT_DESTINATION = '/admin/telecalling/';

/**
 * Resolves where to go after signing in.
 *
 * `next` arrives in the query string, so it is attacker-controllable in a link. Anything
 * that is not a path on this origin beginning `/admin/` is discarded: without that check
 * a crafted `/admin/login/?next=https://phish.example` would send someone who has just
 * typed their administrator password to another site, and the redirect would look like
 * part of a legitimate sign-in.
 */
function safeDestination(raw: string | null): string {
  if (!raw) return DEFAULT_DESTINATION;

  // A protocol-relative URL ("//evil.example") is same-origin to `new URL` but not to a
  // browser following the link, so it is rejected before parsing.
  if (raw.startsWith('//')) return DEFAULT_DESTINATION;

  let target: URL;
  try {
    target = new URL(raw, window.location.origin);
  } catch {
    return DEFAULT_DESTINATION;
  }

  if (target.origin !== window.location.origin) return DEFAULT_DESTINATION;

  const withoutBase = BASE_PATH && target.pathname.startsWith(BASE_PATH)
    ? target.pathname.slice(BASE_PATH.length)
    : target.pathname;

  if (!withoutBase.startsWith('/admin/')) return DEFAULT_DESTINATION;
  if (withoutBase.startsWith('/admin/login')) return DEFAULT_DESTINATION;

  return `${withoutBase}${target.search}`;
}

export function AdminLoginScreen() {
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('reason') === 'expired') {
      setNotice('Your session ended. Please sign in again.');
    }

    let cancelled = false;

    // Skip the form entirely if the cookie is still good.
    adminApi
      .session()
      .then(() => {
        if (cancelled) return;
        window.location.replace(
          `${BASE_PATH}${safeDestination(params.get('next'))}`,
        );
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <>
      {notice ? (
        <div className="admin-login__notice">
          <FormAlert variant="error">{notice}</FormAlert>
        </div>
      ) : null}

      <AdminLogin
        onSuccess={() => {
          const next = new URLSearchParams(window.location.search).get('next');
          window.location.replace(`${BASE_PATH}${safeDestination(next)}`);
        }}
      />
    </>
  );
}
