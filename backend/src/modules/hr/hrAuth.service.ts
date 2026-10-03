import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { execute, queryOne, type RowDataPacket } from '../../db/pool';
import { describeError, logger } from '../../utils/logger';
import type { DevicePlatform, HrRole } from './hr.schema';

/**
 * Authentication for the HR app.
 *
 * A deliberate near-twin of the telecalling mobile auth service, and deliberately NOT a
 * shared abstraction over both. The two differ in exactly the places that matter —
 * table, token audience, role set — and the point of migration 017 is that neither can
 * reach the other's accounts. A shared implementation parameterised by table name would
 * put both products one wrong argument away from authenticating against the other's
 * user table, which is the single failure this design exists to make impossible.
 *
 * What IS shared is the signing secret, and the `audience` claim is what keeps the
 * token families apart:
 *
 *   jmk-admin   — admin web cookie session
 *   jmk-mobile  — telecaller app
 *   jmk-hr      — this app
 *
 * `verifyHrAccessToken` pins the audience, so a telecaller's Bearer token is not merely
 * unprivileged on an HR route — it fails verification outright. The reverse holds in
 * `verifyAccessToken` on the telecalling side.
 */

/** A wrong email must cost the same as a wrong password. Same constant, same reason. */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9F7d1Y2vgPQ5DR/gPCk6iiCV8AqOb1S';

const BCRYPT_COST = 12;

const ACCESS_AUDIENCE = 'jmk-hr';
const ISSUER = 'jmk-api';

/** Code series for HR accounts, counted independently of the telecalling TC- series. */
const CODE_PREFIX = 'EMP-';

interface HrAuthRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: HrRole;
  is_active: number;
  approval_status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  email_verified_at: Date | string | null;
}

/**
 * Who is making an HR request.
 *
 * Bearer only — there is no cookie path. The admin web app manages HR accounts through
 * `/api/admin/hr`, which authenticates as an administrator, not as an HR employee.
 */
export type HrActor = {
  id: number;
  name: string;
  email: string;
  role: HrRole;
};

export type HrAccessPayload = {
  sub: string;
  role: HrRole;
  name: string;
  email: string;
};

