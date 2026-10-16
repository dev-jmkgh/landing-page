import { adminRequest, apiBaseUrl } from './api';
import type { HrPaginated } from './hr';
import { hrQuery } from './hrLeave';

/**
 * The HR requests, shared documents and announcements admin API
 * (`/api/admin/hr/requests`, `/documents`, `/notifications/broadcast`).
 *
 * Mirrored by hand from `backend/src/modules/hr/requests/requests.schema.ts`. Every call
 * goes through `adminRequest`, which carries the cookie session and puts the CSRF header
 * on every write — the multipart upload included: FormData is passed through untouched,
 * so the browser sets the multipart boundary itself.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const HR_REQUEST_CATEGORIES = [
  'profile_update',
  'letter',
  'payroll',
  'attendance',
  'leave',
  'it',
  'other',
] as const;
export type HrRequestCategory = (typeof HR_REQUEST_CATEGORIES)[number];

export const HR_REQUEST_CATEGORY_LABELS: Record<HrRequestCategory, string> = {
  profile_update: 'Profile update',
  letter: 'Letter',
  payroll: 'Payroll',
  attendance: 'Attendance',
  leave: 'Leave',
  it: 'IT',
  other: 'Other',
};

export const HR_REQUEST_STATUSES = ['open', 'in_progress', 'resolved', 'rejected', 'cancelled'] as const;
export type HrRequestStatus = (typeof HR_REQUEST_STATUSES)[number];

export const HR_REQUEST_STATUS_LABELS: Record<HrRequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const HR_REQUEST_STATUS_TONE: Record<
  HrRequestStatus,
  'warn' | 'progress' | 'good' | 'bad' | 'neutral'
> = {
  open: 'warn',
  in_progress: 'progress',
  resolved: 'good',
  rejected: 'bad',
  cancelled: 'neutral',
};

/** The list filter: each status, plus `active` (open + in progress) and `closed`. */
export type HrRequestStatusFilter = HrRequestStatus | 'active' | 'closed' | 'all';

/** Still waiting on somebody — HR may comment and decide. */
export function isActiveRequest(status: HrRequestStatus): boolean {
  return status === 'open' || status === 'in_progress';
}

/**
 * The profile fields an employee may ask HR to change, in the order the diff lists
 * them. The server holds the same fixed list; nothing outside it can be requested.
 */
export const PROFILE_UPDATE_FIELDS = [
  'phone',
  'address',
  'emergencyContactName',
  'emergencyContactPhone',
  'dateOfBirth',
] as const;
export type ProfileUpdateField = (typeof PROFILE_UPDATE_FIELDS)[number];

export const PROFILE_UPDATE_LABELS: Record<ProfileUpdateField, string> = {
  phone: 'Phone',
  address: 'Address',
  emergencyContactName: 'Emergency contact name',
  emergencyContactPhone: 'Emergency contact phone',
  dateOfBirth: 'Date of birth',
};

/** The NEW values asked for. A key that is present changes; `null` clears the field. */
export type ProfileUpdatePayload = Partial<Record<ProfileUpdateField, string | null>>;

export const HR_DOCUMENT_CATEGORIES = ['policy', 'letter', 'contract', 'identity', 'payroll', 'other'] as const;
export type HrDocumentCategory = (typeof HR_DOCUMENT_CATEGORIES)[number];

export const HR_DOCUMENT_CATEGORY_LABELS: Record<HrDocumentCategory, string> = {
  policy: 'Policy',
  letter: 'Letter',
  contract: 'Contract',
  identity: 'Identity',
  payroll: 'Payroll',
  other: 'Other',
};

export type HrDocumentScope = 'company' | 'personal' | 'all';

/**
 * What the upload accepts, said before the round trip.
 *
 * The size is the server's default `MAX_UPLOAD_MB`, the same budget as a résumé. The
 * server is the authority — it checks the type, the bytes and the size again, and its
 * `errors.file` is shown under the file field whatever this says.
 */
export const HR_DOCUMENT_UPLOAD = {
  maxSizeBytes: 5 * 1024 * 1024,
  maxSizeLabel: '5 MB',
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],
  accept: '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg',
} as const;

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type HrRequest = {
  id: number;
  userId: number;
  employeeName: string;
  employeeCode: string;
  category: HrRequestCategory;
  subject: string;
  details: string | null;
  /** Only for `profile_update`; null for every other category. */
  payload: ProfileUpdatePayload | null;
  status: HrRequestStatus;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  lastActivityAt: string;
  createdAt: string;
  /** Timeline entries somebody wrote — comments, and status changes that carried a note. */
  commentCount: number;
  canCancel: boolean;
};

export type HrRequestComment = {
  id: number;
  authorType: 'employee' | 'admin' | 'system';
  authorName: string | null;
  body: string | null;
  /** Set when this entry records a status change. */
  statusFrom: HrRequestStatus | null;
  statusTo: HrRequestStatus | null;
  createdAt: string;
};

export type HrDocument = {
  id: number;
  /** Null for a company-wide document every employee can read. */
  userId: number | null;
  employeeName: string | null;
  title: string;
  category: HrDocumentCategory;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  requestId: number | null;
  uploadedByName: string | null;
  createdAt: string;
  scope: 'company' | 'personal';
};

export type HrRequestDetail = {
  request: HrRequest;
  /** The first page of the timeline, oldest first. */
  comments: HrPaginated<HrRequestComment>;
  documents: HrDocument[];
  documentsTotal: number;
  /** For a profile update: the employee's present value of each requested field. */
  current: ProfileUpdatePayload | null;
};

