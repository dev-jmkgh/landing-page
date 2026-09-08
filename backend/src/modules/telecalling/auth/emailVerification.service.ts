import crypto from 'node:crypto';
import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { employeeVerificationEmail } from '../../../services/email';
import { sendMail } from '../../../services/mailer';
import { logger } from '../../../utils/logger';

/**
 * Email verification for employee self-registration.
 *
 * A registration proves someone typed an address; this proves they can read it. Until
 * they have, the account cannot sign in and cannot be approved — see the sign-in check in
 * `mobileAuth.service.ts` and the approval check in `employee.service.ts`.
 *
 * The whole design rests on one observation: a six-digit code has about twenty bits of
 * entropy, which is nothing. No hash function fixes that. What makes it safe is that
 * there are very few chances to guess it and very little time to try:
 *
 *   - it expires in ten minutes
 *   - it dies after five wrong guesses, permanently, not per-session
 *   - issuing a new one invalidates every code that came before
 *   - the endpoints that use it are rate limited per IP
 *
 * Remove any one of those and the code length would have to grow. They are enforced here
 * rather than in the route so that a second caller cannot get a weaker version.
 */

/** Ten minutes. Long enough to switch apps and find the email, short enough to matter. */
export const OTP_TTL_MINUTES = 10;

/**
 * Five wrong guesses and the code is dead.
 *
 * Five rather than three because a mistyped digit is the common case and a locked-out
 * applicant has to ask an administrator for help. Against a 10^6 space, five attempts is
 * a 1-in-200,000 chance per code — and the code is gone once they are spent, so an
 * attacker cannot accumulate attempts by requesting new ones.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * The shortest gap between two issues for the same account.
 *
 * Stops a resend button from being used as a free mail relay against someone else's
 * inbox. The route is also IP rate limited; this limit is per account, which is the one
 * an attacker cannot escape by changing address.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * A six-digit code, from a cryptographic source.
 *
 * `randomInt` rather than `Math.random`, and a range that cannot produce a code with
 * fewer than six digits — a leading zero would otherwise be lost the moment the value
 * were treated as a number anywhere.
 */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * SHA-256, hex.
 *
 * See the migration for why this is not bcrypt: the code's safety comes from expiry and
 * the attempt cap, and a slow hash here would only make the verify endpoint a way to
 * exhaust the server's CPU.
 */
function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Compares two hashes without leaking where they differ.
 *
 * The hashes are the same fixed length, so `timingSafeEqual` can be used directly. It
 * matters less here than for a password — an attacker who could measure it would still
 * face the attempt cap — but a constant-time compare costs nothing and removes the need
 * to reason about it.
 */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  email_verified_at: Date | string | null;
}

interface OtpRow extends RowDataPacket {
  id: number;
  code_hash: string;
  attempts: number;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT id, name, email, email_verified_at
       FROM telecaller_users
      WHERE email = ?
      LIMIT 1`,
    [email.trim().toLowerCase()],
  );
}

/**
 * Issues a code and emails it.
 *
 * Invalidates any code the account already had, in the same statement that would
 * otherwise leave two live codes: a resend must not extend the life of the previous one,
 * or the attempt cap could be reset by asking for a new code and then guessing against
 * the old.
 *
 * The email result is logged but never returned to the caller. Whether SMTP accepted the
 * message is not something the applicant can act on, and surfacing it would let anyone
 * probe which addresses this server can deliver to.
 */
export async function issueEmailOtp(user: {
  id: number;
  name: string;
  email: string;
}): Promise<void> {
  const code = generateCode();

  await execute(
    `UPDATE employee_email_otps
        SET consumed_at = NOW()
      WHERE user_id = ? AND consumed_at IS NULL`,
    [user.id],
  );

  await execute(
    `INSERT INTO employee_email_otps (user_id, code_hash, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [user.id, hashCode(code), OTP_TTL_MINUTES],
  );

  const message = employeeVerificationEmail({
    name: user.name,
    code,
    expiresInMinutes: OTP_TTL_MINUTES,
  });

  const result = await sendMail({
    to: user.email,
    subject: message.subject,
    html: message.html,
    text: message.text,
    type: 'employee-verification',
  });

  // The code itself is never logged. It is a live credential for the next ten minutes,
  // and application logs are the one place it would outlive the email.
  logger.info('Employee verification code issued', { userId: user.id, delivery: result });
}

