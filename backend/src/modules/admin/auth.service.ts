import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { config } from '../../config/env';
import { execute, queryOne, type RowDataPacket } from '../../db/pool';
import { describeError, logger } from '../../utils/logger';

/**
 * Admin authentication.
 *
 * Credentials come from the `admin_users` table when it holds a matching row, and
 * otherwise fall back to ADMIN_EMAIL / ADMIN_PASSWORD_HASH from the environment.
 * Either way the password is only ever compared against a bcrypt hash — no plaintext
 * password exists in the codebase or the database.
 */

interface AdminRow extends RowDataPacket {
  id: number;
  email: string;
  password_hash: string;
  is_active: number;
}

/**
 * Compared against when no account matches, so a wrong email and a wrong password take
 * the same amount of time and cannot be told apart.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9F7d1Y2vgPQ5DR/gPCk6iiCV8AqOb1S';

export type AdminIdentity = { email: string };

async function findDatabaseAdmin(email: string): Promise<AdminRow | null> {
  try {
    return await queryOne<AdminRow>(
      'SELECT id, email, password_hash, is_active FROM admin_users WHERE email = ? LIMIT 1',
      [email],
    );
  } catch (error) {
    // A missing table or unavailable database must not break the env-based fallback.
    logger.warn('admin_users lookup failed; falling back to environment credentials', describeError(error));
    return null;
  }
}

/** Returns the identity on success, or null. Never reveals which factor failed. */
export async function authenticate(
  emailInput: string,
  password: string,
): Promise<AdminIdentity | null> {
  const email = emailInput.trim().toLowerCase();

  const record = await findDatabaseAdmin(email);

  let hash = DUMMY_HASH;
  let active = false;

  if (record) {
    hash = record.password_hash;
    active = record.is_active === 1;
  } else if (config.admin.email && config.admin.passwordHash && email === config.admin.email) {
    hash = config.admin.passwordHash;
    active = true;
  }

  const passwordMatches = await bcrypt.compare(password, hash).catch(() => false);

  if (!passwordMatches || !active) return null;

  if (record) {
    await execute('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [record.id]).catch(
      (error) => logger.warn('Could not record last_login_at', describeError(error)),
    );
  }

  return { email };
}

export type SessionPayload = {
  sub: string;
  csrf: string;
};

/** Issues a signed session token plus the CSRF token bound to it. */
export function createSession(identity: AdminIdentity): { token: string; csrf: string } {
  const csrf = crypto.randomBytes(24).toString('hex');
  const token = jwt.sign({ sub: identity.email, csrf } satisfies SessionPayload, config.admin.jwtSecret, {
    expiresIn: `${config.admin.sessionTtlHours}h`,
    issuer: 'jmk-api',
    audience: 'jmk-admin',
  });

  return { token, csrf };
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret, {
      issuer: 'jmk-api',
      audience: 'jmk-admin',
    });

    if (typeof payload === 'string' || !payload.sub || typeof payload.csrf !== 'string') return null;

    return { sub: String(payload.sub), csrf: payload.csrf };
  } catch {
    return null;
  }
}

const baseCookieOptions = {
  sameSite: config.admin.cookieSameSite,
  secure: config.isProduction || config.admin.cookieSameSite === 'none',
  path: '/',
} as const;

export function setSessionCookies(response: Response, token: string, csrf: string): void {
  const maxAge = config.admin.sessionTtlHours * 60 * 60 * 1000;

  // Session token: not readable by JavaScript.
  response.cookie(config.admin.sessionCookieName, token, {
    ...baseCookieOptions,
    httpOnly: true,
    maxAge,
  });

  // CSRF token: deliberately readable so the client can echo it back in a header.
  response.cookie(config.admin.csrfCookieName, csrf, {
    ...baseCookieOptions,
    httpOnly: false,
    maxAge,
  });
}

export function clearSessionCookies(response: Response): void {
  response.clearCookie(config.admin.sessionCookieName, { ...baseCookieOptions, httpOnly: true });
  response.clearCookie(config.admin.csrfCookieName, { ...baseCookieOptions, httpOnly: false });
}

/** True when at least one admin credential source is configured. */
export async function isAdminConfigured(): Promise<boolean> {
  if (config.admin.email && config.admin.passwordHash) return true;

  try {
    const row = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM admin_users WHERE is_active = 1',
    );
    return (row?.total ?? 0) > 0;
  } catch {
    return false;
  }
}
