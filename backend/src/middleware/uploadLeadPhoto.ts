import path from 'node:path';
import multer from 'multer';
import { badRequest } from '../utils/httpError';

/**
 * Photo of a hard-copy lead (spec: Mobile Module 4).
 *
 * A separate middleware from `uploadResume` rather than a shared one taking a config.
 * The two upload paths accept different formats, come from different clients, and have
 * different size budgets — folding them together would mean one allowlist covering both
 * documents and images, which is strictly more permissive than either needs to be.
 *
 * Same defence in depth as resumes:
 *   1. Extension allowlist
 *   2. MIME allowlist (client-declared — a hint, never proof)
 *   3. Size limit
 *   4. Generated file name; the submitted name is never used as a path
 *   5. Magic-byte verification before anything is written
 *   6. Storage outside the web root, reachable only through an authenticated route
 *
 * Held in memory, not streamed to disk, so the bytes are verified *before* being stored
 * rather than written and then deleted on failure. The size limit is what keeps that
 * bounded.
 */

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * Eight megabytes.
 *
 * Larger than a resume because a phone camera photo at reduced quality still runs to a
 * few megabytes, and the app compresses to roughly 0.6 quality before sending. Small
 * enough that an unbounded in-memory buffer cannot be used to exhaust the process.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export const uploadLeadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
    fields: 8,
    fieldSize: 8 * 1024,
    parts: 12,
  },
  fileFilter(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(
        badRequest('That file type is not accepted.', {
          photo: 'Attach a JPEG, PNG, WebP or HEIC image.',
        }),
      );
      return;
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(
        badRequest('That file type is not accepted.', {
          photo: 'Attach a JPEG, PNG, WebP or HEIC image.',
        }),
      );
      return;
    }

    callback(null, true);
  },
}).single('photo');

/**
 * Leading bytes a genuine image of each accepted type must begin with.
 *
 * WebP and HEIC are container formats whose signature is not at offset zero — WebP is
 * `RIFF....WEBP` and HEIC is `....ftypheic` — so they are checked separately below
 * rather than as a simple prefix.
 */
const PREFIX_SIGNATURES: { extensions: string[]; magic: Buffer[] }[] = [
  {
    extensions: ['.jpg', '.jpeg'],
    magic: [Buffer.from([0xff, 0xd8, 0xff])],
  },
  {
    extensions: ['.png'],
    magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  },
];

/**
 * Confirms the bytes match the extension.
 *
 * An image is the one upload type where "it is really a script" matters most, because
 * the file is later served back to an admin's browser. This runs before the object is
 * stored and before any database row exists, so a mismatch is never written anywhere.
 */
export function verifyLeadPhotoContents(buffer: Buffer, originalName: string): boolean {
  if (buffer.length < 12) return false;

  const extension = path.extname(originalName).toLowerCase();
  const head = buffer.subarray(0, 16);

  const prefix = PREFIX_SIGNATURES.find((entry) => entry.extensions.includes(extension));
  if (prefix) {
    return prefix.magic.some((magic) => head.subarray(0, magic.length).equals(magic));
  }

  if (extension === '.webp') {
    // RIFF____WEBP — the four size bytes at offset 4 are skipped.
    return (
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP'
    );
  }

  if (extension === '.heic') {
    // ____ftyp<brand>, where the brand is one of the HEIF family.
    if (head.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
    const brand = head.subarray(8, 12).toString('latin1');
    return ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
  }

  return false;
}

/** Content type to store against the verified bytes, derived from the extension. */
export function leadPhotoContentType(originalName: string): string {
  switch (path.extname(originalName).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.heic':
      return 'image/heic';
    default:
      return 'image/jpeg';
  }
}
