#!/usr/bin/env node
/**
 * Keeps `.next` from being shared between `next dev` and `next build`.
 *
 * Because this project uses `output: 'export'`, a production build fills `.next` with
 * export-shaped artifacts and manifests. Starting the dev server on top of those makes
 * it read a mixture of the two, which surfaces as errors that look like bundler bugs:
 *
 *   Could not find the module "…/segment-explorer-node.js#SegmentViewNode"
 *     in the React Client Manifest
 *   TypeError: __webpack_modules__[moduleId] is not a function
 *   Error: Cannot find module './331.js'
 *
 * The only reliable cure is to discard `.next`, but doing that on every run would throw
 * away the incremental cache and make both commands slow. So we record which mode last
 * used the directory and clear it only when the mode changes.
 *
 * Usage: node scripts/prepare-work-dir.mjs <dev|build>
 */
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];

if (mode !== 'dev' && mode !== 'build') {
  console.error('Usage: node scripts/prepare-work-dir.mjs <dev|build>');
  process.exit(1);
}

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(frontendRoot, '.next');
const markerPath = join(workDir, '.jmk-mode');

function readPreviousMode() {
  if (!existsSync(workDir)) return null;
  try {
    return readFileSync(markerPath, 'utf8').trim();
  } catch {
    // No marker: the directory predates this script. If it holds a completed
    // production build, treat it as 'build' so the first dev run cleans it.
    return existsSync(join(workDir, 'BUILD_ID')) ? 'build' : null;
  }
}

/**
 * Is something already listening on the dev port?
 *
 * A production build clears `.next`, and doing that underneath a live `next dev`
 * corrupts it — the dev server then throws "Could not find the module … in the React
 * Client Manifest", "__webpack_modules__ is not a function" and missing-chunk errors
 * that look like bundler bugs rather than a stomped cache. Refusing to build is far
 * kinder than silently breaking a running server.
 *
 * Both stacks are probed. `next dev` binds `::` on Windows, and an earlier version of
 * this check asked 127.0.0.1 only — it reported the port free while a dev server was
 * plainly running on it, and the build went ahead and broke that server. A timeout is
 * also not evidence of absence: only a refused connection is, so a slow or busy server
 * counts as present.
 */
function probe(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    // Anything other than a refusal — a timeout, a host that cannot be reached — is
    // ambiguous, and the safe reading of ambiguity here is "something is there".
    socket.once('timeout', () => done(true));
    socket.once('error', (err) => done(err.code !== 'ECONNREFUSED' && err.code !== 'EADDRNOTAVAIL'));
    socket.connect(port, host);
  });
}

async function devPortInUse(port = 3000) {
  const results = await Promise.all(
    ['127.0.0.1', '::1'].map((host) => probe(host, port, 1500)),
  );
  return results.some(Boolean);
}

const previous = readPreviousMode();

/**
 * Note this does not require `previous === 'dev'`. The marker cannot be trusted to
 * survive: `next build` empties `.next`, taking with it the marker that `prebuild`
 * had just written, so a directory left by a build looks identical to one that never
 * had a marker at all. A live server on the port is the reliable signal, and a build
 * would clear the directory underneath it whatever the marker says.
 *
 * `npm start` also uses port 3000 but serves `out/` and does not touch `.next`, so it
 * would be refused here too. That is a deliberate trade: a spurious refusal costs one
 * stopped server, a missed one costs a corrupted dev session that reads as a bundler
 * bug.
 */
if (mode === 'build' && (await devPortInUse())) {
  console.error(
    '\n[prepare-work-dir] Something is listening on port 3000.\n' +
      '  Building now would clear .next underneath it, and a running dev server would\n' +
      '  then fail with MODULE_NOT_FOUND and missing-chunk errors.\n' +
      '  Stop `npm run dev` (or `npm start`) first, then build again.\n',
  );
  process.exit(1);
}

if (previous && previous !== mode) {
  console.log(
    `[prepare-work-dir] .next was last used by "${previous}"; clearing it for "${mode}".` +
      (mode === 'build'
        ? ' Stop `npm run dev` first if it is running — they share this directory.'
        : ''),
  );
  rmSync(workDir, { recursive: true, force: true });
}

mkdirSync(workDir, { recursive: true });
writeFileSync(markerPath, mode, 'utf8');
