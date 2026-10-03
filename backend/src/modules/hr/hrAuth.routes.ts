import { Router } from 'express';
import { z } from 'zod';
import { requireHrActor } from '../../middleware/hrActor';
import { asyncHandler } from '../../middleware/errorHandler';
import {
  hrChangePasswordLimiter,
  hrEmailVerificationLimiter,
  hrLoginLimiter,
  hrRefreshLimiter,
  hrSignupLimiter,
} from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { HttpError, unauthorized, validationFailed } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/request';
import { DEVICE_PLATFORMS, optionalPhoneField } from './hr.schema';
import { findHrUser } from './hr.repository';
import {
  OTP_TTL_MINUTES,
  issueHrEmailOtp,
  resendHrEmailOtp,
  verifyHrEmailOtp,
} from './hrEmailVerification.service';
import {
  authenticateHrUser,
  changeOwnHrPassword,
  createHrSession,
  pruneHrSessions,
  registerHrUser,
  revokeHrSession,
  rotateHrSession,
  type HrSignInRefusal,
} from './hrAuth.service';

/**
 * HR app authentication, mounted at `/api/hr/auth`.
 *
 * A separate router from the telecalling one, over separate tables, issuing tokens with
 * a separate audience. Nothing here can read or write a `telecaller_users` row — see
 * migration 017 for why that independence is the requirement rather than a side effect.
 *
 * The refresh token travels in the request body, not a header: it is a credential
 * rather than an authorisation for this request, and bodies are not what access logs
 * routinely record.
 */
export const hrAuthRouter = Router();

const deviceSchema = z.object({
  name: z.string().trim().max(120).optional(),
  platform: z.enum(DEVICE_PLATFORMS).default('unknown'),
  pushToken: z.string().trim().max(255).optional(),
});

/* -------------------------------------------------------------------------- */
/* Sign in                                                                     */
/* -------------------------------------------------------------------------- */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  password: z.string().min(1, 'Enter your password.').max(200),
  device: deviceSchema.optional(),
});

hrAuthRouter.post(
  '/login',
  hrLoginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (request, response) => {
    const { email, password, device } = request.body as z.infer<typeof loginSchema>;

    const result = await authenticateHrUser(email, password);

    if (!result.ok) {
      logger.warn('Failed HR sign-in', { ip: clientIp(request), reason: result.refusal.reason });
      throw refusalToError(result.refusal);
    }

    const session = await createHrSession(result.actor, {
      name: device?.name ?? null,
      platform: device?.platform ?? 'unknown',
      pushToken: device?.pushToken ?? null,
    });

    // Opportunistic housekeeping rather than a cron job somebody has to install.
    void pruneHrSessions();

    const profile = await findHrUser(result.actor.id);

    logger.info('HR employee signed in', {
      id: result.actor.id,
      platform: device?.platform,
      ip: clientIp(request),
    });

    response.json({ success: true, ...session, employee: profile });
  }),
);

/**
 * Turns a refusal into the response the app acts on.
 *
 * The `code` matters more than the prose: the app branches on it to choose between
 * re-showing the password field, the code screen and the waiting-for-approval screen,
 * and it must not have to string-match a sentence to do that.
 *
 * 401 for bad credentials, 403 for the account-state cases. The distinction is real — a
 * 403 means the password WAS correct and the account simply is not allowed in yet,
 * which is why the app can safely stop asking for the password.
 */
