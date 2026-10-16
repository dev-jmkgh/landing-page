import path from 'node:path';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { config } from '../config/env';
import { HttpError, badRequest } from '../utils/httpError';

/**
 * A document HR shares with employees — an offer letter, a policy, a scanned ID.
 *
 * Its own middleware, like the resume, lead-photo and lead-import uploads, because the
 * accepted formats and the wording differ. The same defence in depth:
 *   1. Extension allowlist          (.pdf, .png, .jpg, .jpeg)
 *   2. MIME allowlist, and the two must AGREE — a `.pdf` declared `image/png` is refused
 *   3. Size limit                   (`MAX_UPLOAD_MB`, the same budget as resumes)
 *   4. Generated storage key; the submitted name is kept for display only
 *   5. Magic-byte verification BEFORE anything is stored, so a mismatched file is never
 *      written anywhere and no row ever points at it
 *   6. Storage outside the web root, reachable only through an authenticated route or a
 *      five-minute HR file link
 *
 * Held in memory (bounded by the size limit) so the bytes can be checked before they are
 * written, and so either storage driver can take them.
 *
 * Every upload failure is translated HERE into a 400 on the `file` field. The central
 * error handler's multer branch answers with the resume field, which is the wrong field
 * for this form, and it stays as it is because resumes rely on it.
 */

type HrDocumentType = { extensions: string[]; mimeTypes: string[]; mimeType: string; magic: Buffer };

const TYPES: HrDocumentType[] = [
  {
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    mimeType: 'application/pdf',
    magic: Buffer.from('%PDF-', 'latin1'),
  },
  {
    extensions: ['.png'],
    mimeTypes: ['image/png'],
    mimeType: 'image/png',
    magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    extensions: ['.jpg', '.jpeg'],
    // `image/jpg` and `image/pjpeg` are non-standard but real: older browsers and some
    // Windows setups declare them for ordinary JPEGs.
    mimeTypes: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
    mimeType: 'image/jpeg',
    magic: Buffer.from([0xff, 0xd8, 0xff]),
  },
];

const WRONG_TYPE = 'Choose a PDF, PNG or JPEG file.';

function typeFor(originalName: string): HrDocumentType | null {
  const extension = path.extname(originalName).toLowerCase();
  return TYPES.find((type) => type.extensions.includes(extension)) ?? null;
}

/**
 * The verified file's canonical type and the extension to store it under.
 *
 * The stored MIME type comes from HERE — from what the bytes were checked to be — never
 * from the client's declaration, so a download is always served as what it really is.
 */
export function hrDocumentType(originalName: string): { extension: string; mimeType: string } | null {
  const type = typeFor(originalName);
  if (!type) return null;
  return { extension: path.extname(originalName).toLowerCase(), mimeType: type.mimeType };
}

/** True when the bytes begin with the signature their extension promises. */
export function verifyHrDocumentContents(buffer: Buffer, originalName: string): boolean {
  const type = typeFor(originalName);
  if (!type || buffer.length < type.magic.length + 4) return false;
  return buffer.subarray(0, type.magic.length).equals(type.magic);
}

/*
 * `defParamCharset: 'utf8'`: multer otherwise decodes the part's plain `filename=` as
 * Latin-1, and a browser sends UTF-8 there — so "Offer letter – Priya.pdf" would be
 * stored and offered back as mojibake. The option exists at runtime but is missing from
 * the type definitions, hence the widened type.
 */
const uploadOptions: multer.Options & { defParamCharset?: string } = {
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxBytes,
    files: 1,
    // title, category, userId, requestId — with room for a client that sends an extra.
    fields: 8,
    fieldSize: 4 * 1024,
    parts: 10,
  },
  fileFilter(_request, file, callback) {
    const type = typeFor(file.originalname);
    if (!type || !type.mimeTypes.includes(file.mimetype.toLowerCase())) {
      callback(badRequest('That file type is not accepted.', { file: WRONG_TYPE }));
      return;
    }
    callback(null, true);
  },
};

const upload = multer(uploadOptions).single('file');

function fileError(message: string): HttpError {
  return badRequest(message, { file: message });
}

function translateUploadError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return fileError(`The file is larger than ${config.uploads.maxSizeLabel}. Choose a smaller file.`);
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FIELD_COUNT':
      case 'LIMIT_PART_COUNT':
        return fileError('Upload one file in the "file" field.');
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_VALUE':
        return fileError('One of the details sent with the file is too long.');
      default:
        return fileError('The upload was interrupted. Try again.');
    }
  }

  // busboy's own failures ("Unexpected end of form") arrive as plain Errors: the body
  // did not arrive whole.
  return fileError('The upload was interrupted. Try again.');
}

/**
 * `multer.single('file')`, every failure mapped to a 400 on `file`, then the content
 * check. Leaves the verified upload on `request.file` and the text fields on
 * `request.body` (as strings — the route's schema coerces them).
 *
 * Mount it AFTER the role and CSRF checks, so a caller who may not upload is refused
 * before megabytes are buffered.
 */
export const uploadHrDocumentFile: RequestHandler = (request, response, next) => {
  upload(request, response, (error: unknown) => {
    if (error) {
      next(translateUploadError(error));
      return;
    }

    const file = request.file;
    if (!file) {
      next(fileError('Choose a file to upload.'));
      return;
    }

    if (!verifyHrDocumentContents(file.buffer, file.originalname)) {
      next(
        fileError(
          `This file is not a valid ${path.extname(file.originalname).slice(1).toUpperCase() || 'document'}. ${WRONG_TYPE}`,
        ),
      );
      return;
    }

    next();
  });
};
