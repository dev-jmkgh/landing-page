import { Router } from 'express';
import { z } from 'zod';
import { requireActor } from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import { mobileLoginLimiter, refreshLimiter } from '../../../middleware/rateLimit';
import { validateBody } from '../../../middleware/validate';
import { unauthorized } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { clientIp } from '../../../utils/request';
import { findEmployee } from '../employees/employee.repository';
import { changeOwnPassword } from '../employees/employee.service';
import { DEVICE_PLATFORMS } from '../shared.schema';
import {
  authenticateEmployee,
  createMobileSession,
  pruneMobileSessions,
  revokeMobileSession,
  rotateMobileSession,
  setPushToken,
} from './mobileAuth.service';

/**
 * Mobile authentication routes, mounted at `/api/mobile/auth`.
 *
 * The refresh token travels in the request body rather than a header. It is a
 * credential, not an authorisation for this request, and putting it in the body keeps
 * it out of access logs that routinely record headers.
 */
export const mobileAuthRouter = Router();

const deviceSchema = z.object({
  name: z.string().trim().max(120).optional(),
  platform: z.enum(DEVICE_PLATFORMS).default('unknown'),
  pushToken: z.string().trim().max(255).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  password: z.string().min(1, 'Enter your password.').max(200),
  device: deviceSchema.optional(),
});

mobileAuthRouter.post(
  '/login',
  mobileLoginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (request, response) => {
    const { email, password, device } = request.body as z.infer<typeof loginSchema>;

    const actor = await authenticateEmployee(email, password);

    if (!actor) {
      logger.warn('Failed mobile sign-in', { ip: clientIp(request) });
      // One message for a wrong password, an unknown address and a deactivated account.
      // Distinguishing them would let an outsider enumerate the staff list.
      throw unauthorized('Incorrect email or password.');
    }

    const session = await createMobileSession(actor, {
      name: device?.name ?? null,
      platform: device?.platform ?? 'unknown',
      pushToken: device?.pushToken ?? null,
    });

    // Opportunistic housekeeping, rather than a cron job that has to be installed and
    // remembered. Never blocks the sign-in — it logs and swallows its own errors.
    void pruneMobileSessions();

    const profile = await findEmployee(actor.id);

    logger.info('Employee signed in on mobile', {
      id: actor.id,
      platform: device?.platform,
      ip: clientIp(request),
    });

    response.json({
      success: true,
      ...session,
      employee: profile,
    });
  }),
);

const refreshSchema = z.object({
  refreshToken: z.string().min(32).max(200),
});

mobileAuthRouter.post(
  '/refresh',
  refreshLimiter,
  validateBody(refreshSchema),
  asyncHandler(async (request, response) => {
    const { refreshToken } = request.body as z.infer<typeof refreshSchema>;

    const result = await rotateMobileSession(refreshToken);

    if (!result) {
      // 401 with this code is the client's signal to clear stored tokens and show the
      // login screen. Anything else and the app would retry a token that can never work.
      throw unauthorized('Your session has expired. Please sign in again.');
    }

    response.json({ success: true, ...result.session });
  }),
);

mobileAuthRouter.post(
  '/logout',
  validateBody(refreshSchema),
  asyncHandler(async (request, response) => {
    const { refreshToken } = request.body as z.infer<typeof refreshSchema>;

    // Deliberately unauthenticated beyond holding the token. Signing out has to work
    // when the access token has already expired, which is exactly when someone hands
    // the handset back.
    await revokeMobileSession(refreshToken);
    response.json({ success: true });
  }),
);

const pushTokenSchema = z.object({
  refreshToken: z.string().min(32).max(200),
  /** `null` clears the token, so a handset can be silenced without signing out. */
  pushToken: z.string().trim().max(255).nullable(),
});

mobileAuthRouter.post(
  '/push-token',
  requireActor,
  validateBody(pushTokenSchema),
  asyncHandler(async (request, response) => {
    const { refreshToken, pushToken } = request.body as z.infer<typeof pushTokenSchema>;

    const updated = await setPushToken(refreshToken, pushToken);
    if (!updated) throw unauthorized('That device session is no longer valid.');

    response.json({ success: true });
  }),
);

/** Who am I. Used on launch to decide between the login screen and the dashboard. */
mobileAuthRouter.get(
  '/me',
  requireActor,
  asyncHandler(async (request, response) => {
    const profile = await findEmployee(request.actor!.id);
    if (!profile) throw unauthorized('Your account is no longer active.');

    response.json({ success: true, employee: profile });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, 'Use at least 12 characters.').max(200),
});

mobileAuthRouter.post(
  '/change-password',
  requireActor,
  validateBody(changePasswordSchema),
  asyncHandler(async (request, response) => {
    const { currentPassword, newPassword } = request.body as z.infer<typeof changePasswordSchema>;
    const actor = request.actor!;

    // The service writes the audit entry and revokes every existing device.
    await changeOwnPassword(actor, currentPassword, newPassword, clientIp(request));

    /**
     * A fresh session is issued here because the revocation above included this device.
     * Without it the app would sign the employee out the moment they successfully
     * changed their password, which reads as a failure.
     */
    const session = await createMobileSession(actor, { platform: 'unknown' });

    response.json({ success: true, ...session });
  }),
);
