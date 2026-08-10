import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { applicationLimiter } from '../../middleware/rateLimit';
import { removeUpload, uploadResume, verifyResumeContents } from '../../middleware/upload';
import { toFieldErrors } from '../../middleware/validate';
import { validationFailed } from '../../utils/httpError';
import { clientIp } from '../../utils/request';
import { deliveryMessage } from '../../services/deliveryStatus';
import { applicationSchema } from './application.schema';
import { createApplication } from './application.service';

export const applicationRouter = Router();

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

    try {
      const parsed = applicationSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(toFieldErrors(parsed.error));

      if (!file) {
        throw validationFailed({ resume: 'Please attach your resume.' });
      }

      // The declared MIME type is a hint; the file's own bytes are the proof.
      const contentsValid = await verifyResumeContents(file.path);
      if (!contentsValid) {
        throw validationFailed({
          resume: 'That file does not appear to be a valid PDF or Word document.',
        });
      }

      const result = await createApplication(
        parsed.data,
        {
          storedName: file.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
        },
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
      await removeUpload(file?.path);
      throw error;
    }
  }),
);
