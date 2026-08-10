import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config/env';
import { closePool, verifyConnection } from './db/pool';
import { ensureUploadDirectory } from './middleware/upload';
import { verifyMailer } from './services/mailer';
import { describeError, logger } from './utils/logger';

/**
 * Process entry point: start-up checks, HTTP listener and graceful shutdown.
 */

async function start(): Promise<void> {
  ensureUploadDirectory();

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

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);

    server.close(() => {
      void closePool()
        .catch((error) => logger.warn('Error closing database pool', describeError(error)))
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
