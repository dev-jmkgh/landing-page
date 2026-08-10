import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment configuration.
 *
 * Everything the API needs is validated once, at startup, so a misconfigured
 * deployment fails immediately and loudly instead of at the first request.
 */

const booleanish = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  TRUST_PROXY: booleanish.default('0'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('jmk_global'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().max(50).default(10),

  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: booleanish.default('true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM_NAME: z.string().default('JMK Global Holdings Website'),
  /** Falls back to SMTP_USER, which is the address Gmail sends as anyway. */
  SMTP_FROM_EMAIL: z.string().default(''),

  /**
   * The single source of truth for administrative notification recipients — website
   * enquiries and career applications alike. Comma-separated; every address receives
   * every notification. No address is hard-coded as a default.
   */
  ADMIN_EMAILS: z.string().default(''),

  /**
   * Sign-in identity for the fallback admin account. This is a *credential*, not a
   * notification recipient — it is deliberately not named ADMIN_EMAIL any more,
   * because one letter of difference from ADMIN_EMAILS is too easy to misread.
   * ADMIN_EMAIL is still accepted for existing deployments.
   */
  ADMIN_LOGIN_EMAIL: z.string().default(''),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD_HASH: z.string().default(''),
  JWT_SECRET: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(8),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  RECAPTCHA_SECRET_KEY: z.string().default(''),
  RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  /** Reject the submission when Google cannot be reached. Default: fail open. */
  RECAPTCHA_FAIL_CLOSED: booleanish.default('0'),

  UPLOAD_DIR: z.string().default('storage/resumes'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(5),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  FORM_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';

/**
 * In production a weak or missing signing secret would silently downgrade admin
 * authentication, so refuse to start instead.
 */
if (isProduction && raw.JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET must be set to at least 32 characters in production. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
}

if (isProduction && !raw.ADMIN_PASSWORD_HASH && !raw.DATABASE_URL && !raw.DB_PASSWORD) {
  // Not fatal — the admin_users table may hold the credentials — but worth flagging.
  console.warn('[config] No ADMIN_PASSWORD_HASH set; admin sign-in relies on the admin_users table.');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/**
 * Parses ADMIN_EMAILS into the list of administrative notification recipients.
 *
 * Recipients are deliberately never hard-coded: an address baked into the source would
 * silently keep delivering to the wrong inbox after the business changes it. Invalid
 * entries are dropped with a warning rather than failing startup, so one typo in a list
 * of four cannot take the whole API down — but an empty result is reported loudly,
 * because it means notifications will be skipped.
 */
function parseAdminEmails(value: string): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];

  for (const entry of value.split(',')) {
    const address = entry.trim();
    if (!address) continue;

    if (!EMAIL_PATTERN.test(address)) {
      console.warn(`[config] ADMIN_EMAILS contains an invalid address and it was ignored: ${address}`);
      continue;
    }

    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(address);
  }

  return valid;
}

const adminEmails = parseAdminEmails(raw.ADMIN_EMAILS);

if (adminEmails.length === 0) {
  console.error(
    '[config] ADMIN_EMAILS is empty or contains no valid address. Enquiries and career ' +
      'applications will still be validated and stored, but no notification will be sent. ' +
      'Set ADMIN_EMAILS in the backend .env file, e.g. ADMIN_EMAILS=info@example.com,hr@example.com',
  );
}

/**
 * These configured recipients were replaced by the single ADMIN_EMAILS list. A
 * deployment still carrying them would otherwise lose notifications with no clue why,
 * so name them explicitly instead of ignoring them in silence.
 */
for (const legacy of ['ENQUIRY_RECEIVER_EMAIL', 'CONTACT_EMAIL', 'CAREERS_EMAIL'] as const) {
  if ((process.env[legacy] ?? '').trim()) {
    console.error(
      `[config] ${legacy} is no longer used and its value is being ignored. ` +
        'Move the address into ADMIN_EMAILS (comma-separated) and delete this line from .env.',
    );
  }
}

function parseDatabaseUrl(url: string) {
  const parsedUrl = new URL(url);
  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : 3306,
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
    database: parsedUrl.pathname.replace(/^\//, ''),
  };
}

const database = raw.DATABASE_URL
  ? parseDatabaseUrl(raw.DATABASE_URL)
  : {
      host: raw.DB_HOST,
      port: raw.DB_PORT,
      user: raw.DB_USER,
      password: raw.DB_PASSWORD,
      database: raw.DB_NAME,
    };

export const config = {
  env: raw.NODE_ENV,
  isProduction,
  isDevelopment: raw.NODE_ENV === 'development',
  port: raw.PORT,
  trustProxy: raw.TRUST_PROXY,
  logLevel: raw.LOG_LEVEL,

  appUrl: raw.APP_URL.replace(/\/+$/, ''),
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  database: {
    ...database,
    connectionLimit: raw.DB_CONNECTION_LIMIT,
  },

  smtp: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    secure: raw.SMTP_SECURE,
    user: raw.SMTP_USER,
    password: raw.SMTP_PASSWORD,
    fromName: raw.SMTP_FROM_NAME,
    // Gmail rewrites the envelope sender to the authenticated account unless the
    // address is a verified alias, so defaulting to SMTP_USER matches reality.
    fromEmail: raw.SMTP_FROM_EMAIL.trim() || raw.SMTP_USER || (adminEmails[0] ?? ''),
    /** Email is optional in development; the API stays fully functional without it. */
    enabled: Boolean(raw.SMTP_USER && raw.SMTP_PASSWORD),
  },

  mail: {
    /**
     * Everyone who receives administrative notifications — enquiries and career
     * applications both. This is the only recipient configuration in the project.
     */
    adminRecipients: adminEmails,
  },

  admin: {
    email: (raw.ADMIN_LOGIN_EMAIL.trim() || raw.ADMIN_EMAIL.trim()).toLowerCase(),
    passwordHash: raw.ADMIN_PASSWORD_HASH,
    jwtSecret: raw.JWT_SECRET || 'development-only-insecure-secret-change-me',
    sessionTtlHours: raw.SESSION_TTL_HOURS,
    cookieSameSite: raw.COOKIE_SAMESITE,
    sessionCookieName: 'jmk_session',
    csrfCookieName: 'jmk_csrf',
  },

  recaptcha: {
    secretKey: raw.RECAPTCHA_SECRET_KEY,
    /** Verification is skipped entirely without a secret, so development needs no keys. */
    enabled: raw.RECAPTCHA_SECRET_KEY.trim().length > 0,
    minimumScore: raw.RECAPTCHA_MIN_SCORE,
    failClosed: raw.RECAPTCHA_FAIL_CLOSED,
  },

  uploads: {
    directory: path.isAbsolute(raw.UPLOAD_DIR)
      ? raw.UPLOAD_DIR
      : path.resolve(process.cwd(), raw.UPLOAD_DIR),
    maxBytes: Math.round(raw.MAX_UPLOAD_MB * 1024 * 1024),
    maxSizeLabel: `${raw.MAX_UPLOAD_MB} MB`,
    allowedExtensions: ['.pdf', '.doc', '.docx'] as const,
    allowedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ] as const,
  },

  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: raw.RATE_LIMIT_MAX_REQUESTS,
    formMax: raw.FORM_RATE_LIMIT_MAX,
    loginMax: raw.LOGIN_RATE_LIMIT_MAX,
  },
} as const;

export type AppConfig = typeof config;
