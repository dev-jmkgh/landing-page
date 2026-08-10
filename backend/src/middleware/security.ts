import type { RequestHandler } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { config } from '../config/env';
import { forbidden } from '../utils/httpError';

/**
 * Security middleware: response headers and the CORS allowlist.
 */

export const securityHeaders: RequestHandler = helmet({
  // The API returns JSON and file downloads only — it renders no HTML of its own.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  // Downloads are served with an explicit Content-Disposition.
  crossOriginOpenerPolicy: { policy: 'same-origin' },
});

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Non-browser clients (curl, health checks, server-to-server) send no Origin.
    if (!origin) return callback(null, true);

    const normalised = origin.replace(/\/+$/, '');
    if (config.corsOrigins.includes(normalised)) return callback(null, true);

    return callback(forbidden('Origin not allowed.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-CSRF-Token'],
  exposedHeaders: ['Content-Disposition'],
  maxAge: 600,
};

export const corsMiddleware = cors(corsOptions);
