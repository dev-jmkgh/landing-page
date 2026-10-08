import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config/env';
import { closePool, verifyConnection } from './db/pool';
import {
  startTelecallingReportScheduler,
  type TelecallingReportScheduler,
} from './modules/telecalling/reports/dailyReport.scheduler';
import { ensureStorageReady, storageReport } from './services/storage';
import { verifyMailer } from './services/mailer';
import { describeError, logger } from './utils/logger';

/**
 * Process entry point: start-up checks, HTTP listener and graceful shutdown.
 */

async function start(): Promise<void> {
  await ensureStorageReady();

  const app = createApp();

  // Report the state of both dependencies at boot. Neither is fatal: the API still
  // answers health checks and returns clean errors while an operator fixes them.
  const databaseReady = await verifyConnection();
  if (!databaseReady) {
    logger.error(
      'Starting without a working database connection. Form submissions will fail until it is fixed.',
    );
  }

  await verifyMailer();

  // Says where resumes will land — the single most confusing thing to get wrong after a
  // deploy, because a misconfigured driver fails only when someone finally applies.
  logger.info('Resume storage', storageReport());

  const server: Server = app.listen(config.port, () => {
    logger.info('API listening', {
      port: config.port,
      environment: config.env,
      corsOrigins: config.corsOrigins,
      uploadDir: config.uploads.directory,
      smtp: config.smtp.enabled ? 'configured' : 'disabled',
    });
  });

  server.on('error', (error) => {
    logger.error('HTTP server error', describeError(error));
    process.exit(1);
  });

  /*
   * The daily telecalling report's clock. Here and never in createApp(), so the e2e
   * harness and anything else that imports the app get no timers. Whether THIS process
   * runs it is a per-process switch (on by default only in production); whether a day's
   * report has gone out is decided by the database, so several processes with it on
   * still send once. Its timers are unref'd and it never throws.
   */
  const reportScheduler: TelecallingReportScheduler | null = config.telecallingReport
    .schedulerEnabled
    ? startTelecallingReportScheduler()
    : null;

  logger.info('Daily telecalling report', {
    scheduler: reportScheduler ? 'on' : 'off',
    recipients: config.telecallingReport.recipients.length,
    recipientSource: 'ADMIN_EMAILS',
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);

    // Stop scheduling at once; a report already being sent is allowed to finish, within
    // the hard exit below, before the pool it writes its outcome through is closed.
    const schedulerStopped = reportScheduler ? reportScheduler.stop() : Promise.resolve();

    server.close(() => {
      void schedulerStopped
        .catch((error: unknown) => logger.warn('Error stopping the report scheduler', describeError(error)))
        .then(() => closePool())
        .catch((error: unknown) => logger.warn('Error closing database pool', describeError(error)))
        .finally(() => process.exit(0));
    });

    // Do not hang forever on in-flight connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', describeError(reason));
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', describeError(error));
    process.exit(1);
  });
}

start().catch((error) => {
  logger.error('Failed to start the API', describeError(error));
  process.exit(1);
});
