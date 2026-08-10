import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config/env';
import { badRequest } from '../utils/httpError';
import { describeError, logger } from '../utils/logger';

/**
 * Resume upload handling.
 *
 * Defence in depth, because a file upload endpoint is the most attractive target on the
 * site:
 *   1. Extension allowlist        (.pdf, .doc, .docx)
 *   2. MIME type allowlist        (client-declared — treated as a hint, not proof)
 *   3. Size limit                 (MAX_UPLOAD_MB)
 *   4. Generated file name        (UUID + extension; the submitted name never touches disk)
 *   5. Magic-byte verification    (after write; mismatched files are deleted)
 *   6. Storage outside the web root, served only through an authenticated route
 */

const ALLOWED_EXTENSIONS = new Set<string>(config.uploads.allowedExtensions);
const ALLOWED_MIME_TYPES = new Set<string>(config.uploads.allowedMimeTypes);

/** Creates the upload directory once at startup. */
export function ensureUploadDirectory(): void {
  fs.mkdirSync(config.uploads.directory, { recursive: true });
}

const storage = multer.diskStorage({
  destination(_request, _file, callback) {
    callback(null, config.uploads.directory);
  },
  filename(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});

export const uploadResume = multer({
  storage,
  limits: {
    fileSize: config.uploads.maxBytes,
    files: 1,
    fields: 24,
    fieldSize: 8 * 1024,
    parts: 30,
  },
  fileFilter(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(
        badRequest('That file type is not accepted.', {
          resume: `Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
        }),
      );
      return;
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(
        badRequest('That file type is not accepted.', {
          resume: `Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
        }),
      );
      return;
    }

    callback(null, true);
  },
}).single('resume');

/** Leading bytes that a genuine file of each accepted type must begin with. */
const SIGNATURES: { extension: string; magic: Buffer[] }[] = [
  { extension: '.pdf', magic: [Buffer.from('%PDF')] },
  // DOCX is a ZIP container.
  { extension: '.docx', magic: [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])] },
  // Legacy DOC is an OLE compound file.
  { extension: '.doc', magic: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])] },
];

/**
 * Confirms the file's contents match its extension. A `.pdf` that is really a script
 * fails here and is deleted before anything is written to the database.
 */
export async function verifyResumeContents(filePath: string): Promise<boolean> {
  const extension = path.extname(filePath).toLowerCase();
  const expected = SIGNATURES.find((entry) => entry.extension === extension);
  if (!expected) return false;

  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    if (bytesRead === 0) return false;

    return expected.magic.some((magic) => buffer.subarray(0, magic.length).equals(magic));
  } catch (error) {
    logger.warn('Could not read uploaded file for verification', describeError(error));
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Best-effort cleanup used when a submission is rejected after the file was written. */
export async function removeUpload(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (error) {
    logger.warn('Could not remove rejected upload', describeError(error));
  }
}

/**
 * Resolves a stored file name to an absolute path, refusing anything that escapes the
 * upload directory (path traversal guard for the admin download route).
 */
export function resolveStoredFile(filename: string): string | null {
  const resolved = path.resolve(config.uploads.directory, filename);
  const root = path.resolve(config.uploads.directory);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
