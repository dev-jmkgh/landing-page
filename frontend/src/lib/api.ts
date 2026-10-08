/**
 * Centralised API client.
 *
 * All network access from the browser goes through this module so that base URL,
 * credentials, CSRF handling and error normalisation live in exactly one place.
 */

const CONFIGURED_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');

let resolvedBase: string | null = null;

/**
 * Base URL of the API.
 *
 * Deployments set `NEXT_PUBLIC_API_BASE_URL`. When it is absent the app falls back to
 * the local API *only* while running on localhost, so a developer who has not created
 * `.env.local` still gets a working setup. A deployed build with no API configured
 * resolves to an empty string and the forms say so plainly — see `isApiConfigured`.
 */
export function apiBaseUrl(): string {
  if (resolvedBase !== null) return resolvedBase;

  if (CONFIGURED_BASE) {
    resolvedBase = CONFIGURED_BASE;
  } else if (
    // Development convenience only. A production build never guesses at localhost —
    // otherwise a deployed demo would quietly try to reach the developer's own machine
    // instead of admitting it has no backend.
    process.env.NODE_ENV !== 'production' &&
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ) {
    resolvedBase = 'http://localhost:5000/api';
  } else {
    resolvedBase = '';
  }

  return resolvedBase;
}

/**
 * False on a front-end-only deployment (the GitHub Pages demo). Forms use this to say
 * up front that submissions cannot be received yet, rather than failing at the end or —
 * worse — pretending to succeed.
 */
export function isApiConfigured(): boolean {
  return apiBaseUrl().length > 0;
}

export const API_NOT_CONFIGURED_MESSAGE =
  'This is a design preview — the enquiry service is not connected yet, so this form cannot be submitted. Please email info@jmkglobalholdings.com in the meantime.';

export type FieldErrors = Record<string, string>;

/**
 * Structured context the server attached to an error.
 *
 * Most errors carry none. A conflict does, when the screen needs more than the sentence
 * to recover: the follow-up a move collided with, or how many follow-ups are still
 * blocking a deactivation. The shape is per error `code`, so callers narrow it there.
 */
export type ErrorDetails = Record<string, unknown>;

/** Normalised transport/validation error surfaced to the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: FieldErrors;
  readonly code?: string;
  readonly details?: ErrorDetails;

  /**
   * `details` is the fifth argument, after `code`, so every existing `new ApiError(...)`
   * call — four arguments or fewer — compiles and behaves exactly as it did.
   */
  constructor(
    message: string,
    status: number,
    fieldErrors: FieldErrors = {},
    code?: string,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.code = code;
    this.details = details;
  }
}

const NETWORK_MESSAGE =
  'We could not reach our servers. Please check your connection and try again.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again in a moment.';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * CSRF token for the current admin session, held in memory.
 *
 * The cookie the API sets is host-only on the API's own domain, so when the site and
 * the API live on different subdomains (www. and api.) the page cannot read it. The
 * API therefore also returns the token in the sign-in and session responses, and that
 * value is kept here. The cookie remains a fallback for same-origin deployments.
 */
let csrfToken: string | null = null;

function rememberCsrfToken(value: unknown): void {
  if (typeof value === 'string' && value.length > 0) csrfToken = value;
}

