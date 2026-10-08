import path from 'node:path';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { LEAD_IMPORT_LIMITS } from '../modules/telecalling/imports/leadImport.schema';
import { HttpError, badRequest } from '../utils/httpError';
import { logger } from '../utils/logger';

/**
 * The spreadsheet upload for a lead import (spec: Admin Module 4).
 *
 * A separate middleware from the resume and lead-photo uploads, for the same reason they
 * are separate from each other: different formats, a different size budget, and — here
 * — different error wording. Same defence in depth: an extension allowlist, a size
 * limit, the bytes held in memory and checked against the extension before anything
 * reads them, and the submitted name used for display only.
 *
 * Two deliberate differences:
 *
 * - The MIME type is a hint, logged and never enforced. Windows reports a .csv as
 *   `application/vnd.ms-excel`, and browsers commonly send `application/octet-stream` or
 *   nothing at all for a spreadsheet — copying the photo upload's strict MIME allowlist
 *   would refuse real files.
 * - Every upload error is translated HERE into a 400 naming the `file` field. The
 *   central error handler's multer branch answers with the resume field and the resume
 *   size limit, which would be the wrong field and the wrong number for this form, and
 *   it is left alone because resumes and lead photos rely on it.
 */

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

/** Five megabytes (the admin web mirrors it, for feedback before an upload). */
const MAX_BYTES = LEAD_IMPORT_LIMITS.maxBytes;

const WRONG_TYPE = 'Choose an Excel (.xlsx or .xls) or CSV file.';
const ONE_FILE = 'Upload one file in the "file" field.';
const INTERRUPTED = 'The upload was interrupted. Try again.';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
    // The preview's choices: default assignee, source and status, the sheet, the column
    // map, extra columns and the draft it replaces.
    fields: 8,
    fieldSize: 4 * 1024,
    parts: 10,
  },
  fileFilter(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(badRequest('That file type is not accepted.', { file: WRONG_TYPE }));
      return;
    }

    logger.debug('Lead import upload', { extension, mimetype: file.mimetype });
    callback(null, true);
  },
}).single('file');

function fileError(message: string): HttpError {
  return badRequest(message, { file: message });
}

/** Every way the upload itself can fail, as a 400 the import form can show by the field. */
function translateUploadError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return fileError('The file is larger than 5 MB. Split it into smaller files and import each one.');
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FIELD_COUNT':
      case 'LIMIT_PART_COUNT':
        return fileError(ONE_FILE);
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_VALUE':
        return fileError('One of the choices sent with the file is too long.');
      default:
        return fileError(INTERRUPTED);
    }
  }

  // busboy's own failures — "Unexpected end of form", a malformed part header — arrive as
  // plain Errors. All of them mean the body did not arrive whole.
  return fileError(INTERRUPTED);
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

/** Text that is really markup — a web page saved with a spreadsheet's name. */
function looksLikeMarkup(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  return head.startsWith('<');
}

/**
 * Confirms the bytes are what the extension claims, before any parser sees them.
 *
 * Returns the message to refuse with, or null.
 *
 * - .xlsx is a ZIP. An OLE header here almost always means a password-protected
 *   workbook — Excel wraps an encrypted .xlsx in the old compound-file container.
 * - .xls is an OLE compound file. Many web systems "export to Excel" as an HTML table or
 *   tab-separated text with an .xls name; those are told what they are.
 * - .csv must be text: no NUL bytes in the first 64 KB (unless it carries a UTF-16 byte
 *   order mark, where NULs are normal), and not a workbook with a .csv name.
 */
export function verifyLeadImportSignature(buffer: Buffer, originalName: string): string | null {
  if (buffer.length === 0) return 'The file is empty.';

  const extension = path.extname(originalName).toLowerCase();

  if (extension === '.xlsx') {
    if (startsWith(buffer, ZIP)) return null;
    if (startsWith(buffer, OLE)) {
      return 'This workbook is password-protected. Remove the password in Excel and try again.';
    }
    return 'This file is not a valid Excel workbook. Open it in Excel, save it again as .xlsx, and try again.';
  }

  if (extension === '.xls') {
    if (startsWith(buffer, OLE)) return null;
    if (startsWith(buffer, ZIP)) {
      return 'This file is really an .xlsx workbook. Rename it to end in .xlsx and try again.';
    }
    if (looksLikeMarkup(buffer)) {
      return 'This file is a web page saved with an .xls name, not a real Excel workbook. Open it in Excel and save it as .xlsx or .csv.';
    }
    return 'This file is not a valid Excel workbook. Open it in Excel, save it again as .xlsx, and try again.';
  }

  if (extension === '.csv') {
    if (startsWith(buffer, ZIP) || startsWith(buffer, OLE)) {
      return 'This is an Excel workbook saved with a .csv name. Rename it to .xlsx or .xls, or save it as CSV from Excel.';
    }
    const utf16 =
      buffer.length >= 2 &&
      ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
    if (!utf16 && buffer.subarray(0, 64 * 1024).includes(0)) {
      return 'This file is not a text CSV file. Save it from Excel as "CSV UTF-8" and try again.';
    }
    return null;
  }

  return WRONG_TYPE;
}

/**
 * `multer.single('file')`, with every failure mapped to a 400 on the `file` field, then
 * the content check. Leaves the verified upload on `request.file`.
 *
 * Mount it AFTER the role and CSRF checks and the rate limiter, so a caller who may not
 * import is refused before five megabytes are buffered.
 */
export const uploadLeadImportFile: RequestHandler = (request, response, next) => {
  upload(request, response, (error: unknown) => {
    if (error) {
      next(translateUploadError(error));
      return;
    }

    const file = request.file;
    if (!file) {
      next(fileError('Choose a file to check.'));
      return;
    }

    const problem = verifyLeadImportSignature(file.buffer, file.originalname);
    if (problem) {
      next(fileError(problem));
      return;
    }

    next();
  });
};