export type HrSession = {
  accessToken: string;
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

export type HrSignInRefusal =
  | { reason: 'credentials' }
  | { reason: 'emailUnverified' }
  | { reason: 'pending' }
  | { reason: 'rejected'; rejectionReason: string | null }
  | { reason: 'deactivated' };

export type HrSignInResult =
  | { ok: true; actor: HrActor }
  | { ok: false; refusal: HrSignInRefusal };

/**
 * Verifies credentials and reports why a refusal happened.
 *
 * THE ORDER IS THE SECURITY PROPERTY, exactly as on the telecalling side. The password
 * is checked FIRST and account state is disclosed only once it is known to be correct,
 * so this endpoint cannot be used to discover which addresses have HR accounts. A wrong
 * password against a pending account is indistinguishable from a wrong password against
 * an approved one, and from an address with no account at all.
 *
 * Email verification is reported ahead of approval because it is the one refusal the
 * person can clear themselves — telling them to wait for an administrator when the
 * thing blocking them is a code in their own inbox sends them to wait for nothing.
 */
export async function authenticateHrUser(
  emailInput: string,
  password: string,
): Promise<HrSignInResult> {
  const email = emailInput.trim().toLowerCase();

  const row = await queryOne<HrAuthRow>(
    `SELECT id, name, email, password_hash, role, is_active, approval_status,
            rejection_reason, email_verified_at
       FROM hr_users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  const hash = row?.password_hash ?? DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hash).catch(() => false);

  if (!row || !passwordMatches) return { ok: false, refusal: { reason: 'credentials' } };

  if (row.email_verified_at === null) {
    return { ok: false, refusal: { reason: 'emailUnverified' } };
  }

  if (row.approval_status === 'pending') return { ok: false, refusal: { reason: 'pending' } };

  if (row.approval_status === 'rejected') {
    return { ok: false, refusal: { reason: 'rejected', rejectionReason: row.rejection_reason } };
  }

  if (row.is_active !== 1) return { ok: false, refusal: { reason: 'deactivated' } };

  await execute('UPDATE hr_users SET last_login_at = NOW() WHERE id = ?', [row.id]).catch(
    (error) => logger.warn('Could not record HR last_login_at', describeError(error)),
  );

  return {
    ok: true,
    actor: { id: row.id, name: row.name, email: row.email, role: row.role },
  };
}

/* -------------------------------------------------------------------------- */
/* Self-registration                                                           */
/* -------------------------------------------------------------------------- */

export type HrRegistrationInput = {
  name: string;
  email: string;
  phone: string | null;
  password: string;
};

export type HrRegistrationResult =
  | { ok: true; employeeCode: string; userId: number }
  | { ok: false; reason: 'email_taken' };

/**
 * Registers an HR employee, pending approval.
 *
 * Note what is NOT taken from the client — there is no `role` parameter at all, not even
 * a restricted one. Every self-registration is an `employee`; `hr_manager` and
 * `hr_admin` are granted by an administrator afterwards. The telecalling signup accepts
 * a narrowed `requestedRole` because it had to serve two workforces from one endpoint;
 * this one serves exactly one, so the safest shape is for the field not to exist.
 *
 * `is_active = 0` and `approval_status = 'pending'` are written explicitly even though
 * the column defaults match. These two are the whole access boundary and should not
 * depend on a default somebody could change in a later migration.
 */
export async function registerHrUser(
  input: HrRegistrationInput,
): Promise<HrRegistrationResult> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const employeeCode = await nextHrEmployeeCode();

    try {
      const inserted = await execute(
        `INSERT INTO hr_users
           (employee_code, name, email, phone, password_hash, role,
            is_active, approval_status, registered_at)
         VALUES (?, ?, ?, ?, ?, 'employee', 0, 'pending', NOW())`,
        [employeeCode, input.name, email, input.phone, passwordHash],
      );

      logger.info('HR employee self-registered, awaiting approval', { employeeCode, email });
      return { ok: true, employeeCode, userId: inserted.insertId };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;

      // Two unique indexes can collide. An email clash is terminal; an employee_code
      // clash is a race with a simultaneous registration, so recompute and retry.
      if (await hrEmailIsTaken(email)) return { ok: false, reason: 'email_taken' };
    }
  }

  throw new Error('Could not allocate an HR employee code after three attempts.');
}

async function hrEmailIsTaken(email: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_users WHERE email = ?',
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
 * Next free code in the EMP- series.
 *
 * Scoped to `hr_users`, so it counts only HR accounts. The offset is derived from the
 * prefix with `LENGTH()` rather than hard-coded — a literal would be wrong the moment
 * the prefix changed length, and the failure mode is handing every registration the
 * same code until the unique index rejects it three times and signup fails.
 */
async function nextHrEmployeeCode(): Promise<string> {
  const row = await queryOne<RowDataPacket & { highest: number | null }>(
    `SELECT MAX(CAST(SUBSTRING(employee_code, LENGTH(?) + 1) AS UNSIGNED)) AS highest
       FROM hr_users
      WHERE employee_code REGEXP ?`,
    [CODE_PREFIX, `^${CODE_PREFIX}[0-9]+$`],
  );

  const next = Number(row?.highest ?? 0) + 1;
  return `${CODE_PREFIX}${String(next).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

function signHrAccessToken(actor: HrActor): { token: string; expiresIn: number } {
  const expiresIn = config.mobileAuth.accessTtlMinutes * 60;

  const token = jwt.sign(
    {
      sub: String(actor.id),
      role: actor.role,
      name: actor.name,
      email: actor.email,
    } satisfies HrAccessPayload,
    config.admin.jwtSecret,
    { expiresIn, issuer: ISSUER, audience: ACCESS_AUDIENCE },
  );

  return { token, expiresIn };
}

/**
 * Verifies an HR access token.
 *
 * The audience pin is the cross-app boundary. All three token families are signed with
 * the same secret, so without it a telecaller's Bearer token — or an admin cookie value
 * replayed in the header — would verify here and be accepted as an HR employee whose
 * `sub` happens to collide with an `hr_users` id.
 */
export function verifyHrAccessToken(token: string): HrActor | null {
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
      role: payload.role as HrRole,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Refresh sessions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Issues an access token and a fresh refresh row for one device.
 *
 * The eligibility re-read is not optional. Every path that mints a token comes through
 * here, including change-password, which authenticates with a Bearer token — and a
 * token stays valid for its whole lifetime after an account is deactivated. Without
 * this check, someone offboarded whose handset still held a live access token could
 * change their password and be handed a brand-new 60-day refresh row.
 */
export async function createHrSession(
  actor: HrActor,
  device: { name?: string | null; platform?: DevicePlatform; pushToken?: string | null },
): Promise<HrSession> {
  const state = await queryOne<RowDataPacket & { is_active: number; approval_status: string }>(
    'SELECT is_active, approval_status FROM hr_users WHERE id = ? LIMIT 1',
    [actor.id],
  );

  if (!state || state.is_active !== 1 || state.approval_status !== 'approved') {
    logger.warn('Refused to mint an HR session for an ineligible account', {
      id: actor.id,
      active: state?.is_active,
      approval: state?.approval_status,
    });
    throw new Error('Account is not eligible for a session.');
  }

  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.mobileAuth.refreshTtlDays * 86_400_000);

  await execute(
    `INSERT INTO hr_sessions
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

  const { token, expiresIn } = signHrAccessToken(actor);

  return {
    accessToken: token,
    expiresIn,
    refreshToken,
    refreshExpiresAt: expiresAt.toISOString(),
  };
}

interface HrSessionRow extends RowDataPacket {
  id: number;
  user_id: number;
  name: string;
  email: string;
  role: HrRole;
  is_active: number;
  approval_status: 'pending' | 'approved' | 'rejected';
}

/**
 * Exchanges a refresh token for a new pair, rotating the stored row.
 *
 * Rotation is what bounds the damage of a captured token: without it a stolen refresh
 * token is good for its full sixty days; with it, it works until the real device next
 * refreshes, and the theft surfaces as an unexplained sign-out.
 *
 * `is_active` and `approval_status` are re-read rather than trusted from the old token.
 * This is where deactivating an HR account actually bites.
 */
export async function rotateHrSession(
  refreshToken: string,
): Promise<{ session: HrSession; actor: HrActor } | null> {
  const tokenHash = hashRefreshToken(refreshToken);

  const row = await queryOne<HrSessionRow>(
    `SELECT s.id, s.user_id, u.name, u.email, u.role, u.is_active, u.approval_status
       FROM hr_sessions s
       JOIN hr_users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );

  if (!row || row.is_active !== 1 || row.approval_status !== 'approved') {
    logger.warn('HR refresh rejected', { known: Boolean(row) });
    return null;
  }

  const actor: HrActor = {
    id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
  };

  const nextToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.mobileAuth.refreshTtlDays * 86_400_000);

  const result = await execute(
    `UPDATE hr_sessions
        SET refresh_token_hash = ?, expires_at = ?, last_used_at = NOW()
      WHERE id = ? AND revoked_at IS NULL`,
    [hashRefreshToken(nextToken), expiresAt, row.id],
  );

  // Lost a race with a concurrent refresh or a sign-out. Refuse rather than issue a
  // token against a row that no longer holds the hash just written.
  if (result.affectedRows === 0) return null;

  const { token, expiresIn } = signHrAccessToken(actor);

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

/** Sign-out for one device. */
export async function revokeHrSession(refreshToken: string): Promise<void> {
  await execute(
    `UPDATE hr_sessions
        SET revoked_at = NOW(), push_token = NULL
      WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
    [hashRefreshToken(refreshToken)],
  );
}

/** Revokes every device for one HR employee. Used on deactivation and password change. */
export async function revokeAllHrSessions(userId: number): Promise<number> {
  const result = await execute(
    `UPDATE hr_sessions
        SET revoked_at = NOW(), push_token = NULL
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );
  return result.affectedRows;
}

/**
 * Changes an HR employee's own password.
 *
 * Verifies the current password, then revokes every device — including the one making
 * the request, which is why the route issues a fresh session afterwards. Returns false
 * for a wrong current password so the route can answer without distinguishing it from
 * any other refusal.
 */
export async function changeOwnHrPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { password_hash: string }>(
    'SELECT password_hash FROM hr_users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!row) return false;

  const matches = await bcrypt.compare(currentPassword, row.password_hash).catch(() => false);
  if (!matches) return false;

  await execute('UPDATE hr_users SET password_hash = ? WHERE id = ?', [
    await bcrypt.hash(newPassword, BCRYPT_COST),
    userId,
  ]);

  await revokeAllHrSessions(userId);
  logger.info('HR password changed', { userId });
  return true;
}

/**
 * Deletes refresh rows that expired or were revoked long ago.
 *
 * Opportunistic, at sign-in, rather than a scheduled job that has to be installed and
 * remembered. Failure is logged and swallowed — a sign-in must never fail because
 * housekeeping did.
 */
export async function pruneHrSessions(): Promise<void> {
  await execute(
    `DELETE FROM hr_sessions
      WHERE (expires_at < (NOW() - INTERVAL 7 DAY))
         OR (revoked_at IS NOT NULL AND revoked_at < (NOW() - INTERVAL 7 DAY))`,
  ).catch((error) => logger.warn('HR session prune failed', describeError(error)));
}
