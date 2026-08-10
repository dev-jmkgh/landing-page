/**
 * Centralised API client.
 *
 * All network access from the browser goes through this module so that base URL,
 * credentials, CSRF handling and error normalisation live in exactly one place.
 */

const RAW_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000/api';

export const API_BASE_URL = RAW_BASE.replace(/\/+$/, '');

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
    response = await fetch(`${API_BASE_URL}${path}`, {
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

export type EnquiryResponse = { reference: string };

export type ApplicationResponse = { reference: string };

export const api = {
  health: () => request<{ status: string }>('/health'),

  submitEnquiry: (payload: EnquiryPayload, signal?: AbortSignal) =>
    request<EnquiryResponse>('/enquiries', { method: 'POST', body: payload, signal }),

  submitApplication: (formData: FormData, signal?: AbortSignal) =>
    request<ApplicationResponse>('/applications', { method: 'POST', body: formData, signal }),
};

/* -------------------------------------------------------------------------- */
/* Admin endpoints                                                             */
/* -------------------------------------------------------------------------- */

export type EnquiryStatus = 'new' | 'contacted' | 'in_progress' | 'closed';

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
  resumeFilename: string | null;
  status: EnquiryStatus;
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
  status?: EnquiryStatus | 'all';
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

  updateApplicationStatus: (id: number, status: EnquiryStatus) =>
    request<AdminApplication>(`/admin/applications/${id}/status`, {
      method: 'PATCH',
      body: { status },
      authenticated: true,
    }),

  resumeUrl: (id: number) => `${API_BASE_URL}/admin/applications/${id}/resume`,
};
