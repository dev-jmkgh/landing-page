import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { enquiryLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { clientIp } from '../../utils/request';
import { deliveryMessage } from '../../services/deliveryStatus';
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

    // The enquiry is stored either way; the message reflects what happened to the
    // email rather than claiming a delivery that may not have occurred.
    response.status(201).json({
      success: true,
      message: deliveryMessage(result.emailStatus, 'enquiry'),
      reference: result.reference,
      emailStatus: result.emailStatus,
    });
  }),
);
