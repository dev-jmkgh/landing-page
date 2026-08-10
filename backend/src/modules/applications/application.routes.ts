import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { applicationLimiter } from '../../middleware/rateLimit';
import { removeUpload, uploadResume, verifyResumeContents } from '../../middleware/upload';
import { toFieldErrors } from '../../middleware/validate';
import { validationFailed } from '../../utils/httpError';
import { clientIp } from '../../utils/request';
import { applicationSchema } from './application.schema';
import { createApplication } from './application.service';

export const applicationRouter = Router();

/**
 * POST /api/applications  (multipart/form-data)
 *
 * Multer writes the file before the text fields can be validated, so every failure path
 * below deletes the uploaded file — a rejected application never leaves a file behind.
 */
applicationRouter.post(
  '/',
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

      response.status(201).json({
        success: true,
        message:
          'Thank you! Your application has been submitted successfully. Our team will review it and get back to you shortly.',
        reference: result.reference,
      });
    } catch (error) {
      await removeUpload(file?.path);
      throw error;
    }
  }),
);
