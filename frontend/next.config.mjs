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

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
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
};

export default nextConfig;
