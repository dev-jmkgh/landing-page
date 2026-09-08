#!/usr/bin/env node
/**
 * Fails the deploy when the production configuration is not fit to ship.
 *
 *   NODE_ENV=production npm run config:check
 *
 * This exists because the config module only *warns* about a localhost
 * `API_PUBLIC_URL`, and a warning in a deploy log is something nobody reads. The API
 * started successfully, reported itself healthy, and quietly mailed every job-application
 * notification with a resume download link pointing at `http://localhost:5000` — a link
 * that works on the server and nowhere else. It had been doing that for as long as the
 * variable had been unset.
 *
 * The check deliberately runs against the BUILT config (`dist/config/env.js`), not a
 * re-implementation of it. That is the same module, with the same schema, the same
 * defaults and the same `.env` layering the service itself will use, so the two cannot
 * drift — and it catches a value that is wrong because of where it came from, not just
 * because of what it says.
 *
 * It is a deploy-time gate and not a startup assertion on purpose. Making the server
 * refuse to boot on a soft misconfiguration would turn a broken email link into an
 * outage, and would take down a running site the next time someone restarted it. Failing
 * here stops the bad config reaching the service while leaving whatever is already
 * running untouched.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (process.env.NODE_ENV !== 'production') {
  console.error('This check is only meaningful with NODE_ENV=production.');
  console.error(`  NODE_ENV is currently ${process.env.NODE_ENV ?? '(unset)'}`);
  process.exit(1);
}

const built = resolve('dist/config/env.js');

if (!existsSync(built)) {
  console.error(`Cannot check the configuration: ${built} does not exist.`);
  console.error('Run `npm run build` first — this is meant to run after the build.');
  process.exit(1);
}

let config;
try {
  ({ config } = await import(pathToFileURL(built).href));
} catch (error) {
  // A schema failure throws from the module body, and its message already lists the
  // offending variables. Surfacing it verbatim is more useful than anything added here.
  console.error('The configuration could not be loaded:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const problems = [];

/**
 * Values that are worse than useless when left at their development defaults.
 *
 * Each one is something that produces a wrong result silently rather than an error: a
 * link that resolves nowhere, a cookie that never matches, an origin that blocks the
 * site's own requests.
 */
const LOCAL = /localhost|127\.0\.0\.1|0\.0\.0\.0/;

if (LOCAL.test(config.apiPublicUrl)) {
  problems.push(
    `API_PUBLIC_URL is ${config.apiPublicUrl}\n` +
      '     Resume download links in admin notification emails are built from this, so\n' +
      '     they will only work on the server itself. Set it to the public API origin,\n' +
      '     e.g. https://api.jmkglobalholdings.com',
  );
}

if (LOCAL.test(config.appUrl)) {
  problems.push(
    `APP_URL is ${config.appUrl}\n` +
      '     Links back to the website in emails are built from this.',
  );
}

const localOrigins = config.corsOrigins.filter((origin) => LOCAL.test(origin));
if (localOrigins.length === config.corsOrigins.length) {
  problems.push(
    `CORS_ORIGINS contains only local origins: ${config.corsOrigins.join(', ')}\n` +
      "     The deployed site's own requests would be refused.",
  );
}

/*
 * DB_HOST is deliberately NOT checked. The database runs on the same host as the API in
 * this deployment, so localhost is the correct value there and flagging it would train
 * whoever runs this to ignore the output.
 */

if (problems.length > 0) {
  console.error('\nProduction configuration is not fit to deploy:\n');
  for (const problem of problems) console.error(`  ✗  ${problem}\n`);
  console.error('These come from backend/.env, layered over by backend/.env.<NODE_ENV>.\n');
  process.exit(1);
}

console.log('  production configuration checks passed');
console.log(`    api  ${config.apiPublicUrl}`);
console.log(`    site ${config.appUrl}`);
console.log(`    cors ${config.corsOrigins.join(', ')}`);
