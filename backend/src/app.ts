import compression from 'compression';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalLimiter } from './middleware/rateLimit';
import { corsMiddleware, securityHeaders } from './middleware/security';
import { adminRouter } from './modules/admin/admin.routes';
import { applicationRouter } from './modules/applications/application.routes';
import { diagnosticsRouter } from './modules/diagnostics/diagnostics.routes';
import { enquiryRouter } from './modules/enquiries/enquiry.routes';
import { logger } from './utils/logger';

/**
 * Express application wiring. Kept separate from `server.ts` so the app can be imported
 * by tests or a different runtime host without opening a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind Hostinger/Nginx/Cloudflare, req.ip must come from X-Forwarded-For.
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(compression());
  app.use(cookieParser());

  // Request bodies are small by design; multipart uploads are handled by multer.
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  if (!config.isProduction) {
    app.use((request, _response, next) => {
      logger.debug(`${request.method} ${request.originalUrl}`);
      next();
    });
  }

  app.use('/api', globalLimiter);

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'jmk-api',
      environment: config.env,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/diagnostics', diagnosticsRouter);
  app.use('/api/enquiries', enquiryRouter);
  app.use('/api/applications', applicationRouter);
  // The careers form posts to /api/careers/apply, which reads better from the client
  // and matches the page it comes from. Same router, so there is one implementation.
  app.use('/api/careers', applicationRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
