import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { validationFailed } from '../utils/httpError';

/**
 * Validates and replaces `request.body` with the parsed, typed result.
 *
 * Backend validation is authoritative: the client repeats these rules for fast
 * feedback, but nothing reaches the database without passing here first.
 *
 * Generic over the schema rather than over its output type. A schema that uses
 * `.default()`, `.transform()` or `.catch()` — which most of them do, because that is
 * how "empty string means null" and "absent means the default" are expressed — has an
 * input type that differs from its output type, and `ZodSchema<T>` requires the two to
 * be identical. Constraining on the schema itself accepts either shape; the handler
 * casts `request.body` to the inferred output type at the point of use.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request.body);

    if (!result.success) {
      next(validationFailed(toFieldErrors(result.error)));
      return;
    }

    request.body = result.data;
    next();
  };
}

/** Validates `request.query` without reassigning it (Express 5 makes it read-only). */
export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (request, response, next) => {
    const result = schema.safeParse(request.query);

    if (!result.success) {
      next(validationFailed(toFieldErrors(result.error)));
      return;
    }

    response.locals.query = result.data;
    next();
  };
}

/** Flattens a Zod error into `{ fieldName: 'message' }` for the form UI. */
export function toFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }

  return fieldErrors;
}
