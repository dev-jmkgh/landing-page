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

const previous = readPreviousMode();

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
