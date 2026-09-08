'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminApi } from '@/lib/api';
import { BASE_PATH } from '@/lib/paths';

/**
 * The admin session, and the redirect to the sign-in page when there isn't one.
 *
 * Both admin applications previously carried their own copy of this: a `session` state,
 * a `checking` flag, a `useEffect` calling `adminApi.session()`, and an inline
 * `<AdminLogin>` rendered in place when the check failed. Two copies meant two slightly
 * different behaviours — only one of them showed a "your session ended" notice — and it
 * meant the sign-in form appeared at whatever admin URL you happened to be on, so there
 * was no single address to bookmark or to send to a new member of staff.
 *
 * Sign-in now lives at `/admin/login/` and this hook sends unauthenticated visitors
 * there, carrying where they were trying to go.
 */

export const ADMIN_LOGIN_PATH = '/admin/login/';

/**
 * `signedOut` is not a state any screen renders.
 *
 * By the time it is set, a redirect has already been issued. It exists so a caller can
 * render nothing at all rather than flashing a panel of empty tables in the moment
 * before the browser leaves the page.
 *
 * `unavailable` is the exception that must not redirect — see `configError` below.
 */
export type AdminSessionStatus = 'checking' | 'signedIn' | 'signedOut' | 'unavailable';

type AdminSession = {
  status: AdminSessionStatus;
  email: string | null;
  /**
   * Set when the API is not configured at all, rather than when the visitor is simply
   * not signed in.
   *
   * On a frontend-only deployment there is no API to talk to, and every session check
   * fails for a reason that has nothing to do with credentials. Redirecting to the login
   * page there would be a loop — the login page checks the session too — and offering a
   * password field would blame the user for a deployment problem. So this case stops and
   * states what is wrong.
   */
  configError: string | null;
  /** Call when a request returns 401 mid-session. Sends the user to sign in again. */
  handleUnauthorized: () => void;
  signOut: () => Promise<void>;
};

/**
 * Builds a sign-in URL that remembers the current page.
 *
 * `next` is deliberately reduced to a path before being put in the query string. Taking
 * the caller's full URL would let `/admin/login/?next=https://elsewhere.example` turn
 * this into an open redirect, and the login page trusts this parameter enough to
 * navigate to it.
 */
export function loginUrl(options: { next?: string; reason?: 'expired' } = {}): string {
  const url = new URL(`${BASE_PATH}${ADMIN_LOGIN_PATH}`, window.location.origin);

  if (options.next) {
    const target = new URL(options.next, window.location.origin);
    url.searchParams.set('next', `${target.pathname}${target.search}`);
  }

  if (options.reason) url.searchParams.set('reason', options.reason);

  return url.toString();
}

export function useAdminSession(): AdminSession {
  const [status, setStatus] = useState<AdminSessionStatus>('checking');
  const [email, setEmail] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    adminApi
      .session()
      .then((value) => {
        if (cancelled) return;
        setEmail(value.email);
        setStatus('signedIn');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;

        if (caught instanceof ApiError && caught.code === 'api_not_configured') {
          setConfigError(caught.message);
          setStatus('unavailable');
          return;
        }

        /*
         * `replace`, not `assign`: the page we are leaving is one the visitor cannot
         * see, so leaving it in the history only means Back lands them here and bounces
         * them out again.
         */
        setStatus('signedOut');
        window.location.replace(loginUrl({ next: window.location.href }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnauthorized = useCallback(() => {
    setStatus('signedOut');
    window.location.replace(loginUrl({ next: window.location.href, reason: 'expired' }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      /*
       * Cleared regardless of whether the API call succeeded. A sign-out that can fail is
       * a sign-out nobody trusts, and the cookie is httpOnly — if the request did not
       * land, the session is still live server-side, but keeping the user on an admin
       * screen because of it is worse than sending them to the login page.
       */
      setStatus('signedOut');
      window.location.replace(loginUrl());
    }
  }, []);

  return { status, email, configError, handleUnauthorized, signOut };
}
