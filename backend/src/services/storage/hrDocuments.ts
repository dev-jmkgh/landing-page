import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config/env';
import { describeError, logger } from '../../utils/logger';

/**
 * Where the documents HR shares are kept — offer letters, policies, payslip copies.
 *
 * The SAME two drivers and the same configuration as the resumes in `./index.ts`
 * (`STORAGE_DRIVER`, `S3_BUCKET`, `AWS_REGION`, `UPLOAD_DIR`), so a deployment that has
 * set up storage once has set it up for these too. What differs is the KEY SPACE, and
 * that is why this is a separate file rather than more calls to `putResume`:
 *
 * - Every key starts `hr-documents/`. On S3 it sits at the bucket root, BESIDE the
 *   resume prefix and not inside it: `S3_PREFIX` exists so resumes can carry their own
 *   lifecycle rule, and a rule written to expire old resumes must never be able to
 *   expire somebody's employment contract. (An instance role scoped to the resume prefix
 *   needs `hr-documents/*` added — see the deployment notes.)
 * - On the local driver the same key is a relative path under `UPLOAD_DIR`, so the files
 *   live in `<UPLOAD_DIR>/hr-documents/<yyyy>/<mm>/` — already outside the web root, and
 *   already wherever the deployment backs uploads up. The key is identical for both
 *   drivers, so moving a deployment from disk to S3 is a copy of that tree.
 * - Every operation refuses a key outside the prefix. Keys are generated here and never
 *   supplied by a client, but a database row is the one thing that could point this
 *   helper somewhere else — at a resume — so the boundary is checked at the boundary.
 *
 * NO CREDENTIALS ARE READ HERE, as in `./index.ts`: the S3 client uses the SDK's default
 * provider chain (environment, shared config, the EC2 instance role).
 */

export const HR_DOCUMENT_PREFIX = 'hr-documents';

/**
 * How long a presigned download stays valid. Short, as for resumes: the browser or the
 * phone's viewer follows it at once, and it grants read access to personal documents.
 * The HR app's own file link (five minutes) is checked and re-signed at click time, so
 * this does not need to outlive the click.
 */
const DOWNLOAD_URL_TTL_SECONDS = 60;

let s3: S3Client | null = null;

/*
 * Its own client rather than the one inside `./index.ts`, which is not exported. Same
 * region, same credential chain; a second client costs a few objects, and keeping
 * `index.ts` untouched keeps the resume path exactly as reviewed.
 */
function client(): S3Client {
  if (!s3) s3 = new S3Client({ region: config.storage.region });
  return s3;
}

const isS3 = () => config.storage.driver === 's3';

/** `hr-documents/<yyyy>/<mm>/<uuid><ext>` — the submitted file name never shapes a key. */
function buildKey(extension: string): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
  return `${HR_DOCUMENT_PREFIX}/${year}/${month}/${crypto.randomUUID()}${safeExtension}`;
}

function isOwnKey(key: string): boolean {
  return (
    key.startsWith(`${HR_DOCUMENT_PREFIX}/`) &&
    !key.includes('..') &&
    !key.includes('\\') &&
    /^[A-Za-z0-9/._-]+$/.test(key)
  );
}

/**
 * A key as an absolute path under the upload directory, or null when it would escape
 * it (or is not one of ours).
 */
function resolveLocal(key: string): string | null {
  if (!isOwnKey(key)) return null;
  const root = path.resolve(config.uploads.directory);
  const resolved = path.resolve(root, ...key.split('/'));
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Stores the bytes and returns the opaque key to keep in `hr_documents.storage_key`. */
export async function putHrDocument(input: {
  buffer: Buffer;
  extension: string;
  contentType: string;
}): Promise<{ key: string }> {
  const key = buildKey(input.extension);

  if (!isS3()) {
    const target = resolveLocal(key);
    if (!target) throw new Error('Generated HR document key failed path validation.');
    await mkdir(path.dirname(target), { recursive: true });
    // `wx`: a UUID collision is not going to happen, but if it did, failing beats
    // silently replacing somebody else's document.
    await writeFile(target, input.buffer, { flag: 'wx' });
    return { key };
  }

  await client().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: input.buffer,
      ContentType: input.contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
  return { key };
}

/**
 * True when downloads should be a redirect to a presigned URL (S3) rather than bytes
 * served by this process (local disk).
 */
export function hrDocumentsUseRedirect(): boolean {
  return isS3();
}

/**
 * The whole file. Null when it is missing.
 *
 * Read into memory rather than streamed because the HR app's file link hands back a
 * buffer (see `HrFileContent`). Bounded by the upload limit, a few megabytes. On S3 the
 * callers redirect to a presigned URL instead, so the S3 branch is a fallback.
 */
export async function readHrDocument(key: string): Promise<Buffer | null> {
  if (isS3()) {
    try {
      const result = await client().send(
        new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }),
      );
      if (!result.Body) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as Readable) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== 'NoSuchKey' && name !== 'NotFound') {
        logger.error('Could not read HR document from S3', { key, ...describeError(error) });
      }
      return null;
    }
  }

  const target = resolveLocal(key);
  if (!target) return null;
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

/** A read stream, for the admin download on the local driver. Null when it is missing. */
export async function openHrDocumentStream(
  key: string,
): Promise<{ stream: Readable; contentLength: number } | null> {
  const target = resolveLocal(key);
  if (!target) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    return { stream: fs.createReadStream(target), contentLength: info.size };
  } catch {
    return null;
  }
}

/**
 * A short-lived URL for the S3 driver. The content type and disposition are signed
 * into it, so the browser saves the file under its original name with the type the
 * server verified — not whatever was recorded on the object.
 */
export async function hrDocumentDownloadUrl(
  key: string,
  input: { contentDisposition: string; contentType: string },
): Promise<string | null> {
  if (!isOwnKey(key)) return null;
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ResponseContentDisposition: input.contentDisposition,
      ResponseContentType: input.contentType,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

/**
 * Best-effort removal. Used when the database row could not be written after the
 * bytes were stored, so no file is left that nothing points at. NOT used by the
 * admin "remove" action, which is a soft delete (see `documents.service.ts`).
 */
export async function deleteHrDocument(key: string | null | undefined): Promise<void> {
  if (!key || !isOwnKey(key)) return;
  try {
    if (!isS3()) {
      const target = resolveLocal(key);
      if (target) await unlink(target);
      return;
    }
    await client().send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
  } catch (error) {
    logger.warn('Could not remove stored HR document', { key, ...describeError(error) });
  }
}

/** For diagnostics: where documents go. Reports no credential. */
export function hrDocumentStorageReport() {
  return isS3()
    ? { driver: 's3' as const, bucket: config.storage.bucket, prefix: `${HR_DOCUMENT_PREFIX}/` }
    : { driver: 'local' as const, directory: path.join(config.uploads.directory, HR_DOCUMENT_PREFIX) };
}
