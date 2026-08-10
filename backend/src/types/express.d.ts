import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` for authenticated admin routes. */
      admin?: {
        email: string;
        csrf: string;
      };
    }
  }
}

export {};
