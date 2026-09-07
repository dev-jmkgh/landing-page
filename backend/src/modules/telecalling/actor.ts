import type { EmployeeRole } from './shared.schema';

/**
 * Who is making the request.
 *
 * The API is reached two ways — a cookie session from the admin web app, and a Bearer
 * token from the mobile app — and route handlers must not care which. Both middlewares
 * resolve to this one shape on `request.actor`, so authorisation is written once.
 */
export type Actor = {
  id: number;
  name: string;
  email: string;
  role: EmployeeRole;
  /** Which credential proved this identity. Recorded in the audit log. */
  via: 'cookie' | 'bearer';
};

/**
 * Role ranks.
 *
 * Numeric so a check reads as "at least a manager" rather than as a list of roles that
 * someone will forget to extend the next time a role is added.
 */
const RANK: Record<EmployeeRole, number> = {
  telecaller: 1,
  supervisor: 2,
  manager: 3,
  admin: 4,
};

export function rankOf(role: EmployeeRole): number {
  return RANK[role];
}

/** True when `actor` holds at least `minimum`. */
export function hasRole(actor: Actor, minimum: EmployeeRole): boolean {
  return RANK[actor.role] >= RANK[minimum];
}

/**
 * Which employees' records this actor may see.
 *
 * `null` means "everything" — a supervisor and above monitors the whole floor. A number
 * means "only this employee's own records", which is the telecaller case.
 *
 * This is returned as a value and passed *into* every lead-, call- and follow-up-scoped
 * repository function rather than being checked in the route handler. An `if` in a
 * handler is one forgotten branch away from a data leak; a required parameter on the
 * query is not something you can forget, because the code will not compile.
 */
export type OwnershipScope = number | null;

export function ownershipScope(actor: Actor): OwnershipScope {
  return hasRole(actor, 'supervisor') ? null : actor.id;
}

/**
 * Whether this actor may act on a record owned by `ownerId`.
 *
 * Used for the writes that cannot be expressed as a query filter — completing someone
 * else's follow-up, editing a lead — where the row has already been loaded and the
 * question is whether to allow the change.
 */
export function canActOnOwner(actor: Actor, ownerId: number | null): boolean {
  if (hasRole(actor, 'supervisor')) return true;
  return ownerId !== null && ownerId === actor.id;
}

/** Label recorded in the audit log, which must survive deletion of the account. */
export function actorLabel(actor: Actor): string {
  return `${actor.name} <${actor.email}>`;
}
