#!/usr/bin/env node
/**
 * Grants an admin account access to the telecalling system.
 *
 *   npm run admin:link                       # uses ADMIN_LOGIN_EMAIL
 *   npm run admin:link -- someone@jmk.com    # or a specific address
 *   npm run admin:link -- someone@jmk.com --name "Priya Nair" --role manager
 *
 * SAFE TO RUN ON PRODUCTION. It inserts or updates exactly one row and never deletes
 * anything. This is deliberately NOT `db:seed:telecalling`, which begins by emptying
 * every telecalling table and on a live server would destroy real leads, calls and
 * follow-ups.
 *
 * Why it is needed at all:
 *
 * Signing in to the website admin proves an email address — the credentials come from the
 * `admin_users` table, or from ADMIN_PASSWORD_HASH when that table has no matching row.
 * Authority over the telecalling module is separate: `src/middleware/actor.ts` takes the
 * session's email and requires an active, approved row in `telecaller_users` before it
 * will let the request touch a lead. That separation is on purpose — reading website
 * enquiries and working customer records are different jobs — but it means an
 * administrator who has only ever signed in to the website gets
 *
 *     "This account is not set up for the telecalling system."
 *
 * on every telecalling screen, with no way out from the UI, because the Employees screen
 * that would add the row is itself behind the same check.
 *
 * Written as plain Node against `dist/`, not TypeScript against `src/`. `tsx` is a
 * devDependency and the deploy runs `npm prune --omit=dev`, so a .ts script cannot run on
 * the server at all — which is the one place this is actually needed. Importing the
 * built modules also means the pool configuration and the employee-code allocator are
 * the same code the service uses.
 */
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const nodeEnv = process.env.NODE_ENV ?? 'development';
dotenv.config();
dotenv.config({ path: `.env.${nodeEnv}`, override: true });

for (const relative of [
  'dist/db/pool.js',
  'dist/modules/telecalling/employees/employee.repository.js',
  'dist/modules/telecalling/shared.schema.js',
]) {
  if (!existsSync(resolve(relative))) {
    console.error(`Missing ${relative}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

const load = (relative) => import(pathToFileURL(resolve(relative)).href);

const { closePool, execute, queryOne } = await load('dist/db/pool.js');
const { nextEmployeeCode } = await load(
  'dist/modules/telecalling/employees/employee.repository.js',
);
const { EMPLOYEE_ROLES } = await load('dist/modules/telecalling/shared.schema.js');

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);

const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const positional = argv.find((value) => !value.startsWith('--') && value.includes('@'));
const email = (positional ?? process.env.ADMIN_LOGIN_EMAIL ?? process.env.ADMIN_EMAIL ?? '')
  .trim()
  .toLowerCase();

function fail(message) {
  console.error(`\n${message}\n`);
  void closePool();
  process.exit(1);
}

if (!email) {
  fail(
    'No email given and neither ADMIN_LOGIN_EMAIL nor ADMIN_EMAIL is set.\n' +
      '  Usage: npm run admin:link -- someone@example.com',
  );
}

if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) {
  fail(`"${email}" does not look like an email address.`);
}

const role = (flag('role') ?? 'admin').trim();
if (!EMPLOYEE_ROLES.includes(role)) {
  fail(`Unknown role "${role}". One of: ${EMPLOYEE_ROLES.join(', ')}`);
}

/*
 * The name defaults to the local part of the address rather than something like
 * "Administrator", because it is shown to telecallers as the person who assigned them a
 * lead, and a row nobody can attribute is worse than an ugly one.
 */
const name = (flag('name') ?? email.split('@')[0] ?? 'Administrator').trim();

/* -------------------------------------------------------------------------- */
/* Link                                                                        */
/* -------------------------------------------------------------------------- */

try {
  console.log(`Database: ${process.env.DB_NAME ?? '(default)'}  NODE_ENV: ${nodeEnv}`);
  console.log(`Linking:  ${email} as ${role}\n`);

  const existing = await queryOne(
    `SELECT id, employee_code, name, role, is_active, approval_status
       FROM telecaller_users
      WHERE email = ?
      LIMIT 1`,
    [email],
  );

  if (existing) {
    /*
     * Already present. Only the three fields that gate access are touched, and only when
     * they are wrong — the name, phone and employee code are left exactly as they are,
     * because a real person may have edited them and this script has no business
     * overwriting that.
     */
    const changes = [];
    if (existing.is_active !== 1) changes.push('reactivated');
    if (existing.approval_status !== 'approved') {
      changes.push(`approval ${existing.approval_status} -> approved`);
    }
    if (existing.role !== role) changes.push(`role ${existing.role} -> ${role}`);

    if (changes.length === 0) {
      console.log(`  ${email} is already an active, approved ${existing.role}.`);
      console.log(`  Employee code ${existing.employee_code}. Nothing to do.`);
      console.log('\n  If the telecalling screens still refuse the account, the signed-in');
      console.log('  email differs from this one — check the address shown at the bottom of');
      console.log('  the admin sidebar, which is what the session actually carries.');
    } else {
      await execute(
        `UPDATE telecaller_users
            SET is_active = 1, approval_status = 'approved', rejection_reason = NULL,
                approved_at = COALESCE(approved_at, NOW()), role = ?
          WHERE id = ?`,
        [role, existing.id],
      );
      console.log(`  Updated ${existing.employee_code}: ${changes.join(', ')}.`);
    }
  } else {
    /*
     * A random, discarded password.
     *
     * The column is NOT NULL and the mobile app is the only thing that reads it, so this
     * row gets a value nobody holds rather than a guessable placeholder. It is never
     * printed: an account that cannot be signed into from the app is the correct state
     * for a web administrator, and one that could would be a credential invented by a
     * script and left in a shell history.
     */
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64'), 10);
    const employeeCode = await nextEmployeeCode();

    await execute(
      `INSERT INTO telecaller_users
         (employee_code, name, email, password_hash, role, availability,
          is_active, approval_status, approved_at)
       VALUES (?, ?, ?, ?, ?, 'offline', 1, 'approved', NOW())`,
      [employeeCode, name, email, passwordHash, role],
    );

    console.log(`  Created ${employeeCode} — ${name} <${email}> as ${role}.`);
    console.log('\n  The telecalling screens will work on the next page load.');
    console.log('  No mobile-app password was set. If this person needs the app too,');
    console.log('  reset their password from Employees in the admin.');
  }
} catch (error) {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
