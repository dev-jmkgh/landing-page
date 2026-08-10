/** Errors that are safe to surface to the client, with an HTTP status attached. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  /** Detail for the server log only — never sent to the client. */
  readonly internal?: unknown;

  constructor(
    status: number,
    message: string,
    options: { code?: string; fieldErrors?: Record<string, string>; internal?: unknown } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code ?? 'error';
    this.fieldErrors = options.fieldErrors ?? {};
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

export const tooManyRequests = (message: string) =>
  new HttpError(429, message, { code: 'rate_limited' });

export const serverError = (internal?: unknown) =>
  new HttpError(500, 'Something went wrong. Please try again in a moment.', {
    code: 'server_error',
    internal,
  });