export type HrDepartment = {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  employeeCount: number;
};

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/hr';

export type HrRequestQuery = {
  status?: HrRequestStatusFilter;
  category?: HrRequestCategory | 'all';
  userId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type HrDocumentQuery = {
  scope?: HrDocumentScope;
  userId?: number;
  requestId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
};

/**
 * The multipart body for an upload.
 *
 * Built here, next to the call, so the field names the server reads live in one place —
 * a misspelled multipart field is dropped without a word. The text fields go before the
 * file: the server reads the parts in order. `userId` is left out for a company-wide
 * document rather than sent empty.
 */
export function hrDocumentFormData(
  file: File,
  fields: {
    title: string;
    category: HrDocumentCategory;
    userId?: number | null;
    requestId?: number | null;
  },
): FormData {
  const form = new FormData();
  form.append('title', fields.title);
  form.append('category', fields.category);
  if (fields.userId) form.append('userId', String(fields.userId));
  if (fields.requestId) form.append('requestId', String(fields.requestId));
  form.append('file', file, file.name);
  return form;
}

export const hrRequestsApi = {
  /* ---- requests ---- */

  /** The queue: open first, then in progress, oldest first within each. */
  listRequests: (query: HrRequestQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<HrRequest>>(`${BASE}/requests${hrQuery(query)}`, { signal }),

  /** For the badge: new requests nobody has picked up, and those being worked on. */
  counts: (signal?: AbortSignal) =>
    adminRequest<{ open: number; inProgress: number }>(`${BASE}/requests/count`, { signal }),

  getRequest: (id: number, signal?: AbortSignal) =>
    adminRequest<HrRequestDetail>(`${BASE}/requests/${id}`, { signal }),

  /** One page of the timeline, oldest first. */
  comments: (id: number, query: { page: number; pageSize: number }, signal?: AbortSignal) =>
    adminRequest<HrPaginated<HrRequestComment>>(`${BASE}/requests/${id}/comments${hrQuery(query)}`, {
      signal,
    }),

  /**
   * Moves a request. A rejection needs a note. Resolving a profile update APPLIES it to
   * the employee's record; `applied` says what changed.
   */
  changeStatus: (id: number, status: 'in_progress' | 'resolved' | 'rejected', note?: string) =>
    adminRequest<{
      request: HrRequest;
      applied: { before: ProfileUpdatePayload; after: ProfileUpdatePayload } | null;
    }>(`${BASE}/requests/${id}/status`, {
      method: 'POST',
      body: note && note.trim() ? { status, note: note.trim() } : { status },
    }),

  addComment: (id: number, body: string) =>
    adminRequest<{ comment: HrRequestComment; request: HrRequest; deduplicated: boolean }>(
      `${BASE}/requests/${id}/comments`,
      { method: 'POST', body: { body } },
    ),

  /* ---- documents ---- */

  listDocuments: (query: HrDocumentQuery, signal?: AbortSignal) =>
    adminRequest<HrPaginated<HrDocument>>(`${BASE}/documents${hrQuery(query)}`, { signal }),

  /** Build the body with `hrDocumentFormData`. `recipients` is how many were notified. */
  uploadDocument: (form: FormData, signal?: AbortSignal) =>
    adminRequest<{ document: HrDocument; recipients: number }>(`${BASE}/documents`, {
      method: 'POST',
      body: form,
      signal,
    }),

  /**
   * A plain link, not a fetch. The download is a same-site GET, so the admin's session
   * cookie travels with it, and the browser streams the file (or follows the storage
   * redirect) without the page holding the bytes.
   */
  documentDownloadUrl: (id: number) => `${apiBaseUrl()}${BASE}/documents/${id}/download`,

  /** A soft delete: hidden everywhere and never served again. */
  removeDocument: (id: number) =>
    adminRequest<{ document: HrDocument }>(`${BASE}/documents/${id}`, { method: 'DELETE' }).then(
      (r) => r.document,
    ),

  /* ---- announcements ---- */

  broadcast: (body: { title: string; body?: string; departmentId?: number }) =>
    adminRequest<{ recipients: number }>(`${BASE}/notifications/broadcast`, {
      method: 'POST',
      body,
    }).then((r) => r.recipients),

  /** Departments, for the announcement audience. A bounded list. */
  listDepartments: (signal?: AbortSignal) =>
    adminRequest<{ items: HrDepartment[] }>(`${BASE}/departments`, { signal }).then((r) => r.items),
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** Bytes as KB or MB, the way the file field shows them. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** "PDF", "PNG", "JPEG" from the stored MIME type. */
export function documentTypeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/png') return 'PNG';
  if (mimeType === 'image/jpeg') return 'JPEG';
  return mimeType;
}

/**
 * Feedback before an upload, so a wrong file is caught without a round trip. The server
 * checks all of this again — and the bytes themselves — and its answer decides.
 */
export function checkHrDocumentFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!HR_DOCUMENT_UPLOAD.extensions.some((extension) => name.endsWith(extension))) {
    return 'Choose a PDF, PNG or JPEG file.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > HR_DOCUMENT_UPLOAD.maxSizeBytes) {
    return `This file is ${formatFileSize(file.size)}. The limit is ${HR_DOCUMENT_UPLOAD.maxSizeLabel}.`;
  }
  return null;
}

/** A title from a file name: "Offer letter - Priya.pdf" → "Offer letter - Priya". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}
