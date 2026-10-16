import { z } from 'zod';
import { companyToday, isIsoDate } from '../calendar/calendar.service';
import { pageQuerySchema } from '../hr.schema';

/**
 * HR requests, shared documents and announcements — the request shapes and the records
 * the API returns (migration 029).
 */

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

export const HR_REQUEST_STATUSES = ['open', 'in_progress', 'resolved', 'rejected', 'cancelled'] as const;
export type HrRequestStatus = (typeof HR_REQUEST_STATUSES)[number];

/** Still waiting on somebody: the employee may comment and cancel, HR may decide. */
export const ACTIVE_REQUEST_STATUSES: readonly HrRequestStatus[] = ['open', 'in_progress'];

/**
 * List filters. Besides each status, `active` (open + in progress) and `closed`
 * (resolved, rejected, cancelled) — the two tabs an inbox actually has.
 */
export const HR_REQUEST_STATUS_FILTERS = [...HR_REQUEST_STATUSES, 'active', 'closed'] as const;
export type HrRequestStatusFilter = (typeof HR_REQUEST_STATUS_FILTERS)[number];

export const HR_DOCUMENT_CATEGORIES = ['policy', 'letter', 'contract', 'identity', 'payroll', 'other'] as const;
export type HrDocumentCategory = (typeof HR_DOCUMENT_CATEGORIES)[number];

export const HR_DOCUMENT_SCOPES = ['company', 'personal', 'all'] as const;
export type HrDocumentScope = (typeof HR_DOCUMENT_SCOPES)[number];

/* -------------------------------------------------------------------------- */
/* Profile updates                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The fields an employee may ask HR to change, and the `hr_users` column each one
 * writes. A fixed map, and the ONLY place a column name for a profile update comes
 * from: the apply step interpolates these names into its UPDATE, so nothing a client
 * sends can name a column. Role, department, manager and employment facts are not
 * here on purpose — those are HR's decisions, made in the admin portal.
 */
export const PROFILE_UPDATE_COLUMNS = {
  phone: 'phone',
  address: 'address',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  dateOfBirth: 'date_of_birth',
} as const;
export type ProfileUpdateField = keyof typeof PROFILE_UPDATE_COLUMNS;
export const PROFILE_UPDATE_FIELDS = Object.keys(PROFILE_UPDATE_COLUMNS) as ProfileUpdateField[];

/** The NEW values asked for. Only the keys present are changed; null clears a field. */
export type ProfileUpdatePayload = {
  phone?: string | null;
  address?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  dateOfBirth?: string;
};

/** The signup phone rule (`optionalPhoneField` in hr.schema), but keeping "absent" absent. */
const PHONE_PATTERN = /^[0-9+\-\s()]{6,20}$/;

const clearablePhone = z
  .union([z.string(), z.null()])
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || PHONE_PATTERN.test(value), {
    message: 'Enter a valid phone number.',
  })
  /*
   * `.optional()` OUTSIDE the transform, unlike `optionalPhoneField`, which turns a
   * missing value into null. Here missing means "leave it alone" and null means "clear
   * it", and collapsing the two would erase every field the employee did not mention.
   */
  .optional();

function clearableText(max: number, message: string, collapseSpaces: boolean) {
  return z
    .union([z.string(), z.null()])
    .transform((value) => {
      const raw = value ?? '';
      const cleaned = collapseSpaces ? raw.replace(/\s+/g, ' ').trim() : raw.trim();
      return cleaned.length === 0 ? null : cleaned;
    })
    .refine((value) => value === null || value.length <= max, { message })
    .optional();
}

export const profileUpdatePayloadSchema = z
  .object({
    phone: clearablePhone,
    // Addresses keep their line breaks; names do not need them.
    address: clearableText(400, 'Keep the address to 400 characters or fewer.', false),
    emergencyContactName: clearableText(120, 'Keep the name to 120 characters or fewer.', true),
    emergencyContactPhone: clearablePhone,
    dateOfBirth: z
      .string()
      .trim()
      .superRefine((value, context) => {
        if (!isIsoDate(value)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter the date as YYYY-MM-DD.' });
          return;
        }
        // Against the COMPANY calendar, not the server's — see calendar.service.
        if (value >= companyToday()) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Date of birth must be in the past.' });
        } else if (value < '1900-01-01') {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Check the year of birth.' });
        }
      })
      .optional(),
  })
  .refine((payload) => Object.values(payload).some((value) => value !== undefined), {
    message: 'Choose at least one detail to change.',
  });

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One submission is one request: the app generates this once per attempt and reuses it
 * on retry, and the unique key `(user_id, client_key)` turns a replay into the original.
 */
export const clientKeyField = z
  .string({ required_error: 'Missing request key. Please try again.' })
  .trim()
  .min(8, 'Missing request key. Please try again.')
  .max(64, 'Missing request key. Please try again.')
  .regex(/^[\x21-\x7e]+$/, 'Missing request key. Please try again.');

function optionalLongText(max: number, message: string) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= max, { message });
}

