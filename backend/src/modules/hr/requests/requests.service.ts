import type { PoolConnection } from 'mysql2/promise';
import { withTransaction, type RowDataPacket } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { findHrUser } from '../hr.repository';
import type { Page } from '../hr.schema';
import { notifyHr, type HrNotificationKind } from '../notifications/hrNotifications.repository';
import { listDocuments } from './documents.repository';
import {
  countActiveForUser,
  findComment,
  findIdByClientKeyTx,
  findRecentCommentBy,
  findRequest,
  findRequestByClientKey,
  hasActiveProfileUpdateTx,
  insertCommentTx,
  insertRequestTx,
  listComments,
  lockHrUserTx,
  lockRequestTx,
  setStatusTx,
  touchRequestTx,
} from './requests.repository';
import {
  ACTIVE_REQUEST_STATUSES,
  PROFILE_UPDATE_COLUMNS,
  PROFILE_UPDATE_FIELDS,
  profileUpdatePayloadSchema,
  type CreateRequestInput,
  type HrDocument,
  type HrRequest,
  type HrRequestComment,
  type HrRequestStatus,
  type ProfileUpdateField,
  type ProfileUpdatePayload,
  type StatusChangeInput,
} from './requests.schema';

/**
 * HR requests: an employee asks, HR answers, and both sides can see the conversation.
 *
 * A request is a status plus a timeline. Every status change writes a timeline entry
 * (`status_from` → `status_to`), every entry bumps `last_activity_at`, and both happen
 * in the same transaction as the change — a timeline that can miss a step is worse than
 * none, because it is what both sides point at when they disagree about what happened.
 *
 * A PROFILE UPDATE is the one category with teeth. Its payload is the set of new
 * values, and RESOLVING it writes them to `hr_users` — in the same transaction as the
 * status change and the timeline entry. "Resolved" therefore always means "applied";
 * there is no state in which HR has said yes and the record still shows the old phone.
 */

/** How many timeline entries the detail view carries; the rest page on. */
const FIRST_COMMENT_PAGE = 20;

/**
 * Documents shared on one request, shown on its detail. A request collects a letter or
 * two, so the cap is generous; `documentsTotal` says if there are more, and the
 * paginated document list filters by `requestId` for the rest.
 */
const REQUEST_DOCUMENT_CAP = 50;

