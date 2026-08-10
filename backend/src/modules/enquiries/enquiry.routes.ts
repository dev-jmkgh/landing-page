import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { enquiryLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { clientIp } from '../../utils/request';
import { createEnquiry } from './enquiry.service';
import { enquirySchema } from './enquiry.schema';

export const enquiryRouter = Router();

/**
 * POST /api/enquiries
 *
 * Public endpoint used by the floating enquiry widget, the contact page and the
 * business-page CTAs.
 */
enquiryRouter.post(
  '/',
  enquiryLimiter,
  validateBody(enquirySchema),
  asyncHandler(async (request, response) => {
    const result = await createEnquiry(request.body, {
      ipAddress: clientIp(request),
      userAgent: request.get('user-agent'),
    });

    response.status(201).json({
      success: true,
      message:
        'Thank you! Your enquiry has been submitted successfully. Our team will get back to you shortly.',
      reference: result.reference,
    });
  }),
);
