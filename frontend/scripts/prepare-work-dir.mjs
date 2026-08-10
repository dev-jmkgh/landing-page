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
 * Only relevant when the directory is currently in dev mode: `npm start` also uses
 * port 3000, but it serves `out/` and does not care about `.next`.
 */
function devPortInUse(port = 3000) {
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

const previous = readPreviousMode();

if (mode === 'build' && previous === 'dev' && (await devPortInUse())) {
  console.error(
    '\n[prepare-work-dir] A dev server appears to be running on port 3000.\n' +
      '  Building now would clear .next underneath it and break that server.\n' +
      '  Stop `npm run dev` first, then build again.\n',
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
