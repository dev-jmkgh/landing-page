/** Errors that are safe to surface to the client, with an HTTP status attached. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  /**
   * Structured facts the client can act on — sent to the client, unlike `internal`.
   *
   * For refusals a screen has to explain rather than just display: which follow-up a
   * duplicate clashes with, how many pending follow-ups block a deactivation. Only ever
   * built from values the caller is already allowed to see.
   */
  readonly details?: Record<string, unknown>;
  /** Detail for the server log only — never sent to the client. */
  readonly internal?: unknown;

  constructor(
    status: number,
    message: string,
    options: {
      code?: string;
      fieldErrors?: Record<string, string>;
      details?: Record<string, unknown>;
      internal?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code ?? 'error';
    this.fieldErrors = options.fieldErrors ?? {};
    this.details = options.details;
    this.internal = options.internal;
  }
}

export const badRequest = (message: string, fieldErrors?: Record<string, string>) =>
  new HttpError(400, message, { code: 'bad_request', fieldErrors });

export const validationFailed = (fieldErrors: Record<string, string>) =>
  new HttpError(422, 'Please correct the highlighted fields and try again.', {
    code: 'validation_failed',
    fieldErrors,
  });

export const unauthorized = (message = 'Authentication required.') =>
  new HttpError(401, message, { code: 'unauthorized' });

export const forbidden = (message = 'You do not have access to this resource.') =>
  new HttpError(403, message, { code: 'forbidden' });

export const notFound = (message = 'The requested resource was not found.') =>
  new HttpError(404, message, { code: 'not_found' });

/**
 * The request was valid, but the current state of the data refuses it — someone else
 * changed it first, it would duplicate something, or it would strand pending work.
 *
 * `code` is required, not defaulted: a 409 is only useful to a client that can tell
 * which conflict it hit, and a generic code would push every screen back to matching on
 * message text.
 */
export const conflict = (message: string, code: string, details?: Record<string, unknown>) =>
  new HttpError(409, message, { code, details });

export const tooManyRequests = (message: string) =>
  new HttpError(429, message, { code: 'rate_limited' });

export const serverError = (internal?: unknown) =>
  new HttpError(500, 'Something went wrong. Please try again in a moment.', {
    code: 'server_error',
    internal,
  });
