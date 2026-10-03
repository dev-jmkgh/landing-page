import crypto from 'node:crypto';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { employeeVerificationEmail } from '../../services/email';
import { sendMail } from '../../services/mailer';
import { logger } from '../../utils/logger';

/**
 * Email verification for HR self-registration.
 *
 * The same design as the telecalling module's, against `hr_email_otps` instead of
 * `employee_email_otps`. The separation is the point: an HR registration must not be
 * verifiable with a code issued for a telecalling account, and vice versa, which a
 * shared table keyed only by user id would allow the moment the two id spaces overlap
 * — and they do, because both tables start at 1.
 *
 * A six-digit code carries about twenty bits of entropy, which no hash function
 * improves. What makes it safe is that there are very few chances to guess it and very
 * little time to try:
 *
 *   - it expires in ten minutes
 *   - it dies after five wrong guesses, permanently, not per-session
 *   - issuing a new one invalidates every code that came before
 *   - the endpoints that use it are rate limited per IP
 */

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * `randomInt` rather than `Math.random`, and a range that cannot produce fewer than six
 * digits — a leading zero would be lost the moment the value were treated as a number.
 */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** SHA-256, hex. See migration 011 for why this is not bcrypt. */
function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

interface HrUserRow extends RowDataPacket {
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

async function findHrUserByEmail(email: string): Promise<HrUserRow | null> {
  return queryOne<HrUserRow>(
    `SELECT id, name, email, email_verified_at
       FROM hr_users
      WHERE email = ?
      LIMIT 1`,
    [email.trim().toLowerCase()],
  );
}

/**
 * Issues a code and emails it.
 *
 * Invalidates any live code for the account in the same breath: a resend must not
 * extend the life of its predecessor, or the attempt cap could be reset by asking for a
 * new code and then guessing against the old one.
 *
 * The delivery result is logged, never returned. Whether SMTP accepted the message is
 * not something the applicant can act on, and surfacing it would let anyone probe which
 * addresses this server can deliver to.
 */
export async function issueHrEmailOtp(user: {
  id: number;
  name: string;
  email: string;
}): Promise<void> {
  const code = generateCode();

  await execute(
    `UPDATE hr_email_otps
        SET consumed_at = NOW()
      WHERE user_id = ? AND consumed_at IS NULL`,
    [user.id],
  );

  await execute(
    `INSERT INTO hr_email_otps (user_id, code_hash, expires_at)
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
    type: 'hr-verification',
  });

  // The code itself is never logged. It is a live credential for the next ten minutes,
  // and application logs are the one place it would outlive the email.
  logger.info('HR verification code issued', { userId: user.id, delivery: result });
}

export type HrVerifyOutcome =
  | { ok: true; alreadyVerified: boolean }
  /**
   * One refusal for every failure, on purpose. A wrong code, an expired code, a spent
   * code and an address that was never registered are reported identically — telling
   * them apart would turn this endpoint into an account-existence oracle.
   */
  | { ok: false; reason: 'invalid' };

/**
 * Checks a code and, on success, marks the address verified.
 *
 * A wrong guess costs an attempt before anything else happens, so the cap cannot be
 * sidestepped by abandoning the request.
 */
export async function verifyHrEmailOtp(email: string, code: string): Promise<HrVerifyOutcome> {
  const user = await findHrUserByEmail(email);
  if (!user) return { ok: false, reason: 'invalid' };

  /*
   * An already-verified address reports success rather than an error. The app can
   * arrive here twice — a retried request, a back-navigation, a second tap — and the
   * honest answer to "is this address verified?" is yes.
   */
  if (user.email_verified_at !== null) return { ok: true, alreadyVerified: true };

  const candidate = await queryOne<OtpRow>(
    `SELECT id, code_hash, attempts
       FROM hr_email_otps
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
    await execute('UPDATE hr_email_otps SET attempts = attempts + 1 WHERE id = ?', [
      candidate.id,
    ]);
    return { ok: false, reason: 'invalid' };
  }

  /*
   * Consume the code first, guarded on `consumed_at IS NULL`, so two simultaneous
   * requests carrying the same correct code cannot both proceed — the second updates
   * zero rows and is refused. That is the difference between single-use and
   * single-use-most-of-the-time.
   */
  const consumed = await execute(
    'UPDATE hr_email_otps SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [candidate.id],
  );

  if (consumed.affectedRows === 0) return { ok: false, reason: 'invalid' };

  await execute(
    'UPDATE hr_users SET email_verified_at = NOW() WHERE id = ? AND email_verified_at IS NULL',
    [user.id],
  );

  logger.info('HR employee email verified', { userId: user.id });

  return { ok: true, alreadyVerified: false };
}

export type HrResendOutcome =
  /** Sent, or already verified, or no such account. The caller cannot tell which. */
  | { ok: true }
  /** Asked again too soon. Reported honestly, because waiting is actionable. */
  | { ok: false; reason: 'cooldown'; retryAfterSeconds: number };

/**
 * Issues a fresh code, subject to a per-account cooldown.
 *
 * Reports success for an unknown address and an already-verified one alike, so it
 * cannot be used to enumerate accounts. The cooldown is the one honest refusal: it
 * reveals only that the person asking just asked.
 */
export async function resendHrEmailOtp(email: string): Promise<HrResendOutcome> {
  const user = await findHrUserByEmail(email);

  // Nothing to do, and nothing to admit to.
  if (!user || user.email_verified_at !== null) return { ok: true };

  const recent = await query<RowDataPacket & { age_seconds: number }>(
    `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
       FROM hr_email_otps
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

  await issueHrEmailOtp({ id: user.id, name: user.name, email: user.email });
  return { ok: true };
}
