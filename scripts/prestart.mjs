#!/usr/bin/env node
/**
 * Runs before `npm start`: clear the ports, then build both sides.
 *
 * `npm start` is the "show me the real thing" command, so it always rebuilds rather
 * than serving whatever happens to be in `frontend/out/` and `backend/dist/`. Serving a
 * stale build is the worse failure — it looks like the code simply did not work, and
 * nothing on screen says the artifacts are older than the source.
 *
 * The ports are cleared *before* the build rather than after, for a reason beyond
 * tidiness: `next build` clears `.next`, which is the directory a running `next dev` is
 * reading from. Doing that underneath a live dev server corrupts it, and the errors it
 * then throws ("Cannot find module './331.js'", missing entries in the React Client
 * Manifest) look like bundler bugs rather than a stomped cache. Stopping the dev server
 * first makes that impossible.
 *
 * Only Node processes are stopped — see `free-ports.mjs`. To start without rebuilding,
 * use `npm run start:web` / `npm run start:api`, which do not run this script.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-ports.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const services = [
  { name: 'website', port: 3000 },
  { name: 'API', port: 5000 },
];

for (const service of services) {
  const result = await freePort(service.port);

  if (result.killed.length > 0) {
    const pids = result.killed.map((entry) => `${entry.name} ${entry.pid}`).join(', ');
    console.log(`[start] Port ${service.port} (${service.name}) was busy — stopped ${pids}.`);
  }

  if (!result.freed) {
    console.error(
      `\n[start] Port ${service.port} is held by ${result.blockedBy}.\n\n` +
        `  That is not a Node process from this project, so it has been left alone.\n` +
        `  Stop it yourself, or start the ${service.name} on another port.\n`,
    );
    process.exit(1);
  }
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