/** Open + in progress — the dashboard's "requests: { open }". */
export async function openRequestCount(userId: number): Promise<number> {
  return countActiveForUser(userId);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export type RequestDetail = {
  request: HrRequest;
  comments: Page<HrRequestComment>;
  documents: HrDocument[];
  documentsTotal: number;
};

/**
 * A request with the first page of its timeline and the documents shared on it.
 * `ownerId` scopes it to one employee (the app); without it, any request (the admin).
 */
export async function requestDetail(id: number, ownerId?: number): Promise<RequestDetail | null> {
  const request = await findRequest(id, ownerId);
  if (!request) return null;

  const [comments, documents] = await Promise.all([
    listComments(id, { page: 1, pageSize: FIRST_COMMENT_PAGE }),
    listDocuments({
      // The employee sees only what they may open; for a request's documents that is
      // every one of them, but the rule is applied rather than assumed.
      ...(ownerId === undefined ? {} : { viewerId: ownerId }),
      scope: 'all',
      requestId: id,
      page: 1,
      pageSize: REQUEST_DOCUMENT_CAP,
    }),
  ]);

  return { request, comments, documents: documents.items, documentsTotal: documents.total };
}

/**
 * The employee's CURRENT value for each field a profile update asks to change, so HR
 * reviews a diff rather than a list of new values. Null when it is not a profile update.
 */
export async function currentProfileValues(
  request: HrRequest,
): Promise<Partial<Record<ProfileUpdateField, string | null>> | null> {
  if (request.category !== 'profile_update' || !request.payload) return null;
  const profile = await findHrUser(request.userId);
  if (!profile) return null;

  const current: Partial<Record<ProfileUpdateField, string | null>> = {};
  for (const field of PROFILE_UPDATE_FIELDS) {
    if (request.payload[field] !== undefined) current[field] = profile[field] ?? null;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Raising                                                                     */
/* -------------------------------------------------------------------------- */

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY';
}

/**
 * Raises a request. Idempotent on `clientKey`: a replay returns the original with
 * `deduplicated: true`.
 *
 * ONE PROFILE UPDATE AT A TIME. Two open ones could ask for different phone numbers,
 * and whichever HR resolved second would silently win. MySQL has no partial unique
 * index to say "one open per person", so the check runs inside a transaction that
 * first LOCKS THE EMPLOYEE ROW: two submissions from one person queue on that lock, and
 * the second sees the first's request when it gets its turn.
 */
export async function createRequest(
  userId: number,
  input: CreateRequestInput,
): Promise<{ request: HrRequest; deduplicated: boolean }> {
  const replay = await findRequestByClientKey(userId, input.clientKey);
  if (replay) return { request: replay, deduplicated: true };

  let outcome: { id: number; deduplicated: boolean };
  try {
    outcome = await withTransaction(async (connection) => {
      if (!(await lockHrUserTx(connection, userId))) throw notFound('Your account could not be found.');

      // Re-checked under the lock: a concurrent replay of THIS submission committed while
      // we waited, and it is the same request, not a second profile update.
      const existing = await findIdByClientKeyTx(connection, userId, input.clientKey);
      if (existing !== null) return { id: existing, deduplicated: true };

      if (input.category === 'profile_update' && (await hasActiveProfileUpdateTx(connection, userId))) {
        throw badRequest(
          'You already have a profile update waiting for HR. Add a comment to that request, or cancel it and raise a new one.',
        );
      }

      const id = await insertRequestTx(connection, {
        userId,
        category: input.category,
        subject: input.subject,
        details: input.details,
        payload: input.payload,
        clientKey: input.clientKey,
      });
      return { id, deduplicated: false };
    });
  } catch (error) {
    // The unique key caught a replay the lock did not (it cannot, but the key is the
    // guarantee and this is its answer).
    if (!isDuplicateKey(error)) throw error;
    const original = await findRequestByClientKey(userId, input.clientKey);
    if (!original) throw error;
    return { request: original, deduplicated: true };
  }

  const request = await findRequest(outcome.id, userId);
  if (!request) throw new Error('A new HR request could not be read back.');

  if (!outcome.deduplicated) {
    logger.info('HR request raised', { id: request.id, userId, category: request.category });
  }
  return { request, deduplicated: outcome.deduplicated };
}

/* -------------------------------------------------------------------------- */
/* The conversation                                                            */
/* -------------------------------------------------------------------------- */

const CLOSED_MESSAGE = 'This request is closed. Raise a new request if you need anything else.';

export type CommentAuthor = { type: 'employee'; id: number } | { type: 'admin'; id: number; name: string };

/**
 * Adds a comment while the request is still open or in progress.
 *
 * A NEAR-DUPLICATE GUARD instead of a client key. `hr_request_comments` has no
 * idempotency column, and a phone that sent a comment and lost the response will send
 * it again. So an identical comment from the same author on the same request within
 * two minutes is answered with the first one (`deduplicated: true`) rather than posted
 * twice. Saying the same thing twice on purpose inside two minutes is not a real need.
 */
export async function addComment(
  requestId: number,
  author: CommentAuthor,
  body: string,
  ownerId?: number,
): Promise<{ comment: HrRequestComment; request: HrRequest; deduplicated: boolean }> {
  const before = await findRequest(requestId, ownerId);
  if (!before) throw notFound('Request not found.');
  if (!ACTIVE_REQUEST_STATUSES.includes(before.status)) throw badRequest(CLOSED_MESSAGE);

  const recent = await findRecentCommentBy(requestId, author);
  if (recent && recent.body === body) {
    return { comment: recent, request: before, deduplicated: true };
  }

  const commentId = await withTransaction(async (connection) => {
    const locked = await lockRequestTx(connection, requestId, ownerId);
    if (!locked) throw notFound('Request not found.');
    if (!ACTIVE_REQUEST_STATUSES.includes(locked.status)) throw badRequest(CLOSED_MESSAGE);

    const id = await insertCommentTx(connection, { requestId, author, body });
    await touchRequestTx(connection, requestId);
    return id;
  });

  const [comment, request] = await Promise.all([findComment(commentId), findRequest(requestId)]);
  if (!comment || !request) throw new Error('A new HR request comment could not be read back.');

  // An HR reply is something the employee is waiting on; their own comment is not news to them.
  if (author.type === 'admin') {
    await notifyHr({
      userIds: [request.userId],
      kind: 'request_updated',
      title: 'New reply from HR',
      body: `${request.subject}: ${body}`,
      entityType: 'request',
      entityId: request.id,
    });
  }

  return { comment, request, deduplicated: false };
}

/** The employee withdraws their own request. Only while it is open or in progress. */
export async function cancelRequest(requestId: number, userId: number): Promise<HrRequest> {
  await withTransaction(async (connection) => {
    const locked = await lockRequestTx(connection, requestId, userId);
    if (!locked) throw notFound('Request not found.');
    if (!ACTIVE_REQUEST_STATUSES.includes(locked.status)) {
      throw badRequest(
        locked.status === 'cancelled'
          ? 'You have already cancelled this request.'
          : 'HR has already closed this request, so it cannot be cancelled.',
      );
    }

    await setStatusTx(connection, { id: requestId, from: locked.status, to: 'cancelled' });
    await insertCommentTx(connection, {
      requestId,
      author: { type: 'employee', id: userId },
      body: null,
      statusFrom: locked.status,
      statusTo: 'cancelled',
    });
  });

  const request = await findRequest(requestId, userId);
  if (!request) throw notFound('Request not found.');
  logger.info('HR request cancelled', { id: requestId, userId });
  return request;
}

/* -------------------------------------------------------------------------- */
/* HR's decisions                                                              */
/* -------------------------------------------------------------------------- */

export type ProfileChange = {
  before: Partial<Record<ProfileUpdateField, string | null>>;
  after: Partial<Record<ProfileUpdateField, string | null>>;
};

export type StatusChangeResult = {
  request: HrRequest;
  from: HrRequestStatus;
  /** The fields written to the employee record when a profile update was resolved. */
  applied: ProfileChange | null;
};

/**
 * Writes a profile update's values to `hr_users`, inside the caller's transaction.
 *
 * The stored payload is validated AGAIN, against today's rules, before it is applied: it
 * is a JSON column, and whatever is in it now — not what was checked when it was
 * submitted — is what would be written to the record.
 */
async function applyProfileUpdateTx(
  connection: PoolConnection,
  userId: number,
  payload: ProfileUpdatePayload | null,
): Promise<ProfileChange> {
  const parsed = profileUpdatePayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw badRequest(
      `The details on this request can no longer be applied (${parsed.error.issues[0]?.message ?? 'they are not valid'}). Decline it and ask the employee to raise a new one.`,
    );
  }
  const values = parsed.data as ProfileUpdatePayload;
  const fields = PROFILE_UPDATE_FIELDS.filter((field) => values[field] !== undefined);

  // Locked, so the "before" in the audit trail is the value actually replaced.
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT phone, address, emergency_contact_name, emergency_contact_phone,
            DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth
       FROM hr_users WHERE id = ? FOR UPDATE`,
    [userId],
  );
  const current = rows[0];
  if (!current) throw notFound('The employee on this request no longer exists.');

  const before: ProfileChange['before'] = {};
  const after: ProfileChange['after'] = {};
  for (const field of fields) {
    const column = PROFILE_UPDATE_COLUMNS[field];
    before[field] = (current[column] as string | null) ?? null;
    after[field] = values[field] ?? null;
  }

  /*
   * Column names come from PROFILE_UPDATE_COLUMNS, a constant map — never from the
   * payload's keys — so this interpolation cannot name anything else.
   */
  await connection.execute(
    `UPDATE hr_users SET ${fields.map((field) => `${PROFILE_UPDATE_COLUMNS[field]} = ?`).join(', ')}
      WHERE id = ?`,
    [...fields.map((field) => values[field] ?? null), userId],
  );

  return { before, after };
}

const NOTICE: Record<'in_progress' | 'resolved' | 'rejected', { kind: HrNotificationKind; title: string }> = {
  in_progress: { kind: 'request_updated', title: 'HR is working on your request' },
  resolved: { kind: 'request_resolved', title: 'Your request has been resolved' },
  rejected: { kind: 'request_rejected', title: 'Your request was declined' },
};

/**
 * HR moves a request: in progress, resolved or rejected.
 *
 * The request row is LOCKED and its status checked inside the transaction, and the
 * UPDATE is guarded on that status as well, so two administrators deciding at once
 * cannot both win — the second is told it has already been decided.
 */
export async function changeStatus(
  requestId: number,
  input: StatusChangeInput,
  actor: { id: number; name: string },
): Promise<StatusChangeResult> {
  const outcome = await withTransaction(async (connection) => {
    const locked = await lockRequestTx(connection, requestId);
    if (!locked) throw notFound('Request not found.');

    if (locked.status === 'cancelled') throw badRequest('The employee cancelled this request.');
    if (locked.status === 'resolved' || locked.status === 'rejected') {
      throw badRequest('That request has already been decided.');
    }
    if (locked.status === input.status) throw badRequest('That request is already in progress.');

    const final = input.status === 'resolved' || input.status === 'rejected';

    const applied =
      input.status === 'resolved' && locked.category === 'profile_update'
        ? await applyProfileUpdateTx(connection, locked.userId, locked.payload)
        : null;

    const moved = await setStatusTx(connection, {
      id: requestId,
      from: locked.status,
      to: input.status,
      ...(final ? { decidedBy: { id: actor.id, name: actor.name, note: input.note } } : {}),
    });
    if (!moved) throw badRequest('That request has already been decided.');

    await insertCommentTx(connection, {
      requestId,
      author: { type: 'admin', id: actor.id, name: actor.name },
      body: input.note,
      statusFrom: locked.status,
      statusTo: input.status,
    });

    return { from: locked.status, applied, userId: locked.userId, subject: locked.subject };
  });

  const request = await findRequest(requestId);
  if (!request) throw notFound('Request not found.');

  const notice = NOTICE[input.status];
  await notifyHr({
    userIds: [outcome.userId],
    kind: notice.kind,
    title:
      input.status === 'resolved' && outcome.applied ? 'Your details have been updated' : notice.title,
    body: input.note ? `${outcome.subject}: ${input.note}` : outcome.subject,
    entityType: 'request',
    entityId: requestId,
  });

  logger.info('HR request status changed', {
    id: requestId,
    from: outcome.from,
    to: input.status,
    by: actor.id,
    applied: outcome.applied ? Object.keys(outcome.applied.after) : undefined,
  });

  return { request, from: outcome.from, applied: outcome.applied };
}
