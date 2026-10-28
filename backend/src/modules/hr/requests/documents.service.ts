import type { Readable } from 'node:stream';
import { queryOne, withTransaction, type RowDataPacket } from '../../../db/pool';
import { hrDocumentType } from '../../../middleware/uploadHrDocument';
import {
  deleteHrDocument,
  hrDocumentDownloadUrl,
  hrDocumentsUseRedirect,
  openHrDocumentStream,
  putHrDocument,
  readHrDocument,
} from '../../../services/storage/hrDocuments';
import { badRequest } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { contentDisposition, type HrFileContent } from '../files/hrFileLinks';
import { notifyHr } from '../notifications/hrNotifications.repository';
import { notifyCurrentEmployees } from './announcements.service';
import {
  findDocumentById,
  findDocumentForEmployee,
  findLiveDocument,
  insertDocumentTx,
  softDeleteDocument,
  type StoredDocument,
} from './documents.repository';
import { insertCommentTx, lockRequestTx, touchRequestTx } from './requests.repository';
import type { HrDocument, UploadDocumentInput } from './requests.schema';

/**
 * Documents HR shares: who may have them, storing them, and handing them out.
 *
 * ACCESS IS ONE RULE, in one query (`findDocumentForEmployee`): not removed, and either
 * company-wide (`user_id IS NULL`) or the employee's own. Minting a link and following
 * it both ask it, so a document removed — or reassigned — between the two is gone by the
 * time the link is opened.
 */

/**
 * Opens a shared document for the employee a file link was minted for, or null when they
 * may not have it (removed, or belongs to somebody else). Called by `hrFileLinks.ts`.
 *
 * On S3 the answer is a redirect to a URL signed for a minute, so the bytes never pass
 * through this process; on the local driver it is the bytes themselves.
 */
export async function openDocumentForEmployee(
  documentId: number,
  userId: number,
): Promise<HrFileContent | null> {
  const document = await findDocumentForEmployee(documentId, userId);
  if (!document) return null;

  if (hrDocumentsUseRedirect()) {
    const url = await hrDocumentDownloadUrl(document.storageKey, {
      contentDisposition: contentDisposition(document.originalName),
      contentType: document.mimeType,
    });
    return url ? { kind: 'redirect', url } : null;
  }

  const body = await readHrDocument(document.storageKey);
  if (!body) {
    // The row says it exists and storage disagrees: worth a warning, not a 500.
    logger.warn('HR document missing from storage', { id: document.id, key: document.storageKey });
    return null;
  }
  return { kind: 'buffer', body, filename: document.originalName, mimeType: document.mimeType };
}

/** Whether the employee may have it — the check before a link is minted. */
export async function documentForEmployee(documentId: number, userId: number): Promise<HrDocument | null> {
  const document = await findDocumentForEmployee(documentId, userId);
  return document ? withoutKey(document) : null;
}

function withoutKey(document: StoredDocument): HrDocument {
  const { storageKey: _key, deletedAt: _deleted, ...record } = document;
  void _key;
  void _deleted;
  return record;
}

export type ShareResult = { document: HrDocument; recipients: number };

/**
 * Stores an uploaded document and tells the people who can now read it.
 *
 * Order matters:
 *   1. every reference is checked BEFORE the bytes are stored, so a refusal leaves
 *      nothing behind;
 *   2. the bytes are stored;
 *   3. the row (and, when it answers a request, the request's timeline entry) is
 *      written in one transaction — if that fails, the stored file is removed, so no
 *      object exists that no row points at;
 *   4. notifications go out last; they never fail the upload (`notifyHr` never throws).
 */
