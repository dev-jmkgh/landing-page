import path from 'node:path';
import multer from 'multer';
import { config } from '../config/env';
import { badRequest } from '../utils/httpError';

/**
 * Resume upload handling.
 *
 * Defence in depth, because a file upload endpoint is the most attractive target on the
 * site:
 *   1. Extension allowlist        (.pdf, .doc, .docx)
 *   2. MIME type allowlist        (client-declared — treated as a hint, not proof)
 *   3. Size limit                 (MAX_UPLOAD_MB)
 *   4. Generated file name        (UUID + extension; the submitted name is never a path)
 *   5. Magic-byte verification    (before storing; a mismatch is never written anywhere)
 *   6. Storage outside the web root — a private bucket, or a directory the web server
 *      does not serve — reachable only through an authenticated route
 *
 * The file is held in memory rather than written to disk on arrival. That is what lets
 * the same code path store to either destination, and it improves the order of
 * operations: the bytes are verified *before* anything is written, instead of being
 * written, checked, and deleted again on failure. The size limit below is what keeps
 * "in memory" bounded.
 */

const ALLOWED_EXTENSIONS = new Set<string>(config.uploads.allowedExtensions);
const ALLOWED_MIME_TYPES = new Set<string>(config.uploads.allowedMimeTypes);

export const uploadResume = multer({
  storage: multer.memoryStorage(),
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
 * Confirms the bytes match the extension. A `.pdf` that is really a script fails here,
 * before it is stored anywhere and before any database row exists.
 */
export function verifyResumeContents(buffer: Buffer, originalName: string): boolean {
  const extension = path.extname(originalName).toLowerCase();
  const expected = SIGNATURES.find((entry) => entry.extension === extension);
  if (!expected) return false;
  if (buffer.length === 0) return false;

  const head = buffer.subarray(0, 8);
  return expected.magic.some((magic) => head.subarray(0, magic.length).equals(magic));
}
