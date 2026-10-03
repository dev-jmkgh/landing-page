import type { RequestHandler } from 'express';
import { verifyHrAccessToken } from '../modules/hr/hrAuth.service';
import { HR_ROLES, type HrRole } from '../modules/hr/hr.schema';
import { forbidden, unauthorized } from '../utils/httpError';

/**
 * Resolves the caller of an HR route.
 *
 * Bearer only, and deliberately so. `requireActor` on the telecalling side accepts an
 * admin cookie as well, because the admin web app works leads through the same
 * endpoints. The HR app has no such second client: administrators manage HR accounts
 * through `/api/admin/hr`, authenticating as administrators. Accepting a cookie here
 * would mean a website admin session silently became an HR employee identity, and
 * there is no HR row to map it onto.
 *
 * It does NOT fall back to `requireActor`. A telecalling token must fail here, and it
 * does — `verifyHrAccessToken` pins audience `jmk-hr`, so a `jmk-mobile` token does not
 * verify at all.
 */
export const requireHrActor: RequestHandler = (request, _response, next) => {
  const header = request.get('Authorization');

  const token = (() => {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
    return value.trim() || null;
  })();

  if (!token) {
    next(unauthorized('Please sign in to continue.'));
    return;
  }

  const actor = verifyHrAccessToken(token);

  if (!actor) {
    next(unauthorized('Your session has expired. Please sign in again.'));
    return;
  }

  /*
   * The role is validated against the enum rather than trusted from the token.
   *
   * It is signed, so it cannot be forged — but it can be STALE: a token minted before a
   * role was renamed or removed still carries the old string, and `rankOf` would return
   * undefined for it, making every `>=` comparison false in a way that reads as
   * "permission denied" rather than as a bug. Refusing outright turns a silent
   * mis-authorisation into a sign-in prompt.
   */
  if (!HR_ROLES.includes(actor.role)) {
    next(unauthorized('Your session is no longer valid. Please sign in again.'));
    return;
  }

  request.hrActor = actor;
  next();
};

/** Rank order: employee < hr_manager < hr_admin. */
const RANK: Record<HrRole, number> = {
  employee: 0,
  hr_manager: 1,
  hr_admin: 2,
};

export function hasHrRole(role: HrRole, minimum: HrRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Requires at least `minimum`.
 *
 * Applied to the route, never inferred from what the app chose to render. A hidden
 * button is not an access control.
 */
export function requireHrRole(minimum: HrRole): RequestHandler {
  return (request, _response, next) => {
    if (!request.hrActor) {
      next(unauthorized());
      return;
    }

    if (!hasHrRole(request.hrActor.role, minimum)) {
      next(forbidden('You do not have permission to do that.'));
      return;
    }

    next();
  };
}
