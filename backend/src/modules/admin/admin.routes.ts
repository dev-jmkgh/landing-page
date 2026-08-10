import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { loginLimiter } from '../../middleware/rateLimit';
import { resolveStoredFile } from '../../middleware/upload';
import { validateBody, validateQuery } from '../../middleware/validate';
import { notFound, unauthorized } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import {
  findApplication,
  listApplications,
  updateApplicationStatus,
} from '../applications/application.repository';
import { listEnquiries, updateEnquiryStatus } from '../enquiries/enquiry.repository';
import { listQuerySchema, statusUpdateSchema, type ListQuery } from '../enquiries/enquiry.schema';
import {
  authenticate,
  clearSessionCookies,
  createSession,
  setSessionCookies,
} from './auth.service';

export const adminRouter = Router();

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  password: z.string().min(1, 'Enter your password.').max(200),
});

adminRouter.post(
  '/auth/login',
  loginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (request, response) => {
    const { email, password } = request.body as z.infer<typeof loginSchema>;

    const identity = await authenticate(email, password);

    if (!identity) {
      logger.warn('Failed admin sign-in attempt', { ip: clientIp(request) });
      // Same message whichever factor was wrong — no account enumeration.
      throw unauthorized('Incorrect email or password.');
    }

    const { token, csrf } = createSession(identity);
    setSessionCookies(response, token, csrf);

    logger.info('Admin signed in', { email: identity.email, ip: clientIp(request) });

    // The CSRF token is returned in the body as well as the cookie. The admin UI is
    // served from www.jmkglobalholdings.com while this API answers on
    // api.jmkglobalholdings.com, and a cookie set here is host-only — the www page
    // cannot read it back out of document.cookie. Handing the token over in the
    // response keeps the double-submit check working across that split. Reading it
    // requires a successful same-origin-permitted response, which CORS denies to any
    // other site, so this does not weaken the protection.
    response.json({ success: true, email: identity.email, csrfToken: csrf });
  }),
);

adminRouter.post(
  '/auth/logout',
  requireAuth,
  requireCsrf,
  asyncHandler(async (request, response) => {
    clearSessionCookies(response);
    logger.info('Admin signed out', { email: request.admin?.email });
    response.json({ success: true });
  }),
);

adminRouter.get(
  '/auth/session',
  requireAuth,
  asyncHandler(async (request, response) => {
    // Returned here too so a page reload can recover the token without signing in again.
    response.json({
      success: true,
      email: request.admin?.email,
      csrfToken: request.admin?.csrf,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

const idParamSchema = z.coerce.number().int().positive();

function parseId(value: string | undefined): number {
  const result = idParamSchema.safeParse(value);
  if (!result.success) throw notFound('Record not found.');
  return result.data;
}

adminRouter.get(
  '/enquiries',
  requireAuth,
  validateQuery(listQuerySchema),
  asyncHandler(async (_request, response) => {
    const result = await listEnquiries(response.locals.query as ListQuery);
    response.json(result);
  }),
);

adminRouter.patch(
  '/enquiries/:id/status',
  requireAuth,
  requireCsrf,
  validateBody(statusUpdateSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { status } = request.body as z.infer<typeof statusUpdateSchema>;

    const updated = await updateEnquiryStatus(id, status);
    if (!updated) throw notFound('Enquiry not found.');

    logger.info('Enquiry status changed', {
      reference: updated.reference,
      status,
      by: request.admin?.email,
    });
    response.json(updated);
  }),
);

adminRouter.get(
  '/applications',
  requireAuth,
  validateQuery(listQuerySchema),
  asyncHandler(async (_request, response) => {
    const result = await listApplications(response.locals.query as ListQuery);
    response.json(result);
  }),
);

adminRouter.patch(
  '/applications/:id/status',
  requireAuth,
  requireCsrf,
  validateBody(statusUpdateSchema),
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);
    const { status } = request.body as z.infer<typeof statusUpdateSchema>;

    const updated = await updateApplicationStatus(id, status);
    if (!updated) throw notFound('Application not found.');

    logger.info('Application status changed', {
      reference: updated.reference,
      status,
      by: request.admin?.email,
    });
    response.json(updated);
  }),
);

/**
 * GET /api/admin/applications/:id/resume
 *
 * Resumes live outside the web root, so this authenticated route is the only way to
 * read one. The stored name is resolved through `resolveStoredFile`, which refuses any
 * path that escapes the upload directory.
 */
adminRouter.get(
  '/applications/:id/resume',
  requireAuth,
  asyncHandler(async (request, response) => {
    const id = parseId(request.params.id);

    const application = await findApplication(id);
    if (!application) throw notFound('Application not found.');
    if (!application.resumeFilename) throw notFound('No resume was attached to this application.');

    const absolutePath = resolveStoredFile(application.resumeFilename);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      logger.warn('Resume file missing from storage', {
        reference: application.reference,
        filename: application.resumeFilename,
      });
      throw notFound('The resume file is no longer available.');
    }

    const downloadName = application.resumeOriginalName ?? `${application.reference}-resume`;

    response.setHeader('Content-Type', application.resumeMime ?? 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.download(absolutePath, downloadName);
  }),
);
