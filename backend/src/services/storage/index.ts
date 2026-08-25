import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config/env';
import { describeError, logger } from '../../utils/logger';

/**
 * Where resumes are kept.
 *
 * Two drivers behind one interface: the local disk, and an S3 bucket. What the rest of
 * the application holds either way is an opaque *key* — the value stored in
 * `applications.resume_filename` — which is a file name for the local driver and an
 * object key for S3. Nothing outside this module needs to know which.
 *
 * S3 is the better home on a single EC2 box for a reason that has nothing to do with
 * scale: the instance's disk is the one part of that deployment with no backup. A
 * terminated instance takes every resume with it, and the nightly mysqldump does not
 * cover them. Objects in a bucket outlive the server.
 *
 * NO CREDENTIALS ARE READ HERE. The S3Client is constructed without a `credentials`
 * argument, which engages the AWS SDK's default provider chain — environment, shared
 * config, then the EC2 instance role — exactly as the mailer's SES client does.
 */

export type StoredResume = {
  /** Opaque handle stored in the database. */
  key: string;
};

export type PresignedUpload = {
  key: string;
  url: string;
  /** Headers the browser MUST send, because they are part of what was signed. */
  headers: Record<string, string>;
  expiresInSeconds: number;
};

export type ResumeHead = {
  contentLength: number;
  contentType?: string;
};

/**
 * How long an upload URL stays valid. Long enough for a slow connection to finish a
 * five-megabyte file, short enough that a leaked URL is worth little.
 */
const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * How long a download URL stays valid. Shorter: the admin's browser follows it
 * immediately, and unlike the upload it grants read access to someone's personal data.
 */
const DOWNLOAD_URL_TTL_SECONDS = 60;

export type OpenedResume = {
  stream: Readable;
  contentLength?: number;
  contentType?: string;
};

let s3: S3Client | null = null;

function client(): S3Client {
  if (!s3) s3 = new S3Client({ region: config.storage.region });
  return s3;
}

const isS3 = () => config.storage.driver === 's3';

/**
 * Object keys are `<prefix>/<yyyy>/<mm>/<uuid><ext>`.
 *
 * The date segments are not decoration: they make a bucket lifecycle rule that expires
 * resumes after a retention period expressible as a prefix, and they stop a single
 * flat prefix accumulating every object ever uploaded. The UUID is what actually names
 * the file — the applicant's own file name never becomes part of a key, so nothing a
 * submitter controls can shape a path.
 */
function buildKey(extension: string): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const name = `${crypto.randomUUID()}${extension}`;
  const prefix = config.storage.prefix.replace(/^\/+|\/+$/g, '');
  return isS3() ? [prefix, year, month, name].filter(Boolean).join('/') : name;
}

/** Creates the local upload directory. A no-op on S3. */
export async function ensureStorageReady(): Promise<void> {
  if (isS3()) return;
  await mkdir(config.uploads.directory, { recursive: true });
}

/**
 * Resolves a local key to an absolute path, refusing anything that escapes the upload
 * directory. Keys are generated here and never supplied by a client, but this is the
 * boundary a traversal would have to cross, so it is checked at the boundary.
 */
function resolveLocal(key: string): string | null {
  const resolved = path.resolve(config.uploads.directory, key);
  const root = path.resolve(config.uploads.directory);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function putResume(input: {
  buffer: Buffer;
  extension: string;
  contentType: string;
}): Promise<StoredResume> {
  const key = buildKey(input.extension);

  if (!isS3()) {
    const target = resolveLocal(key);
    if (!target) throw new Error('Generated storage key failed path validation.');
    await writeFile(target, input.buffer);
    return { key };
  }

  await client().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: input.buffer,
      ContentType: input.contentType,
      // Encrypted at rest by default. SSE-S3 needs no key management; a bucket with a
      // KMS default will override this with its own policy.
      ServerSideEncryption: 'AES256',
    }),
  );

  return { key };
}

/** Opens a stored resume for streaming. Returns null when it no longer exists. */
export async function openResume(key: string): Promise<OpenedResume | null> {
  if (!isS3()) {
    const target = resolveLocal(key);
    if (!target || !fs.existsSync(target)) return null;
    return { stream: fs.createReadStream(target), contentLength: fs.statSync(target).size };
  }

  try {
    const result = await client().send(
      new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }),
    );
    if (!result.Body) return null;
    return {
      stream: result.Body as Readable,
      ...(result.ContentLength === undefined ? {} : { contentLength: result.ContentLength }),
      ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
    };
  } catch (error) {
    // A missing object is an expected outcome here, not a fault worth an error log.
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    logger.error('Could not read resume from S3', { key, ...describeError(error) });
    return null;
  }
}

/** Best-effort cleanup when a submission is rejected after the file was stored. */
export async function deleteResume(key: string | undefined): Promise<void> {
  if (!key) return;

  try {
    if (!isS3()) {
      const target = resolveLocal(key);
      if (target) await unlink(target);
      return;
    }
    await client().send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
  } catch (error) {
    logger.warn('Could not remove stored resume', { key, ...describeError(error) });
  }
}

/** For diagnostics and startup logging. Reports no credential of any kind. */
export function storageReport() {
  return isS3()
    ? { driver: 's3' as const, bucket: config.storage.bucket, region: config.storage.region, prefix: config.storage.prefix }
    : { driver: 'local' as const, directory: config.uploads.directory };
}

