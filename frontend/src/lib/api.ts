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

/** Normalised transport/validation error surfaced to the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: FieldErrors;
  readonly code?: string;

  constructor(message: string, status: number, fieldErrors: FieldErrors = {}, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.code = code;
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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
  const data: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errorBody = (data ?? {}) as {
      message?: string;
      code?: string;
      errors?: FieldErrors;
    };
    throw new ApiError(
      errorBody.message ?? GENERIC_MESSAGE,
      response.status,
      errorBody.errors ?? {},
      errorBody.code,
    );
  }

  return (data ?? null) as T;
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
};

/* -------------------------------------------------------------------------- */
/* Admin endpoints                                                             */
/* -------------------------------------------------------------------------- */

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