function currentCsrfToken(): string | null {
  return csrfToken ?? readCookie('jmk_csrf');
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the admin session cookie and CSRF header. */
  authenticated?: boolean;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, authenticated = false, signal } = options;

  // Fail clearly and honestly rather than firing a request at nothing.
  if (!isApiConfigured()) {
    throw new ApiError(API_NOT_CONFIGURED_MESSAGE, 0, {}, 'api_not_configured');
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;

  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  if (authenticated && method !== 'GET') {
    const token = currentCsrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }

  // Admin requests are counted for the global loading bar (components/admin/Loader.tsx).
  // Public website requests are not: the bar only exists inside the admin shell.
  if (authenticated) setActiveRequests(activeRequests + 1);

  try {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl()}${path}`, {
        method,
        headers,
        body: payload,
        credentials: authenticated ? 'include' : 'same-origin',
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(NETWORK_MESSAGE, 0);
    }

    const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
    /*
     * An abort that lands after the headers but before the body has finished arriving
     * fails the body read, not `fetch` — and swallowing that turned a cancelled request
     * into a successful `null`, which the screen then reported as "Could not load…" over
     * the newer request's correct rows. Rethrow it so callers see an AbortError and
     * ignore it, as they already do for an abort before the headers.
     */
    const data: unknown = isJson
      ? await response.json().catch((error: unknown) => {
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw error instanceof DOMException ? error : new DOMException('Aborted', 'AbortError');
          }
          return null;
        })
      : null;

    if (!response.ok) {
      const errorBody = (data ?? {}) as {
        message?: string;
        code?: string;
        errors?: FieldErrors;
        details?: unknown;
      };
      // Only a plain object is passed on. Anything else is not a shape any screen reads,
      // and handing it over typed as a record would invite a crash on the first property.
      const details =
        typeof errorBody.details === 'object' &&
        errorBody.details !== null &&
        !Array.isArray(errorBody.details)
          ? (errorBody.details as ErrorDetails)
          : undefined;
      throw new ApiError(
        errorBody.message ?? GENERIC_MESSAGE,
        response.status,
        errorBody.errors ?? {},
        errorBody.code,
        details,
      );
    }

    return (data ?? null) as T;
  } finally {
    // In `finally`, so an aborted, failed or rejected request can never leave the bar
    // running forever.
    if (authenticated) setActiveRequests(activeRequests - 1);
  }
}

/* -------------------------------------------------------------------------- */
/* In-flight request tracking                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many authenticated requests are in flight right now.
 *
 * Kept here, in the transport, because this is the one place every admin request passes
 * through — so the global loading bar can never miss one, and no panel has to remember to
 * report its own. Read through `subscribeToRequests` / `getActiveRequestCount`, which are
 * shaped for React's `useSyncExternalStore`.
 */
let activeRequests = 0;
const requestListeners = new Set<() => void>();

function setActiveRequests(next: number): void {
  // Never below zero, whatever happens to the bookkeeping.
  activeRequests = Math.max(0, next);
  for (const listener of requestListeners) listener();
}

/** The number of admin requests currently in flight. */
export function getActiveRequestCount(): number {
  return activeRequests;
}

/** Calls `listener` whenever that number changes. Returns the unsubscribe function. */
export function subscribeToRequests(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/**
 * Authenticated request, for API surfaces defined in other modules.
 *
 * The telecalling admin API is roughly as large again as the whole website API, so it
 * lives in `telecalling.ts` rather than growing this file. It still has to go through
 * the transport above — base URL resolution, the in-memory CSRF token, credential mode
 * and `ApiError` normalisation — because a second copy of any of those would eventually
 * disagree with this one.
 *
 * `authenticated` is forced on: there is no such thing as an unauthenticated admin
 * request, and making it a parameter would let a caller accidentally omit the CSRF
 * header on a state-changing call.
 */
export function adminRequest<T>(
  path: string,
  options: Omit<RequestOptions, 'authenticated'> = {},
): Promise<T> {
  return request<T>(path, { ...options, authenticated: true });
}

/* -------------------------------------------------------------------------- */
/* Public endpoints                                                            */
/* -------------------------------------------------------------------------- */

export type EnquiryPayload = {
  name: string;
  email: string;
  phone: string;
  company?: string;
  interestedIn: string;
  message: string;
  source: 'floating-widget' | 'contact-page' | 'business-page';
  /** Anti-spam: must stay empty. */
  website?: string;
  /** Anti-spam: epoch ms when the form was rendered. */
  renderedAt: number;
  /** reCAPTCHA v2 response token, when reCAPTCHA is configured. */
  recaptchaToken?: string;
};

/**
 * How the notification emails actually went.
 *
 * The submission itself is stored before any email is attempted, so none of these
 * values means the enquiry or application was lost — they describe delivery only.
 */
export type EmailStatus = 'sent' | 'partial' | 'pending' | 'failed' | 'skipped';

export type SubmissionResponse = {
  reference: string;
  /** Server-authored confirmation. Reflects what really happened to the email. */
  message?: string;
  emailStatus?: EmailStatus;
};

export type EnquiryResponse = SubmissionResponse;

export type ApplicationResponse = SubmissionResponse;

export const api = {
  health: () => request<{ status: string }>('/health'),

  submitEnquiry: (payload: EnquiryPayload, signal?: AbortSignal) =>
    request<EnquiryResponse>('/enquiries', { method: 'POST', body: payload, signal }),

  submitApplication: (formData: FormData, signal?: AbortSignal) =>
    request<ApplicationResponse>('/careers/apply', { method: 'POST', body: formData, signal }),

  /**
   * Asks for a presigned URL so the resume can go straight to storage instead of
   * through the API. `supported: false` is a normal answer, not a failure — it means
   * the server stores files locally and wants the file posted with the form.
   */
  requestResumeUploadUrl: (
    file: { filename: string; contentType: string; size: number },
    signal?: AbortSignal,
  ) =>
    request<ResumeUploadTicket>('/careers/resume-upload-url', {
      method: 'POST',
      body: JSON.stringify(file),
      signal,
    }),
};

/* -------------------------------------------------------------------------- */
/* Admin endpoints                                                             */
/* -------------------------------------------------------------------------- */

export type ResumeUploadTicket =
  | { supported: false }
  | {
      supported: true;
      key: string;
      token: string;
      url: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    };

export type EnquiryStatus = 'new' | 'contacted' | 'in_progress' | 'closed';
export type ApplicationStatus = 'new' | 'reviewing' | 'shortlisted' | 'rejected' | 'hired';
/** The list filter serves both tables, so it accepts either vocabulary. */
export type RecordStatus = EnquiryStatus | ApplicationStatus;

export type AdminEnquiry = {
  id: number;
  reference: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  interestedIn: string;
  message: string;
  source: string;
  status: EnquiryStatus;
  createdAt: string;
  updatedAt: string;
};

export type AdminApplication = {
  id: number;
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  experience: string | null;
  location: string | null;
  resumeFilename: string | null;
  resumeOriginalName: string | null;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type AdminListQuery = {
  status?: RecordStatus | 'all';
  q?: string;
  page?: number;
  pageSize?: number;
};

function toQueryString(query: AdminListQuery): string {
  const params = new URLSearchParams();
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const adminApi = {
  login: (email: string, password: string) =>
    request<{ email: string; csrfToken?: string }>('/admin/auth/login', {
      method: 'POST',
      body: { email, password },
      authenticated: true,
    }).then((session) => {
      rememberCsrfToken(session.csrfToken);
      return session;
    }),

  logout: () =>
    request<null>('/admin/auth/logout', { method: 'POST', authenticated: true }).finally(() => {
      csrfToken = null;
    }),

  session: (signal?: AbortSignal) =>
    request<{ email: string; csrfToken?: string }>('/admin/auth/session', {
      authenticated: true,
      signal,
    }).then((session) => {
      rememberCsrfToken(session.csrfToken);
      return session;
    }),

  listEnquiries: (query: AdminListQuery, signal?: AbortSignal) =>
    request<Paginated<AdminEnquiry>>(`/admin/enquiries${toQueryString(query)}`, {
      authenticated: true,
      signal,
    }),

  updateEnquiryStatus: (id: number, status: EnquiryStatus) =>
    request<AdminEnquiry>(`/admin/enquiries/${id}/status`, {
      method: 'PATCH',
      body: { status },
      authenticated: true,
    }),

  listApplications: (query: AdminListQuery, signal?: AbortSignal) =>
    request<Paginated<AdminApplication>>(`/admin/applications${toQueryString(query)}`, {
      authenticated: true,
      signal,
    }),

  updateApplicationStatus: (id: number, status: ApplicationStatus) =>
    request<AdminApplication>(`/admin/applications/${id}/status`, {
      method: 'PATCH',
      body: { status },
      authenticated: true,
    }),

  resumeUrl: (id: number) => `${apiBaseUrl()}/admin/applications/${id}/resume`,
};