export type VerifyOutcome =
  | { ok: true; alreadyVerified: boolean }
  /**
   * One refusal for every failure, on purpose.
   *
   * A wrong code, an expired code, a spent code, and an address that was never
   * registered are all reported identically. Telling them apart would turn this endpoint
   * into a way to discover which addresses have accounts, and would tell an attacker
   * whether it is worth continuing to guess.
   */
  | { ok: false; reason: 'invalid' };

/**
 * Checks a code and, on success, marks the address verified.
 *
 * The attempt counter is incremented before the comparison result is returned, so a
 * wrong guess costs an attempt whatever happens next.
 */
export async function verifyEmailOtp(email: string, code: string): Promise<VerifyOutcome> {
  const user = await findUserByEmail(email);
  if (!user) return { ok: false, reason: 'invalid' };

  /*
   * An already-verified address reports success rather than an error.
   *
   * The app can arrive here twice — a retried request, a back-navigation, a second tap —
   * and the honest answer to "is this address verified?" is yes. Failing would send
   * someone who has already done the work back to a code box.
   */
  if (user.email_verified_at !== null) return { ok: true, alreadyVerified: true };

  const candidate = await queryOne<OtpRow>(
    `SELECT id, code_hash, attempts
       FROM employee_email_otps
      WHERE user_id = ?
        AND consumed_at IS NULL
        AND expires_at > NOW()
        AND attempts < ?
      ORDER BY id DESC
      LIMIT 1`,
    [user.id, OTP_MAX_ATTEMPTS],
  );

  if (!candidate) return { ok: false, reason: 'invalid' };

  if (!hashesMatch(candidate.code_hash, hashCode(code))) {
    await execute('UPDATE employee_email_otps SET attempts = attempts + 1 WHERE id = ?', [
      candidate.id,
    ]);
    return { ok: false, reason: 'invalid' };
  }

  /*
   * Consume the code and mark the address in two statements, with the consume first.
   *
   * Guarded on `consumed_at IS NULL` so two simultaneous requests carrying the same
   * correct code cannot both proceed — the second updates zero rows and is refused. That
   * costs nothing here, and it is the difference between a code being single-use and
   * being single-use-most-of-the-time.
   */
  const consumed = await execute(
    'UPDATE employee_email_otps SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [candidate.id],
  );

  if (consumed.affectedRows === 0) return { ok: false, reason: 'invalid' };

  await execute(
    'UPDATE telecaller_users SET email_verified_at = NOW() WHERE id = ? AND email_verified_at IS NULL',
    [user.id],
  );

  logger.info('Employee email verified', { userId: user.id });

  return { ok: true, alreadyVerified: false };
}

export type ResendOutcome =
  /** Sent, or already verified, or no such account. The caller cannot tell which. */
  | { ok: true }
  /** Asked again too soon. This one IS reported, because waiting is actionable. */
  | { ok: false; reason: 'cooldown'; retryAfterSeconds: number };

/**
 * Issues a fresh code, subject to a per-account cooldown.
 *
 * Reports success for an unknown address and for an already-verified one, so the
 * endpoint cannot be used to enumerate accounts. The cooldown is the one refusal that is
 * reported honestly: "wait thirty seconds" is something the person can act on, and it
 * reveals only that they themselves just asked.
 */
export async function resendEmailOtp(email: string): Promise<ResendOutcome> {
  const user = await findUserByEmail(email);

  // Nothing to do, and nothing to admit to.
  if (!user || user.email_verified_at !== null) return { ok: true };

  const recent = await query<RowDataPacket & { age_seconds: number }>(
    `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
       FROM employee_email_otps
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [user.id],
  );

  const age = recent[0]?.age_seconds;

  if (age !== undefined && age < OTP_RESEND_COOLDOWN_SECONDS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS - Number(age),
    };
  }

  await issueEmailOtp({ id: user.id, name: user.name, email: user.email });
  return { ok: true };
}

/**
 * Whether an address has been verified. Used by the sign-in and approval paths.
 *
 * Returns false for an address with no account: the callers are asking "may this
 * proceed?", and the answer for a non-existent account is no.
 */
export async function isEmailVerified(email: string): Promise<boolean> {
  const user = await findUserByEmail(email);
  return user !== null && user.email_verified_at !== null;
}
