import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { config } from '../config/env';
import { HttpError } from '../utils/httpError';
import { describeError, logger } from '../utils/logger';

/** 404 handler for unmatched API routes. */
export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    success: false,
    code: 'not_found',
    message: 'The requested endpoint does not exist.',
    path: request.originalUrl,
  });
};

/**
 * Central error handler.
 *
 * Clients receive a stable shape: `{ success, code, message, errors }`. Stack traces,
 * SQL text and driver messages are logged server-side and never sent to the browser.
 */
export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  void _next;

  if (response.headersSent) return;

  /* ------------------------------------------------ known application errors */
  if (error instanceof HttpError) {
    if (error.status >= 500) {
      logger.error('Request failed', {
        path: request.originalUrl,
        status: error.status,
        ...describeError(error.internal ?? error),
      });
    } else {
      logger.debug('Request rejected', {
        path: request.originalUrl,
        status: error.status,
        code: error.code,
      });
    }

    response.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(Object.keys(error.fieldErrors).length > 0 ? { errors: error.fieldErrors } : {}),
    });
    return;
  }

  /* --------------------------------------------------------- upload errors */
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `The file is too large. Maximum size is ${config.uploads.maxSizeLabel}.`
        : error.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Unexpected file field.'
          : 'The file could not be uploaded. Please try again.';

    logger.warn('Upload rejected', { code: error.code, field: error.field });
    response.status(400).json({
      success: false,
      code: 'upload_failed',
      message,
      errors: { resume: message },
    });
    return;
  }

  /* ------------------------------------------- body-parser rejections ------
   * Covers malformed JSON, oversized payloads and unsupported charsets. These
   * arrive as plain Errors carrying a `status` and a `type`, so they are matched
   * here rather than falling through to a misleading 500.
   */
  const parserError = error as { status?: number; statusCode?: number; type?: string };
  const parserStatus = parserError.status ?? parserError.statusCode;

  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const message =
      parserError.type === 'entity.too.large'
        ? 'That message is too large. Please shorten it and try again.'
        : 'The request body could not be read.';

    logger.warn('Request body rejected', {
      path: request.originalUrl,
      status: parserStatus,
      type: parserError.type,
    });

    response.status(parserStatus).json({
      success: false,
      code: parserError.type === 'entity.too.large' ? 'payload_too_large' : 'bad_request',
      message,
    });
    return;
  }

  /* ------------------------------------------------------------ everything else */
  logger.error('Unhandled error', {
    path: request.originalUrl,
    method: request.method,
    ...describeError(error),
  });

  response.status(500).json({
    success: false,
    code: 'server_error',
    message: 'Something went wrong. Please try again in a moment.',
  });
};

/** Wraps async route handlers so rejected promises reach the error handler. */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
