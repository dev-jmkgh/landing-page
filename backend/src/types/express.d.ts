import 'express';
import type { Actor } from '../modules/telecalling/actor';

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
    }
  }
}

export {};
