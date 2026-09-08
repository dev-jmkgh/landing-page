import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../../../config/env';
import { execute, queryOne, type RowDataPacket } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import type { Actor } from '../actor';
import type { DevicePlatform, EmployeeRole } from '../shared.schema';

/**
 * Authentication for the mobile app.
 *
 * The admin web app's cookie session is the wrong primitive here: React Native has no
 * cookie jar worth relying on, and a long-lived httpOnly cookie cannot be rotated
 * cleanly from a background sync that may run while the app is not in the foreground.
 *
 * So: a short-lived access JWT that every request carries in an `Authorization` header,
 * plus one refresh row per signed-in device. The access token is deliberately brief —
 * revoking an employee has to take effect in minutes, and the only way to revoke a
 * stateless token is to outlive it.
 *
 * Only the SHA-256 of a refresh token is stored. A dump of `mobile_sessions` therefore
 * cannot be replayed to mint sessions, which is the same reason `password_hash` never
 * holds a password.
 */

/** Same reasoning as the admin service: a wrong email must cost the same as a wrong password. */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9F7d1Y2vgPQ5DR/gPCk6iiCV8AqOb1S';

/** Matches the cost used by employee.service, so an admin-created and a self-registered
 *  account verify in comparable time. */
const BCRYPT_COST = 12;

const ACCESS_AUDIENCE = 'jmk-mobile';
const ISSUER = 'jmk-api';

interface EmployeeAuthRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: EmployeeRole;
  is_active: number;
  approval_status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  /** NULL until the applicant has entered the code emailed to them. */
  email_verified_at: Date | string | null;
}

export type MobileAccessPayload = {
  sub: string;
  role: EmployeeRole;
  name: string;
  email: string;
};

