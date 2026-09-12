#!/usr/bin/env node
/**
 * Sets the password on an `admin_users` row.
 *
 *   npm run admin:password                        # ADMIN_LOGIN_EMAIL, prompts for the password
 *   npm run admin:password -- someone@jmk.com     # a specific address, prompts
 *   npm run admin:password -- someone@jmk.com --create   # insert the row if absent
 *
 * SAFE TO RUN ON PRODUCTION. It touches exactly one row and never deletes anything.
 *
 * Why this script exists
 * ----------------------
 * Changing ADMIN_PASSWORD_HASH in the environment and redeploying appears to do nothing,
 * and the reason is precedence. `src/modules/admin/auth.service.ts` reads:
 *
 *     const record = await findDatabaseAdmin(email);
 *     if (record)      hash = record.password_hash;      // the table wins
 *     else if (...)    hash = config.admin.passwordHash; // env is only a fallback
 *
 * So once an address exists in `admin_users`, the environment variable is never consulted
 * again. Production has such a row — `npm run admin:link` creates the telecalling side of
 * the same account — which is exactly when people reach for the env var and find it inert.
 * This writes to the place the check actually reads.
 *
 * The password is read from a prompt rather than taken as an argument, so it does not end
 * up in `~/.bash_history`, in `ps` output, or in a deploy log. `--stdin` is there for
 * piping from a password manager.
 *
 * Written as plain Node against `dist/`, not TypeScript against `src/`. `tsx` is a
 * devDependency and the deploy runs `npm prune --omit=dev`, so a .ts script cannot run on
 * the server at all — which is the one place this is needed.
 */
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/* Same layering the service uses: `.env`, then `.env.<NODE_ENV>` on top. */
const nodeEnv = process.env.NODE_ENV ?? 'development';
dotenv.config();
dotenv.config({ path: `.env.${nodeEnv}`, override: true });

const POOL = 'dist/db/pool.js';

if (!existsSync(resolve(POOL))) {
  console.error(`Missing ${POOL}. Run \`npm run build\` first.`);
  process.exit(1);
}

const { closePool, execute, queryOne } = await import(pathToFileURL(resolve(POOL)).href);

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const email = (positional[0] ?? process.env.ADMIN_LOGIN_EMAIL ?? process.env.ADMIN_EMAIL ?? '')
  .trim()
  .toLowerCase();

if (!email) {
  console.error(
    'No address given and ADMIN_LOGIN_EMAIL is not set.\n' +
      'Usage: npm run admin:password -- someone@example.com',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Reading the password                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prompts without echoing.
 *
 * `readline` has no built-in hidden mode, so the terminal's raw mode is used directly and
 * restored in a `finally` — leaving a shell with echo switched off is a genuinely
 * unpleasant thing to do to someone over SSH.
 *
 * Falls back to a plain read when stdin is not a TTY, which is what `--stdin` is for.
 */
async function promptSecret(label) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return '';
  }

  process.stdout.write(label);

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    let value = '';

    for await (const chunk of process.stdin) {
      const text = chunk.toString('utf8');
      let done = false;

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          done = true;
          break;
        }
        if (char === '\u0003') {
          // Ctrl-C. Restore the terminal before leaving.
          process.stdout.write('\n');
          process.stdin.setRawMode(wasRaw);
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }

      if (done) break;
    }

    process.stdout.write('\n');
    return value;
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  }
}

const password = await promptSecret(`New password for ${email}: `);

if (password.length < 12) {
  console.error('Refusing to set it: use a password of at least 12 characters.');
  await closePool();
  process.exit(1);
}

if (process.stdin.isTTY && !flags.has('--stdin')) {
  const again = await promptSecret('Type it again: ');
  if (again !== password) {
    console.error('Those did not match. Nothing was changed.');
    await closePool();
    process.exit(1);
  }
}

/* -------------------------------------------------------------------------- */
/* Writing it                                                                  */
/* -------------------------------------------------------------------------- */

try {
  const existing = await queryOne(
    'SELECT id, email, is_active FROM admin_users WHERE email = ? LIMIT 1',
    [email],
  );

  // Cost 12, matching every other bcrypt call in this codebase.
  const hash = await bcrypt.hash(password, 12);

  if (existing) {
    await execute('UPDATE admin_users SET password_hash = ?, is_active = 1 WHERE id = ?', [
      hash,
      existing.id,
    ]);

    console.log(`\nUpdated the admin_users row for ${email}.`);

    if (existing.is_active !== 1) {
      console.log('The account was inactive and has been re-enabled.');
    }
  } else if (flags.has('--create')) {
    await execute(
      `INSERT INTO admin_users (email, password_hash, name, is_active)
       VALUES (?, ?, ?, 1)`,
      [email, hash, email.split('@')[0]],
    );

    console.log(`\nCreated an admin_users row for ${email}.`);
  } else {
    /*
     * No row, and none asked for. Say what that means rather than creating one silently:
     * with no row the environment fallback is live, so the right fix may well be the env
     * variable after all — the opposite of the case this script was written for.
     */
    console.log(`\nNo admin_users row exists for ${email}, so nothing was changed.`);
    console.log('With no row, sign-in falls back to ADMIN_LOGIN_EMAIL + ADMIN_PASSWORD_HASH');
    console.log('from the environment — so set the password there, or re-run with --create');
    console.log('to move this account into the database instead.');
    await closePool();
    process.exit(0);
  }

  console.log('Sign in with the new password. No redeploy or restart is needed —');
  console.log('the check reads this row on every attempt.');
} catch (error) {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