export const createRequestSchema = z
  .object({
    category: z.enum(HR_REQUEST_CATEGORIES, {
      errorMap: () => ({ message: 'Choose what the request is about.' }),
    }),
    subject: z
      .string({ required_error: 'Add a short subject.' })
      .transform((value) => value.replace(/\s+/g, ' ').trim())
      .pipe(
        z
          .string()
          .min(3, 'Add a short subject (at least 3 characters).')
          .max(160, 'Keep the subject to 160 characters or fewer.'),
      ),
    details: optionalLongText(2000, 'Keep the details to 2000 characters or fewer.'),
    payload: z.unknown().optional(),
    clientKey: clientKeyField,
  })
  .superRefine((value, context) => {
    const hasPayload = value.payload !== undefined && value.payload !== null;

    if (value.category !== 'profile_update') {
      if (hasPayload) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload'],
          message: 'Only a profile update request carries changed details.',
        });
      }
      return;
    }

    if (!hasPayload) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload'],
        message: 'Choose at least one detail to change.',
      });
      return;
    }

    const parsed = profileUpdatePayloadSchema.safeParse(value.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', ...issue.path],
          message: issue.message,
        });
      }
    }
  })
  .transform((value) => {
    /*
     * Parsed again for its OUTPUT (the trimmed values). `safeParse`, not `parse`: Zod
     * still runs a transform after a refinement has added issues, and a throw here
     * would escape `safeParse` as a 500 instead of the field errors already recorded.
     */
    const parsed =
      value.category === 'profile_update' ? profileUpdatePayloadSchema.safeParse(value.payload) : null;
    return {
      category: value.category,
      subject: value.subject,
      details: value.details,
      clientKey: value.clientKey,
      payload: parsed?.success ? (parsed.data as ProfileUpdatePayload) : null,
    };
  });
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const commentSchema = z.object({
  body: z
    .string({ required_error: 'Write a comment.' })
    .trim()
    .min(1, 'Write a comment.')
    .max(2000, 'Keep the comment to 2000 characters or fewer.'),
});

export const requestListQuerySchema = pageQuerySchema.extend({
  status: z.enum(HR_REQUEST_STATUS_FILTERS).optional(),
});

export const adminRequestListQuerySchema = requestListQuerySchema.extend({
  category: z.enum(HR_REQUEST_CATEGORIES).optional(),
  userId: z.coerce.number().int().positive().optional(),
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

/** What an administrator may move a request to. Cancelling is the employee's act. */
export const ADMIN_REQUEST_STATUSES = ['in_progress', 'resolved', 'rejected'] as const;

export const statusChangeSchema = z
  .object({
    status: z.enum(ADMIN_REQUEST_STATUSES, {
      errorMap: () => ({ message: 'Choose in progress, resolved or rejected.' }),
    }),
    note: optionalLongText(1000, 'Keep the note to 1000 characters or fewer.'),
  })
  .superRefine((value, context) => {
    // The employee reads this note as the reason; "rejected" with no reason is a wall.
    if (value.status === 'rejected' && !value.note) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Say why the request is being declined.',
      });
    }
  });
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An optional id from a multipart field or a JSON body: '' and null mean "none".
 * Multipart fields are always strings, hence the coercion.
 */
const optionalIdField = z.preprocess(
  (value) => (value === '' || value === null || value === 'null' ? undefined : value),
  z.coerce.number().int().positive('Choose a valid record.').optional(),
);

export const documentListQuerySchema = pageQuerySchema.extend({
  scope: z.enum(HR_DOCUMENT_SCOPES).default('all'),
  requestId: z.coerce.number().int().positive().optional(),
});

export const adminDocumentListQuerySchema = documentListQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

/** The text fields of the multipart upload. The file itself is `file`. */
export const uploadDocumentSchema = z.object({
  title: z
    .string({ required_error: 'Give the document a title.' })
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(2, 'Give the document a title.')
        .max(160, 'Keep the title to 160 characters or fewer.'),
    ),
  category: z.preprocess(
    (value) => (value === '' || value === undefined ? 'other' : value),
    z.enum(HR_DOCUMENT_CATEGORIES, { errorMap: () => ({ message: 'Choose a document category.' }) }),
  ),
  /** Omit for a company-wide document every employee can read. */
  userId: optionalIdField,
  requestId: optionalIdField,
});
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

/* -------------------------------------------------------------------------- */
/* Announcements                                                               */
/* -------------------------------------------------------------------------- */

export const broadcastSchema = z.object({
  title: z
    .string({ required_error: 'Add a title.' })
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(3, 'Add a title (at least 3 characters).')
        .max(160, 'Keep the title to 160 characters or fewer.'),
    ),
  body: optionalLongText(500, 'Keep the message to 500 characters or fewer.'),
  /** Only this department's employees. Omit (or null) for everyone. */
  departmentId: optionalIdField,
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;

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
  /** Whether the EMPLOYEE may still withdraw it (open or in progress). */
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
