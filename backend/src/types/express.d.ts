import 'express';
import type { Actor } from '../modules/telecalling/actor';
import type { HrActor } from '../modules/hr/hrAuth.service';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` for authenticated admin routes. */
      admin?: {
        email: string;
        csrf: string;
      };

      /**
       * Populated by `requireActor` for telecalling routes.
       *
       * Deliberately separate from `admin`: that one identifies whoever can read
       * website enquiries, this one identifies an employee in the telecalling org
       * chart, with a role and lead ownership. A request can carry both.
       */
      actor?: Actor;

      /**
       * Populated by `requireHrActor` for HR app routes.
       *
       * A THIRD identity, not a reuse of `actor`. HR accounts live in their own table
       * with their own id space and their own role set (migration 017), so an
       * `hr_users` row and a `telecaller_users` row can share an id and mean different
       * people. Putting one in the other's slot would make that collision invisible —
       * a telecalling handler reading `request.actor` would silently scope a lead query
       * to whoever happened to hold the same id.
       *
       * No request should ever carry both: the two middlewares pin different JWT
       * audiences, so a token that satisfies one cannot satisfy the other.
       */
      hrActor?: HrActor;
    }
  }
}

export {};
