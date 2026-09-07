import type { RequestHandler } from 'express';
import { config } from '../config/env';
import { queryOne, type RowDataPacket } from '../db/pool';
import { requireCsrf } from './auth';
import { verifySession } from '../modules/admin/auth.service';
import { verifyAccessToken } from '../modules/telecalling/auth/mobileAuth.service';
import { hasRole, type Actor } from '../modules/telecalling/actor';
import type { EmployeeRole } from '../modules/telecalling/shared.schema';
import { forbidden, unauthorized } from '../utils/httpError';
import { describeError, logger } from '../utils/logger';

/**
 * Resolves the caller of a telecalling route to a single `Actor`, whichever credential
 * they presented.
 *
 * Two clients, two mechanisms, one identity:
 *
 *   Bearer token  — the mobile app. Stateless; the JWT carries the role.
 *   Cookie session — the admin web app. The cookie carries only an email, so the
 *                    employee row is loaded to find the role.
 *
 * Everything downstream reads `request.actor` and never asks which was used. That is
 * the point: authorisation logic written twice is authorisation logic that disagrees
 * with itself.
 */

interface EmployeeRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  role: EmployeeRole;
  is_active: number;
}

/**
 * Maps an admin cookie session onto a telecalling employee.
 *
 * The website's admin session proves only an email address. To act on leads that email
 * must also correspond to an active `telecaller_users` row — which is what makes the
 * telecalling permission model independent of who can read website enquiries.
 */
async function actorFromEmail(email: string): Promise<Actor | null> {
  const row = await queryOne<EmployeeRow>(
    `SELECT id, name, email, role, is_active
       FROM telecaller_users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  if (!row || row.is_active !== 1) return null;

  return { id: row.id, name: row.name, email: row.email, role: row.role, via: 'cookie' };
}

/** Extracts a Bearer token, or null when the header is absent or malformed. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Requires an authenticated telecalling actor.
 *
 * A Bearer token wins when both are present: an explicit Authorization header is a
 * deliberate act by a client, whereas a cookie rides along on every request from a
 * browser that happens to have one.
 */
export const requireActor: RequestHandler = (request, _response, next) => {
  void (async () => {
    const token = bearerToken(request.get('Authorization'));

    if (token) {
      const actor = verifyAccessToken(token);
      if (!actor) {
        next(unauthorized('Your session has expired. Please sign in again.'));
        return;
      }
      request.actor = actor;
      next();
      return;
    }

    const cookie = request.cookies?.[config.admin.sessionCookieName];

    if (typeof cookie !== 'string' || cookie.length === 0) {
      next(unauthorized('Please sign in to continue.'));
      return;
    }

    const payload = verifySession(cookie);
    if (!payload) {
      next(unauthorized('Your session has expired. Please sign in again.'));
      return;
    }

    const actor = await actorFromEmail(payload.sub);

    if (!actor) {
      // Signed in to the website admin, but not a telecalling user. A real and
      // recoverable situation — an admin needs a `telecaller_users` row too — so say
      // what to do rather than returning a bare 403.
      next(
        forbidden(
          'This account is not set up for the telecalling system. Ask an administrator to add you as an employee.',
        ),
      );
      return;
    }

    // The cookie path proves identity but not CSRF. State-changing cookie requests
    // still go through `requireCsrf`, which is applied alongside this middleware on
    // the admin router.
    request.actor = actor;
    request.admin = { email: payload.sub, csrf: payload.csrf };
    next();
  })().catch((error) => {
    logger.error('Actor resolution failed', describeError(error));
    next(error);
  });
};

/**
 * Requires at least `minimum`. Rank order: telecaller < supervisor < manager < admin.
 *
 * Always applied to the route, never inferred from what the UI chose to render. The
 * mobile app and the admin app both talk to the same endpoints, and a hidden button is
 * not an access control.
 */
export function requireRole(minimum: EmployeeRole): RequestHandler {
  return (request, _response, next) => {
    if (!request.actor) {
      next(unauthorized());
      return;
    }

    if (!hasRole(request.actor, minimum)) {
      next(forbidden('You do not have permission to do that.'));
      return;
    }

    next();
  };
}

/**
 * Rejects a cookie-authenticated caller on routes meant only for the mobile app.
 *
 * Used by the refresh and push-token endpoints, which manage device sessions and have
 * no meaning for a browser.
 */
export const requireBearer: RequestHandler = (request, _response, next) => {
  if (!request.actor) {
    next(unauthorized());
    return;
  }
  if (request.actor.via !== 'bearer') {
    next(forbidden('This endpoint is only available to the mobile app.'));
    return;
  }
  next();
};

/**
 * CSRF protection for state-changing telecalling routes — but only where it means
 * anything.
 *
 * CSRF exists because a browser attaches a cookie to a cross-site request automatically,
 * so possession of the cookie does not prove the user intended the request. A Bearer
 * token is the opposite: nothing attaches it automatically, another origin cannot read
 * it out of the app's secure storage, and a cross-site form post cannot set an
 * `Authorization` header at all. Demanding a CSRF token from a Bearer caller therefore
 * protects nothing and simply breaks the mobile app — which is what it did, until this
 * middleware replaced a bare `requireCsrf` on the admin telecalling router.
 *
 * This is not a bypass. Reaching the `bearer` branch requires a valid access JWT whose
 * audience is `jmk-mobile`; an admin cookie session is signed with the same secret but
 * carries `jmk-admin`, and `verifyAccessToken` rejects it. So a stolen cookie value
 * cannot be replayed in the header to skip the check.
 */
export const requireCsrfForCookieSession: RequestHandler = (request, response, next) => {
  if (!request.actor) {
    next(unauthorized());
    return;
  }

  if (request.actor.via === 'bearer') {
    next();
    return;
  }

  requireCsrf(request, response, next);
};
