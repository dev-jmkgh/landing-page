#!/usr/bin/env node
/**
 * Runs before `npm start`: check the ports, then build both sides.
 *
 * `npm start` is the "show me the real thing" command, so it always rebuilds rather
 * than serving whatever happens to be in `frontend/out/` and `backend/dist/`. Serving a
 * stale build is the worse failure — it looks like the code simply did not work, and
 * nothing on screen says the artifacts are older than the source.
 *
 * The port check runs *first* and deliberately refuses to continue while a dev server
 * is up. Two reasons, and the second is the important one:
 *
 *   1. The production servers bind the same ports (3000 and 5000), so they could not
 *      start anyway — better to say so in a second than after a full build.
 *   2. `next build` clears `.next`, which is the directory a running `next dev` is
 *      reading from. Doing that underneath it corrupts the dev server, and the errors
 *      it then throws ("Cannot find module './331.js'", missing entries in the React
 *      Client Manifest) look like bundler bugs rather than a stomped cache.
 *
 * To start without rebuilding, use `npm run start:web` / `npm run start:api`, which do
 * not run this script.
 */
import { spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Resolves true when something is already listening on the port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

const services = [
  { name: 'website', port: 3000 },
  { name: 'API', port: 5000 },
];

const busy = [];
for (const service of services) {
  if (await portInUse(service.port)) busy.push(service);
}

if (busy.length > 0) {
  const lines = busy.map((service) => `    - ${service.port}  (${service.name})`).join('\n');
  console.error(
    '\n[start] Something is already listening on:\n' +
      `${lines}\n\n` +
      '  `npm start` serves the production build on those same ports, so it cannot\n' +
      '  continue. If this is `npm run dev`, stop it first — a production build also\n' +
      '  clears the .next directory the dev server is reading from.\n',
  );
  process.exit(1);
}

const builds = [
  { name: 'website', script: 'build:web' },
  { name: 'API', script: 'build:api' },
];

for (const build of builds) {
  console.log(`\n[start] Building the ${build.name}…`);

  // shell: true so this resolves npm.cmd on Windows as well as npm on POSIX.
  const result = spawnSync('npm', ['run', build.script], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    console.error(`\n[start] The ${build.name} build failed. Fix the error above and retry.\n`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[start] Both builds are up to date — starting the servers.\n');
