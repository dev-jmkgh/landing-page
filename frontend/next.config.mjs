/**
 * Next.js configuration — JMK Global Holdings
 *
 * The site is exported as a fully static bundle (`out/`) so it can be served by
 * Apache/LiteSpeed from Hostinger's `public_html` with no Node.js runtime on the web
 * host. All dynamic behaviour (enquiries, applications, admin) talks to the separate
 * Express API over `NEXT_PUBLIC_API_BASE_URL`.
 *
 * `trailingSlash` matters: it makes every route emit `route/index.html`, which is what
 * Apache resolves natively for `/about/` style URLs.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * GitHub Pages serves a project site from a sub-path (`/<repo>/`), so the app needs a
 * base path there. It is read from the environment rather than hard-coded, so the same
 * build works unchanged at a domain root — which is what S3/CloudFront and Hostinger
 * will need later. Leave it empty for root deployments.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');

/**
 * Where build artifacts go. Defaults to `.next`.
 *
 * Overridable so a production build can run without touching the directory a live
 * `next dev` is using. `scripts/prepare-work-dir.mjs` refuses to build while anything is
 * listening on port 3000, because clearing `.next` underneath a dev server corrupts it —
 * and that refusal is right, but it also means a build cannot be verified without
 * stopping someone's server. Pointing the build at its own directory removes the
 * conflict instead of working around it:
 *
 *   NEXT_DIST_DIR=.next-build npx next build
 *
 * Left unset in normal use, so `npm run build` behaves exactly as before.
 */
const distDir = (process.env.NEXT_DIST_DIR ?? '').trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  ...(distDir ? { distDir } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  trailingSlash: true,
  // The repository has a lockfile at the root and one here, which otherwise makes
  // Next guess at the workspace root and warn on every build.
  outputFileTracingRoot: projectRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  images: {
    // Static export cannot run the Next image optimiser; assets are pre-optimised instead.
    unoptimized: true,
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error'] } : false,
  },

  /**
   * `next dev` rejects cross-origin requests for its dev assets, which breaks the page
   * when it is reached through a VS Code dev tunnel rather than localhost. Listing the
   * tunnel host here keeps HMR and `/_next/*` working during a shared demo. Dev only —
   * it has no effect on a production build.
   */
  allowedDevOrigins: ['*.devtunnels.ms'],
};

export default nextConfig;