export type MobileSession = {
  accessToken: string;
  /** Seconds until `accessToken` expires, so the client can refresh ahead of time. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
};

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Sign in                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why a sign-in was refused.
 *
 * 'rejected' as a reason is deliberately NOT surfaced as a distinct outcome to the
 * client — see below.
 */
export type SignInRefusal =
  | { reason: 'credentials' }
  /**
   * Registered, password correct, but the address has never been confirmed.
   *
   * Reported ahead of 'pending' because it is the one refusal the applicant can clear
   * themselves. Telling someone their account is awaiting approval when what it is
   * actually waiting for is a code sitting in their own inbox would leave them waiting
   * on an administrator who has nothing to do.
   */
  | { reason: 'emailUnverified' }
  | { reason: 'pending' }
  | { reason: 'rejected'; rejectionReason: string | null }
  | { reason: 'deactivated' };

export type SignInResult =
  | { ok: true; actor: Actor }
  | { ok: false; refusal: SignInRefusal };

/**
 * Verifies credentials and reports why a refusal happened.
 *
 * THE ORDER HERE IS THE SECURITY PROPERTY. The password is verified FIRST, and the
 * account's state is only revealed once it is known to be correct.
 *
 * That matters because self-registration makes "does this email have an account?" a
 * question an outsider might want answered, and the app's endpoint is reachable by
 * anyone who has the APK — which is being handed around on WhatsApp. If a pending
 * account produced "awaiting approval" on any password, the endpoint would be an
 * account-existence oracle. Because the state is only disclosed after a correct
 * password, the only person who learns it is someone who already knows the password,
 * and telling them why they cannot get in is simply honest.
 *
 * A wrong password against a pending, rejected or deactivated account is
 * indistinguishable from a wrong password against an approved one, and from an email
 * with no account at all — the DUMMY_HASH comparison keeps the timing comparable too.
 */
export async function authenticateEmployee(
  emailInput: string,
  password: string,
): Promise<SignInResult> {
  const email = emailInput.trim().toLowerCase();

  const row = await queryOne<EmployeeAuthRow>(
    `SELECT id, name, email, password_hash, role, is_active, approval_status,
            rejection_reason, email_verified_at
       FROM telecaller_users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  const hash = row?.password_hash ?? DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hash).catch(() => false);

  // No account, or the wrong password. One indistinguishable answer.
  if (!row || !passwordMatches) return { ok: false, refusal: { reason: 'credentials' } };

  /*
   * Email verification is checked FIRST, ahead of approval state.
   *
   * Both can be outstanding at once — a fresh registration is unverified AND pending —
   * and the order decides what the app tells the person. Reporting 'pending' would send
   * someone to wait on an administrator when the thing actually blocking them is a code
   * in their own inbox that they can act on immediately.
   *
   * It sits after the password check like every other state, so it cannot be used to
   * discover whether an address has an account.
   */
  if (row.email_verified_at === null) {
    return { ok: false, refusal: { reason: 'emailUnverified' } };
  }

  if (row.approval_status === 'pending') {
    return { ok: false, refusal: { reason: 'pending' } };
  }

  if (row.approval_status === 'rejected') {
    return {
      ok: false,
      refusal: { reason: 'rejected', rejectionReason: row.rejection_reason },
    };
  }

  /*
   * Approved but switched off. Distinct from pending: this is someone who HAD access and
   * an administrator removed it, and telling them "awaiting approval" would send them to
   * wait for something that is never coming.
   */
  if (row.is_active !== 1) {
    return { ok: false, refusal: { reason: 'deactivated' } };
  }

  await execute('UPDATE telecaller_users SET last_login_at = NOW() WHERE id = ?', [row.id]).catch(
    (error) => logger.warn('Could not record last_login_at', describeError(error)),
  );

  return {
    ok: true,
    actor: {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      via: 'bearer',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Self-registration                                                           */
/* -------------------------------------------------------------------------- */

export type RegistrationInput = {
  name: string;
  email: string;
  phone: string | null;
  password: string;
};

export type RegistrationResult =
  /**
   * `userId` is returned so the caller can issue the email verification code without
   * looking the row back up by address. A re-read would be a second query racing the
   * insert it just made, and would have to trust the email as a key at the exact moment
   * duplicate handling is in play.
   */
  | { ok: true; employeeCode: string; userId: number }
  /*
   * A duplicate email is reported plainly. Unlike sign-in, signup MUST tell the user the
   * address is taken or they will retry forever — and it reveals nothing they could not
   * learn by trying to register any address anyway. This is the standard trade for a
   * registration form.
   */
  | { ok: false; reason: 'email_taken' };

/**
 * Registers a telecaller, pending approval.
 *
 * Three things are deliberately NOT taken from the client:
 *
 *   role            — forced to 'telecaller'. Accepting it would let anyone with the APK
 *                     register themselves as an admin, which is the whole system.
 *   is_active       — set to 0, so every existing `is_active = 1` query already excludes
 *                     this account. See migration 010 for why that is the safe shape.
 *   approval_status — set to 'pending'. Nothing self-serve can reach 'approved'.
 *
 * An employee code is allocated now rather than at approval, so the approvals queue can
 * show a real, quotable identifier and the row is never half-formed.
 */
export async function registerEmployee(
  input: RegistrationInput,
): Promise<RegistrationResult> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const employeeCode = await nextEmployeeCode();

    try {
      const inserted = await execute(
        `INSERT INTO telecaller_users
           (employee_code, name, email, phone, password_hash, role,
            is_active, approval_status, registered_at)
         VALUES (?, ?, ?, ?, ?, 'telecaller', 0, 'pending', NOW())`,
        [employeeCode, input.name, email, input.phone, passwordHash],
      );

      logger.info('Employee self-registered, awaiting approval', { employeeCode, email });
      return { ok: true, employeeCode, userId: inserted.insertId };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;

      /*
       * Two unique indexes can collide here. An email clash is terminal and reported;
       * an employee_code clash is a race between two simultaneous registrations, so the
       * code is recomputed and the insert retried.
       */
      if (await emailIsTaken(email)) return { ok: false, reason: 'email_taken' };
    }
  }

  throw new Error('Could not allocate an employee code after three attempts.');
}

async function emailIsTaken(email: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM telecaller_users WHERE email = ?',
    [email],
  );
  return Number(row?.total ?? 0) > 0;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * Next free TC-#### code.
 *
 * Duplicated from employee.repository rather than imported, to keep the auth module free
 * of a dependency on the employee module — importing it the other way round already
 * happens and a cycle would be easy to create here.
 */
async function nextEmployeeCode(): Promise<string> {
  const row = await queryOne<RowDataPacket & { highest: number | null }>(
    `SELECT MAX(CAST(SUBSTRING(employee_code, 4) AS UNSIGNED)) AS highest
       FROM telecaller_users
      WHERE employee_code REGEXP '^TC-[0-9]+$'`,
  );
  const next = Number(row?.highest ?? 0) + 1;
  return `TC-${String(next).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

function signAccessToken(actor: Actor): { token: string; expiresIn: number } {
  const expiresIn = config.mobileAuth.accessTtlMinutes * 60;

  const token = jwt.sign(
    {
      sub: String(actor.id),
      role: actor.role,
      name: actor.name,
      email: actor.email,
    } satisfies MobileAccessPayload,
    config.admin.jwtSecret,
    { expiresIn, issuer: ISSUER, audience: ACCESS_AUDIENCE },
  );

  return { token, expiresIn };
}

/**
 * Verifies an access token.
 *
 * The audience check matters: an admin web session token is signed with the same secret,
 * and without it a cookie token lifted from a browser would be accepted as a mobile
 * Bearer token — bypassing CSRF protection on every admin route.
 */
export function verifyAccessToken(token: string): Actor | null {
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret, {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });

    if (typeof payload === 'string') return null;

    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (typeof payload.role !== 'string' || typeof payload.email !== 'string') return null;

    return {
      id,
      name: typeof payload.name === 'string' ? payload.name : payload.email,
      email: payload.email,
      role: payload.role as EmployeeRole,
      via: 'bearer',
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Refresh sessions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Issues an access token and a brand-new refresh row for one device.
 *
 * THE STATE RE-READ IS THE POINT. Every path that mints a token comes through here, and
 * each one previously trusted whatever the caller had already established:
 *
 *   /auth/login          — had just checked, so it was fine.
 *   /auth/change-password — had NOT. It authenticated with a Bearer token, and a token
 *                          stays valid for its full lifetime after an account is
 *                          deactivated or rejected. So a sacked employee whose handset
 *                          still held a live access token could change their password and
 *                          be issued a fresh 60-day refresh row, restoring access long
 *                          after it was withdrawn.
 *
 * Checking here rather than at each call site means a future token-minting path cannot
 * reintroduce the same hole by omission — it is fail-closed by construction.
 */
export async function createMobileSession(
  actor: Actor,
  device: { name?: string | null; platform?: DevicePlatform; pushToken?: string | null },
): Promise<MobileSession> {
  const state = await queryOne<
    RowDataPacket & { is_active: number; approval_status: string }
  >('SELECT is_active, approval_status FROM telecaller_users WHERE id = ? LIMIT 1', [actor.id]);

  if (!state || state.is_active !== 1 || state.approval_status !== 'approved') {
    logger.warn('Refused to mint a session for an ineligible account', {
      id: actor.id,
      active: state?.is_active,
      approval: state?.approval_status,
    });
    throw new Error('Account is not eligible for a session.');
  }

  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.mobileAuth.refreshTtlDays * 86_400_000);

  await execute(
    `INSERT INTO mobile_sessions
       (user_id, refresh_token_hash, device_name, device_platform, push_token, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      actor.id,
      hashRefreshToken(refreshToken),
      device.name ?? null,
      device.platform ?? 'unknown',
      device.pushToken ?? null,
      expiresAt,
    ],
  );

  const { token, expiresIn } = signAccessToken(actor);

  return {
    accessToken: token,
    expiresIn,
    refreshToken,
    refreshExpiresAt: expiresAt.toISOString(),
  };
}

interface SessionRow extends RowDataPacket {
  id: number;
  user_id: number;
  device_name: string | null;
  device_platform: DevicePlatform;
  push_token: string | null;
  name: string;
  email: string;
  role: EmployeeRole;
  is_active: number;
  approval_status: 'pending' | 'approved' | 'rejected';
}

/**
 * Exchanges a refresh token for a new pair, rotating the stored row.
 *
 * Rotation is not optional. Without it a refresh token captured once is valid for its
 * full sixty days; with it, a stolen token works at most until the real device next
 * refreshes, and the theft shows up as an unexplained sign-out.
 *
 * The employee's `is_active` flag is re-read here rather than trusted from the old
 * token. This is where deactivating someone actually takes effect — at worst one access
 * token's lifetime after the admin clicks the button.
 */
export async function rotateMobileSession(
  refreshToken: string,
): Promise<{ session: MobileSession; actor: Actor } | null> {
  const tokenHash = hashRefreshToken(refreshToken);

  const row = await queryOne<SessionRow>(
    `SELECT s.id, s.user_id, s.device_name, s.device_platform, s.push_token,
            u.name, u.email, u.role, u.is_active, u.approval_status
       FROM mobile_sessions s
       JOIN telecaller_users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );

  /*
   * approval_status is re-checked alongside is_active, not instead of it. A pending
   * account can never have obtained a refresh token in the first place, but an approved
   * account that is later REJECTED would still hold one — and this is the point at which
   * that revocation has to bite.
   */
  if (!row || row.is_active !== 1 || row.approval_status !== 'approved') {
    // A presented-but-unknown token is worth noticing: it is either a replayed old
    // token or a deactivated account still trying. Not an error the client can fix.
    logger.warn('Mobile refresh rejected', { known: Boolean(row) });
    return null;
  }

  const actor: Actor = {
    id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    via: 'bearer',
  };

  const nextToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.mobileAuth.refreshTtlDays * 86_400_000);

  // Update in place rather than insert-and-revoke: one row per device, so the session
  // list an employee sees does not fill with dead entries every fifteen minutes.
  const result = await execute(
    `UPDATE mobile_sessions
        SET refresh_token_hash = ?, expires_at = ?, last_used_at = NOW()
      WHERE id = ? AND revoked_at IS NULL`,
    [hashRefreshToken(nextToken), expiresAt, row.id],
  );

  // Lost a race with a concurrent refresh or a sign-out. Refuse rather than issue a
  // token against a row that no longer holds the hash we just wrote.
  if (result.affectedRows === 0) return null;

  const { token, expiresIn } = signAccessToken(actor);

  return {
    actor,
    session: {
      accessToken: token,
      expiresIn,
      refreshToken: nextToken,
      refreshExpiresAt: expiresAt.toISOString(),
    },
  };
}

/** Sign-out for one device. Also clears the push token so the handset goes quiet. */
export async function revokeMobileSession(refreshToken: string): Promise<void> {
  await execute(
    `UPDATE mobile_sessions
        SET revoked_at = NOW(), push_token = NULL
      WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
    [hashRefreshToken(refreshToken)],
  );
}

/**
 * Revokes every device for one employee.
 *
 * Called when an admin deactivates an account or changes someone's password. Access
 * tokens already issued stay valid until they expire — which is why they are short.
 */
export async function revokeAllMobileSessions(userId: number): Promise<number> {
  const result = await execute(
    `UPDATE mobile_sessions
        SET revoked_at = NOW(), push_token = NULL
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );
  return result.affectedRows;
}

/** Registers or clears the Expo push token for the device holding this refresh token. */
export async function setPushToken(
  refreshToken: string,
  pushToken: string | null,
): Promise<boolean> {
  const result = await execute(
    `UPDATE mobile_sessions
        SET push_token = ?
      WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
    [pushToken, hashRefreshToken(refreshToken)],
  );
  return result.affectedRows > 0;
}

/**
 * Deletes refresh rows that expired or were revoked long ago.
 *
 * Called opportunistically at sign-in rather than on a schedule: the table is small,
 * this keeps it small, and it means there is no cron job to forget to install. Failure
 * is logged and ignored — a sign-in must never fail because housekeeping did.
 */
export async function pruneMobileSessions(): Promise<void> {
  await execute(
    `DELETE FROM mobile_sessions
      WHERE (expires_at < (NOW() - INTERVAL 7 DAY))
         OR (revoked_at IS NOT NULL AND revoked_at < (NOW() - INTERVAL 7 DAY))`,
  ).catch((error) => logger.warn('Session prune failed', describeError(error)));
}