function refusalToError(refusal: HrSignInRefusal): HttpError {
  switch (refusal.reason) {
    case 'credentials':
      // One message for a wrong password, an unknown address, and a pending or
      // deactivated account with the wrong password. Anything finer would make this
      // endpoint an account-existence oracle.
      return unauthorized('Incorrect email or password.');

    case 'emailUnverified':
      return new HttpError(
        403,
        'Please confirm your email address first. Enter the code we sent you, or ask for a new one.',
        { code: 'email_not_verified' },
      );

    case 'pending':
      return new HttpError(
        403,
        'Your account is waiting for approval. Please try again later.',
        { code: 'approval_pending' },
      );

    case 'rejected':
      return new HttpError(
        403,
        refusal.rejectionReason
          ? `Your registration was not approved: ${refusal.rejectionReason}`
          : 'Your registration was not approved. Please contact HR.',
        { code: 'registration_rejected' },
      );

    case 'deactivated':
      return new HttpError(
        403,
        'Your account has been deactivated. Please contact HR.',
        { code: 'account_deactivated' },
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Self-registration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exported so the e2e harness can assert against the real rule rather than a copy.
 *
 * `hrSignupLimiter` allows only a handful of registrations per window, so probing these
 * rules over HTTP would spend the budget the rest of the suite needs — and a copied
 * schema in the test would keep passing while this one regressed.
 */
export const hrSignupSchema = z.object({
  name: z
    .string({ required_error: 'Enter your full name.' })
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z.string().min(2, 'Enter your full name.').max(120, 'Name must be 120 characters or fewer.'),
    ),
  email: z
    .string({ required_error: 'Enter your email address.' })
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .max(190),
  phone: optionalPhoneField,
  /*
   * Twelve characters, matching admin-created accounts. Not relaxed for
   * self-registration: a self-chosen password is if anything likelier to be weak.
   */
  password: z
    .string({ required_error: 'Choose a password.' })
    .min(12, 'Use at least 12 characters.')
    .max(200),
});

/**
 * POST /api/hr/auth/signup
 *
 * Creates an HR account that CANNOT sign in until an administrator approves it.
 *
 * Note what the schema does not accept: no `role`, no `isActive`, no `approvalStatus`,
 * no `employeeCode` — and unlike the telecalling signup, not even a narrowed
 * `requestedRole`. Zod strips unknown keys, so sending any of them is not merely
 * ignored downstream; they never reach the service. That is the entire security
 * boundary of this endpoint, which anyone holding the APK can call.
 *
 * No tokens are returned. There is deliberately nothing here resembling a session.
 */
hrAuthRouter.post(
  '/signup',
  hrSignupLimiter,
  validateBody(hrSignupSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof hrSignupSchema>;

    const result = await registerHrUser(input);

    if (!result.ok) {
      throw validationFailed({
        email:
          'An account with that email address already exists. Try signing in, or contact HR.',
      });
    }

    logger.info('HR registration submitted', {
      employeeCode: result.employeeCode,
      ip: clientIp(request),
    });

    /*
     * Awaited, not fired and forgotten: if the code could not be STORED, the app must
     * not send the applicant to a screen asking them to type one. A mail DELIVERY
     * failure does not fail the request — the account exists either way and they can
     * ask for a new code — which is why `issueHrEmailOtp` reports delivery to the log
     * rather than to the caller.
     */
    await issueHrEmailOtp({
      id: result.userId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
    });

    response.status(201).json({
      success: true,
      employeeCode: result.employeeCode,
      approvalStatus: 'pending',
      emailVerificationRequired: true,
      expiresInMinutes: OTP_TTL_MINUTES,
      message:
        'Check your email for a 6-digit code to confirm your address. Your account will then be approved before you can sign in.',
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you registered with.'),
  /*
   * Exactly six digits, refused before reaching the service — so a malformed submission
   * cannot consume one of the five attempts against a live code.
   */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email.'),
});

hrAuthRouter.post(
  '/verify-email',
  hrEmailVerificationLimiter,
  validateBody(verifyEmailSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof verifyEmailSchema>;

    const result = await verifyHrEmailOtp(input.email, input.code);

    if (!result.ok) {
      throw new HttpError(400, 'That code is not valid or has expired. Ask for a new one.', {
        code: 'verification_failed',
      });
    }

    response.json({
      success: true,
      alreadyVerified: result.alreadyVerified,
      /*
       * Verification does not sign anyone in, and the message says so. Someone who
       * believed otherwise would keep trying their password and read "waiting for
       * approval" as a fault.
       */
      message: result.alreadyVerified
        ? 'Your email address is already confirmed. Your account will be approved before you can sign in.'
        : 'Thank you — your email address is confirmed. Your account will be approved before you can sign in.',
    });
  }),
);

const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you registered with.'),
});

hrAuthRouter.post(
  '/resend-verification',
  hrEmailVerificationLimiter,
  validateBody(resendVerificationSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof resendVerificationSchema>;

    const result = await resendHrEmailOtp(input.email);

    if (!result.ok) {
      throw new HttpError(
        429,
        `Please wait ${result.retryAfterSeconds} seconds before asking for another code.`,
        { code: 'resend_cooldown' },
      );
    }

    response.json({
      success: true,
      expiresInMinutes: OTP_TTL_MINUTES,
      message: 'If that address is registered and not yet confirmed, a new code is on its way.',
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

const refreshSchema = z.object({
  refreshToken: z.string().min(32).max(200),
});

hrAuthRouter.post(
  '/refresh',
  hrRefreshLimiter,
  validateBody(refreshSchema),
  asyncHandler(async (request, response) => {
    const { refreshToken } = request.body as z.infer<typeof refreshSchema>;

    const result = await rotateHrSession(refreshToken);

    // 401 with this code tells the app to clear its tokens and show the login screen.
    // Anything else and it would retry a token that can never work.
    if (!result) throw unauthorized('Your session has expired. Please sign in again.');

    response.json({ success: true, ...result.session });
  }),
);

hrAuthRouter.post(
  '/logout',
  validateBody(refreshSchema),
  asyncHandler(async (request, response) => {
    const { refreshToken } = request.body as z.infer<typeof refreshSchema>;

    // Deliberately unauthenticated beyond holding the token. Signing out has to work
    // once the access token has already expired, which is exactly when someone hands
    // the handset back.
    await revokeHrSession(refreshToken);
    response.json({ success: true });
  }),
);

/**
 * Who am I. Called on launch to choose between the login screen and the dashboard.
 *
 * This is the app's revocation checkpoint, so it re-reads account state rather than
 * trusting the access token, which stays valid for its full lifetime. An employee
 * deactivated or rejected overnight would otherwise open the app to a working
 * dashboard — and simply finding a row proves nothing, because `findHrUser` returns a
 * profile whatever state it is in.
 */
hrAuthRouter.get(
  '/me',
  requireHrActor,
  asyncHandler(async (request, response) => {
    const profile = await findHrUser(request.hrActor!.id);
    if (!profile) throw unauthorized('Your account no longer exists.');

    if (profile.approvalStatus === 'pending') {
      throw new HttpError(403, 'Your account is still waiting for approval.', {
        code: 'approval_pending',
      });
    }

    if (profile.approvalStatus === 'rejected') {
      throw new HttpError(
        403,
        profile.rejectionReason
          ? `Your registration was not approved: ${profile.rejectionReason}`
          : 'Your registration was not approved.',
        { code: 'registration_rejected' },
      );
    }

    if (!profile.isActive) {
      throw new HttpError(403, 'Your account has been deactivated.', {
        code: 'account_deactivated',
      });
    }

    response.json({ success: true, employee: profile });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, 'Use at least 12 characters.').max(200),
});

hrAuthRouter.post(
  '/change-password',
  /*
   * ORDER MATTERS: authenticate FIRST, then rate limit.
   *
   * `hrChangePasswordLimiter` keys on `request.hrActor`, which only exists once
   * `requireHrActor` has run. With the limiter first — as its telecalling counterpart
   * still has it — every caller falls back to the IP key, so one office shares a single
   * budget of five attempts and colleagues lock each other out of changing their own
   * passwords.
   */
  requireHrActor,
  hrChangePasswordLimiter,
  validateBody(changePasswordSchema),
  asyncHandler(async (request, response) => {
    const { currentPassword, newPassword } = request.body as z.infer<typeof changePasswordSchema>;
    const actor = request.hrActor!;

    const changed = await changeOwnHrPassword(actor.id, currentPassword, newPassword);

    if (!changed) {
      throw new HttpError(400, 'Your current password is not correct.', {
        code: 'current_password_incorrect',
      });
    }

    /*
     * The change revoked every device, including this one. Without a fresh session the
     * app would sign the employee out the instant they successfully changed their
     * password, which reads as a failure.
     */
    const session = await createHrSession(actor, { platform: 'unknown' });

    response.json({ success: true, ...session });
  }),
);
