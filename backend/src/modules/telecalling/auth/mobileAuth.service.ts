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

const ACCESS_AUDIENCE = 'jmk-mobile';
const ISSUER = 'jmk-api';

interface EmployeeAuthRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: EmployeeRole;
  is_active: number;
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
 * Verifies credentials. Returns the identity on success, null on any failure.
 *
 * Never reports *which* factor failed, and never distinguishes a deactivated account
 * from a wrong password — either would let an outsider enumerate the staff list.
 */
export async function authenticateEmployee(
  emailInput: string,
  password: string,
): Promise<Actor | null> {
  const email = emailInput.trim().toLowerCase();

  const row = await queryOne<EmployeeAuthRow>(
    `SELECT id, name, email, password_hash, role, is_active
       FROM telecaller_users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  const hash = row?.password_hash ?? DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hash).catch(() => false);

  if (!row || !passwordMatches || row.is_active !== 1) return null;

  await execute('UPDATE telecaller_users SET last_login_at = NOW() WHERE id = ?', [row.id]).catch(
    (error) => logger.warn('Could not record last_login_at', describeError(error)),
  );

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    via: 'bearer',
  };
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

/** Issues an access token and a brand-new refresh row for one device. */
export async function createMobileSession(
  actor: Actor,
  device: { name?: string | null; platform?: DevicePlatform; pushToken?: string | null },
): Promise<MobileSession> {
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
            u.name, u.email, u.role, u.is_active
       FROM mobile_sessions s
       JOIN telecaller_users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );

  if (!row || row.is_active !== 1) {
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