/* -------------------------------------------------------------------------- */
/* Presigned URLs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A URL the browser can PUT the resume to directly, so the bytes never pass through
 * this server.
 *
 * WHAT IS SIGNED IS WHAT IS ALLOWED. The key, the exact content type and the exact
 * content length are all part of the signature, so the holder of this URL can upload
 * one object, of one size, of one type, to one key that this server chose — and
 * nothing else. Change any of those at upload time and S3 rejects the request.
 *
 * That matters because the endpoint issuing these is public: the careers form is open
 * to anyone. Without the pinned length and type, a presigned PUT is an anonymous write
 * grant to the bucket.
 *
 * It does NOT prove the bytes are a real PDF — a client can still send anything of the
 * right size with the right declared type. That is what `headResume` and the magic-byte
 * check after submission are for: the file is verified once it is in the bucket and
 * before its row is written.
 */
export async function createUploadUrl(input: {
  extension: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedUpload> {
  const key = buildKey(input.extension);

  const url = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ServerSideEncryption: 'AES256',
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return {
    key,
    url,
    headers: {
      'Content-Type': input.contentType,
      'x-amz-server-side-encryption': 'AES256',
    },
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

/**
 * Strips the two characters that could break out of the quoted filename in a
 * Content-Disposition header. The value is signed into the URL, so a stray quote would
 * corrupt the header S3 returns rather than merely look untidy.
 */
function sanitiseDownloadName(name: string): string {
  return name.replace(new RegExp('["' + String.fromCharCode(92) + ']', 'g'), '').trim() || 'resume';
}

/**
 * A short-lived URL for an admin to download a stored resume.
 *
 * `ResponseContentDisposition` is signed too, so the browser saves the file under the
 * applicant's original name rather than the UUID the object is keyed by.
 */
export async function createDownloadUrl(key: string, downloadName: string): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${sanitiseDownloadName(downloadName)}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

/** Size and type of a stored object, or null when it does not exist. */
export async function headResume(key: string): Promise<ResumeHead | null> {
  if (!isS3()) {
    const target = resolveLocal(key);
    if (!target || !fs.existsSync(target)) return null;
    return { contentLength: fs.statSync(target).size };
  }

  try {
    const result = await client().send(
      new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }),
    );
    return {
      contentLength: result.ContentLength ?? 0,
      ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    logger.error('Could not stat resume in S3', { key, ...describeError(error) });
    return null;
  }
}

/**
 * Reads the first bytes of a stored object.
 *
 * A ranged GET, so verifying a file the browser uploaded directly costs eight bytes of
 * transfer rather than five megabytes. This is what keeps the magic-byte check alive
 * once the server is no longer in the upload path.
 */
export async function readResumeHead(key: string, bytes = 8): Promise<Buffer | null> {
  if (!isS3()) {
    const target = resolveLocal(key);
    if (!target || !fs.existsSync(target)) return null;
    const handle = await fs.promises.open(target, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  try {
    const result = await client().send(
      new GetObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
      }),
    );
    if (!result.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as Readable) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (error) {
    logger.warn('Could not read resume header from S3', { key, ...describeError(error) });
    return null;
  }
}

/** True when direct-to-bucket uploads are available. */
export function supportsPresignedUpload(): boolean {
  return isS3();
}

/* -------------------------------------------------------------------------- */
/* Claim tokens                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Proof that this server issued the upload URL for a given key.
 *
 * Without it, presigning has a hole that proxying does not: the submission carries an
 * object key chosen by the client, so anyone could submit *another applicant's* key and
 * attach that person's resume to their own application — a straightforward way to read
 * a file they were never given. The key is therefore returned with an HMAC over
 * `key.expiry`, and the submission is only accepted if the pair still verifies.
 *
 * Signed with the same secret as admin sessions, which is already required to be long
 * and random in production.
 */
const CLAIM_TTL_MS = 30 * 60 * 1000;

function claimSignature(payload: string): string {
  return crypto.createHmac('sha256', config.admin.jwtSecret).update(payload).digest('base64url');
}

export function createUploadClaim(key: string): string {
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  const payload = `${key}.${expiresAt}`;
  return `${expiresAt}.${claimSignature(payload)}`;
}

export function verifyUploadClaim(key: string, claim: string): boolean {
  const separator = claim.indexOf('.');
  if (separator <= 0) return false;

  const expiresAt = Number(claim.slice(0, separator));
  const signature = claim.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = claimSignature(`${key}.${expiresAt}`);
  // Constant-time: a length mismatch would throw, so that is checked first.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/* -------------------------------------------------------------------------- */
/* Email download links                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A link the admin notification can carry, which works without signing in.
 *
 * This is a bearer credential: whoever holds the URL can download the resume. That is
 * inherent to what an unauthenticated link is, and it is a deliberate trade — the same
 * email already carries the resume as an attachment, so the link does not widen access
 * beyond the inbox that was already going to receive the file. What it must not do is
 * last forever or be guessable, so it carries an expiry and an HMAC over the pair.
 *
 * It points at this API rather than straight at S3 on purpose. A presigned S3 URL made
 * with instance-role credentials dies when the underlying session token expires — often
 * within hours — which would leave a dead link in an email an admin opens the next
 * morning. Signing our own link and minting a fresh presigned URL at click time avoids
 * that entirely, and keeps the download inside something that can log it.
 */
const EMAIL_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function createResumeLink(applicationId: number): string {
  const expiresAt = Date.now() + EMAIL_LINK_TTL_MS;
  const signature = claimSignature(`resume.${applicationId}.${expiresAt}`);
  const query = new URLSearchParams({ e: String(expiresAt), t: signature });
  return `${config.apiPublicUrl}/api/careers/resume/${applicationId}?${query.toString()}`;
}

export function verifyResumeLink(applicationId: number, expiresAt: string, token: string): boolean {
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const expected = claimSignature(`resume.${applicationId}.${expiry}`);
  if (expected.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
