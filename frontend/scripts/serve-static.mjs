#!/usr/bin/env node
/**
 * Serves the exported static site in `out/` the way a plain web host does.
 *
 * `next start` cannot run against `output: 'export'`, so a local preview of the real
 * build needs a static file server. This one is dependency-free on purpose: `npx serve`
 * downloads a package on first use, which fails on a machine that is offline or behind
 * a proxy — exactly the situation a "show the client the build" demo tends to be in.
 *
 * It mirrors the two host behaviours the export relies on:
 *   - `trailingSlash: true` — `/about/` resolves to `out/about/index.html`
 *   - a 404 page — unknown paths return `out/404.html` with a real 404 status
 *
 * Usage: node scripts/serve-static.mjs [--port 3000] [--dir out]
 * Env:   PORT, NEXT_PUBLIC_BASE_PATH (strip a sub-path prefix, as GitHub Pages adds)
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(readFlag('port', process.env.PORT ?? '3000'));
const rootDir = path.resolve(frontendRoot, readFlag('dir', 'out'));
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

if (!existsSync(path.join(rootDir, 'index.html'))) {
  console.error(
    `\n  No build found at ${rootDir}\n` +
      '  Run "npm run build" (or "npm start" from the repository root) first.\n',
  );
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/** Maps a request path to a file inside `rootDir`, or null when it escapes it. */
function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);

  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  const candidate = path.resolve(rootDir, `.${path.posix.normalize(pathname)}`);
  if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  // Directory-style URL: `/about/` and `/about` both mean `about/index.html`.
  const asIndex = path.join(candidate, 'index.html');
  if (existsSync(asIndex)) return asIndex;

  const asHtml = `${candidate}.html`;
  if (existsSync(asHtml) && statSync(asHtml).isFile()) return asHtml;

  return null;
}

function send(res, status, file) {
  const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  // Hashed asset filenames make `_next/static` safe to cache hard; everything else is
  // revalidated so a rebuild shows up on refresh instead of serving yesterday's HTML.
  const immutable = file.includes(`${path.sep}_next${path.sep}static${path.sep}`);

  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': statSync(file).size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  const file = resolveFile(req.url ?? '/');

  if (file) {
    send(res, 200, file);
    return;
  }

  const notFound = path.join(rootDir, '404.html');
  if (existsSync(notFound)) {
    send(res, 404, notFound);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Free it or run with --port <other>.\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, () => {
  console.log(`  Website  http://localhost:${port}${basePath}/  (static build from ${rootDir})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
