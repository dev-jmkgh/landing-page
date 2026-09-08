import { Router } from 'express';
import { z } from 'zod';
import { requireActor } from '../../../middleware/actor';
import { asyncHandler } from '../../../middleware/errorHandler';
import {
  changePasswordLimiter,
  emailVerificationLimiter,
  mobileLoginLimiter,
  refreshLimiter,
  signupLimiter,
} from '../../../middleware/rateLimit';
import { validateBody } from '../../../middleware/validate';
import { HttpError, unauthorized, validationFailed } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { clientIp } from '../../../utils/request';
import {
  OTP_TTL_MINUTES,
  issueEmailOtp,
  resendEmailOtp,
  verifyEmailOtp,
} from './emailVerification.service';
import { findEmployee } from '../employees/employee.repository';
import { changeOwnPassword } from '../employees/employee.service';
import { DEVICE_PLATFORMS } from '../shared.schema';
import {
  authenticateEmployee,
  createMobileSession,
  pruneMobileSessions,
  registerEmployee,
  revokeMobileSession,
  rotateMobileSession,
  setPushToken,
  type SignInRefusal,
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

    const result = await authenticateEmployee(email, password);

    if (!result.ok) {
      logger.warn('Failed mobile sign-in', {
        ip: clientIp(request),
        reason: result.refusal.reason,
      });
      throw refusalToError(result.refusal);
    }

    const actor = result.actor;

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


/**
 * Turns a refusal into the response the app should act on.
 *
 * The `code` matters as much as the message: the mobile client branches on it to decide
 * between re-showing the password field and showing the "waiting for approval" screen,
 * and it must not have to string-match prose to do that.
 *
 * 401 for bad credentials, 403 for the account-state cases. The distinction is real —
 * a 403 here means the password WAS correct and the account is simply not permitted to
 * sign in yet, which is why the client can safely treat it as "stop asking for the
 * password".
 */
function refusalToError(refusal: SignInRefusal): HttpError {
  switch (refusal.reason) {
    case 'credentials':
      /*
       * One message for a wrong password, an unknown address, a pending account with the
       * wrong password, and a deactivated one with the wrong password. Distinguishing
       * them would turn this endpoint into an account-existence oracle — see
       * authenticateEmployee for why that matters now that anyone with the APK can reach
       * the signup endpoint.
       */
      return unauthorized('Incorrect email or password.');

    case 'emailUnverified':
      /*
       * A distinct code, because this is the only refusal the person can clear
       * themselves. The app routes it to the code entry screen rather than to the
       * "waiting for approval" one — sending them to wait on an administrator would be
       * telling them to do nothing about something only they can fix.
       */
      return new HttpError(
        403,
        'Please confirm your email address first. Enter the code we sent you, or ask for a new one.',
        { code: 'email_not_verified' },
      );

    case 'pending':
      return new HttpError(
        403,
        'Your account is waiting for approval. An administrator will approve it shortly — please try again later.',
        { code: 'approval_pending' },
      );

    case 'rejected':
      return new HttpError(
        403,
        refusal.rejectionReason
          ? `Your registration was not approved: ${refusal.rejectionReason}`
          : 'Your registration was not approved. Please speak to your administrator.',
        { code: 'registration_rejected' },
      );

    case 'deactivated':
      return new HttpError(
        403,
        'Your account has been deactivated. Please speak to your administrator.',
        { code: 'account_deactivated' },
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Self-registration                                                           */
/* -------------------------------------------------------------------------- */

const signupSchema = z.object({
  name: z
    .string({ required_error: 'Enter your full name.' })
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(2, 'Enter your full name.')
        .max(120, 'Name must be 120 characters or fewer.'),
    ),
  email: z
    .string({ required_error: 'Enter your email address.' })
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .max(190),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  /*
   * Twelve, matching admin-created accounts. Not relaxed for self-registration: these
   * accounts reach the same customer data, and a self-chosen password is if anything
   * more likely to be weak than one an administrator generated.
   */
  password: z
    .string({ required_error: 'Choose a password.' })
    .min(12, 'Use at least 12 characters.')
    .max(200),
});

/**
 * POST /api/mobile/auth/signup
 *
 * Creates a telecaller account that CANNOT sign in until an administrator approves it.
 *
 * Note what the schema does not accept: no `role`, no `isActive`, no `approvalStatus`,
 * no `employeeCode`. Zod strips unknown keys by default, so sending them is not merely
 * ignored downstream — they never reach the service. That is the whole security boundary
 * of this endpoint, since anyone holding the APK can call it.
 *
 * No tokens are returned on success. There is deliberately nothing here that resembles
 * a session.
 */
mobileAuthRouter.post(
  '/signup',
  signupLimiter,
  validateBody(signupSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof signupSchema>;

    const result = await registerEmployee(input);

    if (!result.ok) {
      throw validationFailed({
        email:
          'An account with that email address already exists. Try signing in, or ask your administrator.',
      });
    }

    logger.info('Registration submitted', {
      employeeCode: result.employeeCode,
      ip: clientIp(request),
    });

    /*
     * Issue the verification code as part of registering.
     *
     * Awaited rather than fired and forgotten: if the code could not be stored, the app
     * must not send the applicant to a screen asking them to type one. A mail delivery
     * failure does NOT fail the request — the account exists either way and they can ask
     * for a new code — which is why `issueEmailOtp` reports delivery to the log and not
     * to the caller.
     */
    await issueEmailOtp({
      id: result.userId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
    });

    response.status(201).json({
      success: true,
      employeeCode: result.employeeCode,
      approvalStatus: 'pending',
      /*
       * The app branches on this rather than on the message, and it is stated even though
       * it is currently always true: a client that reads the flag keeps working if
       * verification ever becomes conditional, whereas one that assumes it does not.
       */
      emailVerificationRequired: true,
      expiresInMinutes: OTP_TTL_MINUTES,
      message:
        'Check your email for a 6-digit code to confirm your address. An administrator will then approve your account.',
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you registered with.'),
  /*
   * Exactly six digits. Anything else is refused before it reaches the service, so a
   * malformed submission cannot consume one of the five attempts against a live code.
   */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email.'),
});

/**
 * Confirms an email address.
 *
 * Answers 200 for a correct code and for an address that was already verified, and 400
 * for everything else with a single message. The service explains why the failures are
 * not told apart; the short version is that doing so would turn this into a way to find
 * out which addresses have accounts.
 */
mobileAuthRouter.post(
  '/verify-email',
  emailVerificationLimiter,
  validateBody(verifyEmailSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof verifyEmailSchema>;

    const result = await verifyEmailOtp(input.email, input.code);

    if (!result.ok) {
      throw new HttpError(400, 'That code is not valid or has expired. Ask for a new one.', {
        code: 'verification_failed',
      });
    }

    response.json({
      success: true,
      alreadyVerified: result.alreadyVerified,
      /*
       * Verification does not sign anyone in, and the message says so. The account is
       * still pending an administrator, and an applicant who thought otherwise would
       * keep trying the password and reading "waiting for approval" as a fault.
       */
      message: result.alreadyVerified
        ? 'Your email address is already confirmed. An administrator will approve your account before you can sign in.'
        : 'Thank you — your email address is confirmed. An administrator will approve your account before you can sign in.',
    });
  }),
);

const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you registered with.'),
});

/**
 * Sends a fresh code.
 *
 * Reports success for an unknown address and an already-verified one alike, so it cannot
 * be used to enumerate accounts. The one honest refusal is the per-account cooldown,
 * because "wait thirty seconds" is actionable and reveals only that the person asking
 * just asked.
 */
mobileAuthRouter.post(
  '/resend-verification',
  emailVerificationLimiter,
  validateBody(resendVerificationSchema),
  asyncHandler(async (request, response) => {
    const input = request.body as z.infer<typeof resendVerificationSchema>;

    const result = await resendEmailOtp(input.email);

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

/**
 * Who am I. Called on launch to decide between the login screen and the dashboard.
 *
 * This is the app's revocation checkpoint, so it re-reads authorisation state rather
 * than trusting the access token. A token stays valid for its full lifetime, so an
 * employee deactivated or rejected overnight would otherwise open the app to a working
 * dashboard — and `findEmployee` returns a profile regardless of state, so simply
 * finding a row proves nothing.
 *
 * The refusal carries a `code` so the client can clear its tokens and show the right
 * screen instead of guessing from prose.
 */
mobileAuthRouter.get(
  '/me',
  requireActor,
  asyncHandler(async (request, response) => {
    const profile = await findEmployee(request.actor!.id);
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

mobileAuthRouter.post(
  '/change-password',
  /*
   * Rate limited because this endpoint verifies the CURRENT password, which makes it a
   * password-guessing oracle for anyone holding an unlocked handset — and it mints a
   * fresh 60-day session on success.
   */
  changePasswordLimiter,
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
