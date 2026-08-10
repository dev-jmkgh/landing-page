import { config } from '../config/env';

/**
 * Minimal levelled logger. Keeps output structured enough to grep in Hostinger's log
 * viewer without pulling in a logging framework.
 *
 * Never pass credentials, tokens or full request bodies to these functions.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel];

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] > threshold) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const payload = meta && Object.keys(meta).length > 0 ? `${line} ${JSON.stringify(meta)}` : line;

  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

export const logger = {
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
};

/** Reduces an unknown thrown value to something safe to log. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(config.isProduction ? {} : { stack: error.stack }),
    };
  }
  return { message: String(error) };
}
