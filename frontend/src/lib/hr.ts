import { adminRequest } from './api';

/**
 * The HR admin API.
 *
 * Deliberately a separate module from `telecalling.ts`, mirroring the backend split. HR
 * accounts live in their own table with their own roles (backend migration 017), and the
 * two products' vocabularies must stay free to diverge — importing `EmployeeRole` from
 * the telecalling module would mean adding a telecalling role silently changed what this
 * screen believes an HR employee can be.
 *
 * The transport is still shared: everything here goes through `adminRequest`, so there is
 * exactly one place that knows how to talk to the API and carry the session cookie.
 *
 * Note the direction of access. The HR *app* cannot reach telecalling and vice versa, but
 * an ADMINISTRATOR manages both — so this calls `/api/admin/hr/*` with the same admin
 * session the telecalling screens use. That was never what the separation forbade.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mirrored by hand from `backend/src/modules/hr/hr.schema.ts`.
 *
 * Kept in step by the compiler: when a role is added on the server, add it here and every
 * label map that needs updating stops compiling.
 */
export const HR_ROLES = ['employee', 'hr_manager', 'hr_admin'] as const;
export type HrRole = (typeof HR_ROLES)[number];

/**
 * Explicit labels rather than a generic de-snake-casing helper, which would render
 * `hr_admin` as "Hr admin" — a lowercase acronym nobody says out loud.
 */
export const HR_ROLE_LABELS: Record<HrRole, string> = {
  employee: 'Employee',
  hr_manager: 'HR manager',
  hr_admin: 'HR administrator',
};

export const HR_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type HrApprovalStatus = (typeof HR_APPROVAL_STATUSES)[number];

/** Exactly what `GET /api/admin/hr/registrations` returns per row. */
export type HrEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  phone: string | null;
  role: HrRole;
  isActive: boolean;
  approvalStatus: HrApprovalStatus;
  rejectionReason: string | null;
  /** Null until the applicant entered the code emailed to them. */
  emailVerifiedAt: string | null;
  registeredAt: string | null;
  approvedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
};

export type HrPaginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const BASE = '/admin/hr';

type QueryValue = string | number | boolean | undefined | null;

function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

export const hrApi = {
  listEmployees: (
    query: {
      page?: number;
      pageSize?: number;
      approval?: HrApprovalStatus | 'all';
      q?: string;
    },
    signal?: AbortSignal,
  ) => adminRequest<HrPaginated<HrEmployee>>(`${BASE}/registrations${qs(query)}`, { signal }),

  /**
   * Just the count, for the sidebar badge.
   *
   * Separate from the list so the number stays right while an administrator is looking at
   * the Employees tab — deriving it from a list total would only be correct on the one tab
   * where a badge is redundant.
   */
  pendingCount: (signal?: AbortSignal) =>
    adminRequest<{ pending: number }>(`${BASE}/registrations/count`, { signal }).then(
      (r) => r.pending,
    ),

  approve: (id: number) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/registrations/${id}/approve`, {
      method: 'POST',
    }).then((r) => r.employee),

  /**
   * Reject, optionally saying why.
   *
   * The reason travels to the applicant verbatim on the app's waiting screen, and it is
   * the only message they ever get — which is why the panel asks for one rather than
   * rejecting silently.
   */
  reject: (id: number, reason: string | null) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/registrations/${id}/reject`, {
      method: 'POST',
      body: { reason },
    }).then((r) => r.employee),

  /**
   * Switch an approved account off, or back on.
   *
   * Deactivating revokes every device server-side, so it takes effect within one
   * access-token lifetime rather than whenever the handset next signs out.
   */
  setActive: (id: number, active: boolean) =>
    adminRequest<{ employee: HrEmployee }>(`${BASE}/users/${id}/active`, {
      method: 'POST',
      body: { active },
    }).then((r) => r.employee),
};
