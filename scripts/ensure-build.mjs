#!/usr/bin/env node
/**
 * Makes `npm start` a single step: build whatever is missing, then let the start
 * scripts serve it.
 *
 * A demo run usually happens on a fresh clone or right after `git clean`, where
 * `frontend/out/` and `backend/dist/` do not exist yet. Failing with "no build found"
 * at that moment is just a second command to type, so this builds the missing side and
 * leaves an existing build alone — `npm start` stays fast on repeat runs.
 *
 * Run `npm run build` first when you want a rebuild of code that has already been built.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const targets = [
  {
    name: 'website',
    artifact: path.join(repoRoot, 'frontend', 'out', 'index.html'),
    script: 'build:web',
  },
  {
    name: 'API',
    artifact: path.join(repoRoot, 'backend', 'dist', 'server.js'),
    script: 'build:api',
  },
];

for (const target of targets) {
  if (existsSync(target.artifact)) continue;

  console.log(`\n[start] No ${target.name} build found — running "npm run ${target.script}".`);

  // shell: true so this resolves npm.cmd on Windows as well as npm on POSIX.
  const result = spawnSync('npm', ['run', target.script], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    console.error(`\n[start] The ${target.name} build failed. Fix the error above and retry.\n`);
    process.exit(result.status ?? 1);
  }
}
