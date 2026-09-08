import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  // The `.next-*` glob covers `NEXT_DIST_DIR` builds as well as `.next` itself.
  //
  // `.gitignore` already excludes those directories but eslint listed only `.next`, so a
  // verification build into `.next-build` — the documented way to build without stopping
  // a running dev server — made `npm run lint` report thousands of problems in minified
  // webpack output, errors among them, which made the exit code useless.
  { ignores: ['.next/**', '.next-*/**', 'out/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default config;