export async function shareDocument(input: {
  file: Express.Multer.File;
  fields: UploadDocumentInput;
  actor: { id: number; name: string };
}): Promise<ShareResult> {
  const { file, fields, actor } = input;
  let ownerId: number | null = fields.userId ?? null;

  if (ownerId !== null) {
    const owner = await queryOne<RowDataPacket & { id: number }>(
      // A deleted employee cannot be given new documents; their old ones stay listed.
      'SELECT id FROM hr_users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [ownerId],
    );
    if (!owner) throw badRequest('That employee does not exist.', { userId: 'Choose an employee from the list.' });
  }

  let request: { id: number; userId: number } | null = null;
  if (fields.requestId !== undefined) {
    const row = await queryOne<RowDataPacket & { id: number; user_id: number }>(
      'SELECT id, user_id FROM hr_requests WHERE id = ? LIMIT 1',
      [fields.requestId],
    );
    if (!row) throw badRequest('That request does not exist.', { requestId: 'Choose a request from the list.' });
    request = { id: Number(row.id), userId: Number(row.user_id) };

    if (ownerId !== null && ownerId !== request.userId) {
      throw badRequest('That request belongs to another employee.', {
        requestId: 'The request and the employee do not match.',
      });
    }
    /*
     * A document shared IN ANSWER to somebody's request is theirs. Leaving the owner
     * blank here would make an employee's letter company-wide — readable by everyone —
     * because the admin forgot to pick the name the request already carries.
     */
    ownerId = request.userId;
  }

  const type = hrDocumentType(file.originalname);
  // The upload middleware has already refused anything else; this is the type check.
  if (!type) throw badRequest('That file type is not accepted.', { file: 'Choose a PDF, PNG or JPEG file.' });

  const stored = await putHrDocument({
    buffer: file.buffer,
    extension: type.extension,
    contentType: type.mimeType,
  });

  let documentId: number;
  try {
    documentId = await withTransaction(async (connection) => {
      /*
       * The request row is locked FIRST, before the insert's foreign-key checks take
       * shared locks on the employee and the request. Resolving a profile update locks
       * request-then-employee; taking them here in the other order would let the two
       * deadlock when an upload and a decision land on the same request at once.
       */
      if (request) await lockRequestTx(connection, request.id);

      const id = await insertDocumentTx(connection, {
        userId: ownerId,
        title: fields.title,
        category: fields.category,
        storageKey: stored.key,
        originalName: file.originalname,
        mimeType: type.mimeType,
        sizeBytes: file.size,
        requestId: request?.id ?? null,
        uploadedBy: actor.id,
        uploadedByName: actor.name,
      });

      if (request) {
        // The request's timeline shows the document arriving, and its inbox moves up.
        await insertCommentTx(connection, {
          requestId: request.id,
          author: { type: 'admin', id: actor.id, name: actor.name },
          body: `Shared a document: ${fields.title}`,
        });
        await touchRequestTx(connection, request.id);
      }
      return id;
    });
  } catch (error) {
    await deleteHrDocument(stored.key);
    throw error;
  }

  const document = await findLiveDocument(documentId);
  if (!document) throw new Error('A shared document could not be read back.');

  const notification = {
    kind: 'document_shared' as const,
    title: `New document: ${fields.title}`,
    entityType: 'document',
    entityId: documentId,
  };

  const recipients =
    ownerId === null
      ? await notifyCurrentEmployees({ ...notification, body: 'HR shared a document with everyone.' })
      : await notifyHr({ ...notification, userIds: [ownerId], body: 'HR shared a document with you.' });

  logger.info('HR document shared', { id: documentId, scope: ownerId === null ? 'company' : 'personal', recipients });
  return { document: withoutKey(document), recipients };
}

export type AdminDownload =
  | { kind: 'stream'; stream: Readable; contentLength: number; filename: string; mimeType: string }
  | { kind: 'redirect'; url: string };

/**
 * The admin portal's download: a stream from disk, or a redirect to a signed S3 URL.
 * Null when the document is removed or its bytes are missing.
 */
export async function openDocumentForAdmin(
  documentId: number,
): Promise<{ document: HrDocument; download: AdminDownload } | null> {
  const document = await findLiveDocument(documentId);
  if (!document) return null;

  if (hrDocumentsUseRedirect()) {
    const url = await hrDocumentDownloadUrl(document.storageKey, {
      contentDisposition: contentDisposition(document.originalName),
      contentType: document.mimeType,
    });
    return url ? { document: withoutKey(document), download: { kind: 'redirect', url } } : null;
  }

  const opened = await openHrDocumentStream(document.storageKey);
  if (!opened) {
    logger.warn('HR document missing from storage', { id: document.id, key: document.storageKey });
    return null;
  }
  return {
    document: withoutKey(document),
    download: {
      kind: 'stream',
      stream: opened.stream,
      contentLength: opened.contentLength,
      filename: document.originalName,
      mimeType: document.mimeType,
    },
  };
}

/**
 * Removes a document — a SOFT delete. The row and the stored bytes stay: the row is the
 * record that the employee once had it, and keeping the bytes means a removal made in
 * error can be reversed by an engineer. Nothing lists, links or serves it again.
 *
 * Returns the document as it was, or null when it was not there (or already removed).
 */
export async function removeDocument(documentId: number): Promise<HrDocument | null> {
  const document = await findDocumentById(documentId);
  if (!document || document.deletedAt !== null) return null;
  const removed = await softDeleteDocument(documentId);
  return removed ? withoutKey(document) : null;
}
