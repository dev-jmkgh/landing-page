import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { applicationLimiter } from '../../middleware/rateLimit';
import { uploadResume, verifyResumeContents } from '../../middleware/upload';
import { config } from '../../config/env';
import {
  createDownloadUrl,
  createUploadClaim,
  createUploadUrl,
  deleteResume,
  headResume,
  openResume,
  putResume,
  readResumeHead,
  supportsPresignedUpload,
  verifyUploadClaim,
  verifyResumeLink,
} from '../../services/storage';
import { toFieldErrors } from '../../middleware/validate';
import { notFound, validationFailed } from '../../utils/httpError';
import { clientIp } from '../../utils/request';
import { deliveryMessage } from '../../services/deliveryStatus';
import { applicationSchema } from './application.schema';
import { createApplication, type ResumeFile } from './application.service';
import { findApplication } from './application.repository';
import { logger } from '../../utils/logger';

export const applicationRouter = Router();

const ALLOWED_EXTENSIONS = new Set<string>(config.uploads.allowedExtensions);
const ALLOWED_MIME_TYPES = new Set<string>(config.uploads.allowedMimeTypes);

const INVALID_CONTENTS = {
  resume: 'That file does not appear to be a valid PDF or Word document.',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Resolves the resume for a submission, from whichever route it took, and returns it in
 * the shape the service stores.
 */
async function intakeResume(
  body: Record<string, unknown>,
  file: Express.Multer.File | undefined,
): Promise<ResumeFile> {
  const claimedKey = typeof body.resumeKey === 'string' ? body.resumeKey : '';
  const claimToken = typeof body.resumeToken === 'string' ? body.resumeToken : '';

  if (claimedKey) {
    /**
     * The key came from the client, so it proves nothing on its own — without the token
     * a submission could name another applicant's object and attach their resume to
     * this application. The HMAC is what ties this key to an upload URL this server
     * issued, within the last half hour.
     */
    if (!verifyUploadClaim(claimedKey, claimToken)) {
      throw validationFailed({ resume: 'That upload has expired. Please attach the file again.' });
    }

    const head = await headResume(claimedKey);
    if (!head) {
      throw validationFailed({ resume: 'The uploaded file could not be found. Please try again.' });
    }
    if (head.contentLength <= 0 || head.contentLength > config.uploads.maxBytes) {
      await deleteResume(claimedKey);
      throw validationFailed({ resume: `Maximum file size is ${config.uploads.maxSizeLabel}.` });
    }

    const originalName = typeof body.resumeName === 'string' ? body.resumeName : 'resume';
    const extension = extensionOf(originalName);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      await deleteResume(claimedKey);
      throw validationFailed({
        resume: `Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
      });
    }

    // The bytes, not the declared type — read back out of the bucket, eight of them.
    const header = await readResumeHead(claimedKey);
    if (!header || !verifyResumeContents(header, originalName)) {
      await deleteResume(claimedKey);
      throw validationFailed(INVALID_CONTENTS);
    }

    return {
      storedName: claimedKey,
      originalName,
      mimeType: head.contentType ?? 'application/octet-stream',
      size: head.contentLength,
    };
  }

  if (!file) {
    throw validationFailed({ resume: 'Please attach your resume.' });
  }

  // The declared MIME type is a hint; the file's own bytes are the proof.
  if (!verifyResumeContents(file.buffer, file.originalname)) {
    throw validationFailed(INVALID_CONTENTS);
  }

  const stored = await putResume({
    buffer: file.buffer,
    extension: extensionOf(file.originalname),
    contentType: file.mimetype,
  });

  return {
    storedName: stored.key,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    buffer: file.buffer,
  };
}

/**
 * POST /api/careers/resume-upload-url
 *
 * Issues a presigned PUT so the browser can send the file straight to the bucket. The
 * response carries a claim token that the submission must present alongside the key.
 *
 * Public, like the form it serves, and therefore rate limited on the same bucket as the
 * application endpoint. What it can grant is deliberately narrow: one object, at one
 * key this server chose, of one exact size and type, for five minutes.
 */
applicationRouter.post(
  '/resume-upload-url',
  applicationLimiter,
  asyncHandler(async (request, response) => {
    if (!supportsPresignedUpload()) {
      // Not an error — the client falls back to posting the file with the form.
      response.status(200).json({ supported: false });
      return;
    }

    const filename = typeof request.body?.filename === 'string' ? request.body.filename : '';
    const contentType = typeof request.body?.contentType === 'string' ? request.body.contentType : '';
    const size = Number(request.body?.size);

    const extension = extensionOf(filename);
    if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(contentType)) {
      throw validationFailed({
        resume: `Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}.`,
      });
    }
    if (!Number.isFinite(size) || size <= 0 || size > config.uploads.maxBytes) {
      throw validationFailed({ resume: `Maximum file size is ${config.uploads.maxSizeLabel}.` });
    }

    const upload = await createUploadUrl({ extension, contentType, contentLength: size });

    response.status(200).json({
      supported: true,
      key: upload.key,
      token: createUploadClaim(upload.key),
      url: upload.url,
      headers: upload.headers,
      expiresInSeconds: upload.expiresInSeconds,
    });
  }),
);

/**
 * POST /api/careers/apply  (multipart/form-data)
 * POST /api/applications   — the original path, still accepted.
 *
 * Multer writes the file before the text fields can be validated, so every failure path
 * below deletes the uploaded file — a rejected application never leaves a file behind.
 */
applicationRouter.post(
  ['/', '/apply'],
  applicationLimiter,
  uploadResume,
  asyncHandler(async (request, response) => {
    const file = request.file;
    // Set once the resume is in storage, so every failure path below can remove it.
    let storedKey: string | undefined;

    try {
      const parsed = applicationSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(toFieldErrors(parsed.error));

      /**
       * Two ways a resume arrives.
       *
       * The browser may have uploaded it straight to the bucket with a presigned URL,
       * in which case the request carries only a key and the token proving this server
       * issued it. Otherwise the file itself is in the request and is stored here.
       *
       * Either way the bytes are verified before a row is written: the presigned path
       * reads the first eight bytes back out of the bucket rather than taking the
       * client's word for what it uploaded.
       */
      const resume = await intakeResume(request.body, file);
      storedKey = resume.storedName;

      const result = await createApplication(
        parsed.data,
        resume,
        {
          ipAddress: clientIp(request),
          userAgent: request.get('user-agent'),
        },
      );

      // The application and its resume are stored either way; the message reflects
      // what happened to the email rather than claiming a delivery that may not
      // have occurred.
      response.status(201).json({
        success: true,
        message: deliveryMessage(result.emailStatus, 'application'),
        reference: result.reference,
        emailStatus: result.emailStatus,
      });
    } catch (error) {
      // The application was rejected, so its resume should not outlive the request.
      await deleteResume(storedKey);
      throw error;
    }
  }),
);

/**
 * GET /api/careers/resume/:id?e=<expiry>&t=<signature>
 *
 * The link carried in the admin notification email. No session required — the signature
 * *is* the authorisation, which is what "downloadable without signing in" means.
 *
 * Three things keep that honest: the signature covers both the application id and the
 * expiry so neither can be edited, the link expires, and every use is logged with the
 * requesting address. The resume itself is never served from a public URL — this route
 * mints a fresh sixty-second presigned URL at click time and redirects to it.
 */
applicationRouter.get(
  '/resume/:id',
  asyncHandler(async (request, response) => {
    const id = Number(request.params.id);
    const expiry = typeof request.query.e === 'string' ? request.query.e : '';
    const token = typeof request.query.t === 'string' ? request.query.t : '';

    if (!Number.isInteger(id) || id <= 0 || !verifyResumeLink(id, expiry, token)) {
      logger.warn('Rejected resume link', { id: request.params.id, ip: clientIp(request) });
      throw notFound('This download link is invalid or has expired.');
    }

    const application = await findApplication(id);
    if (!application?.resumeFilename) {
      throw notFound('This download link is invalid or has expired.');
    }

    const downloadName = application.resumeOriginalName ?? `${application.reference}-resume`;
    logger.info('Resume downloaded via email link', {
      reference: application.reference,
      ip: clientIp(request),
    });

    if (supportsPresignedUpload()) {
      response.redirect(302, await createDownloadUrl(application.resumeFilename, downloadName));
      return;
    }

    const opened = await openResume(application.resumeFilename);
    if (!opened) throw notFound('The resume file is no longer available.');

    response.setHeader('Content-Type', application.resumeMime ?? 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/["]/g, '')}"`);
    opened.stream.pipe(response);
  }),
);
