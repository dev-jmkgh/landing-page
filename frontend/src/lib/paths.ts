/**
 * Base path helper for files served straight out of `public/`.
 *
 * Next rewrites `next/link` hrefs and its own `_next/*` assets for `basePath`
 * automatically, but with `images.unoptimized` (required by `output: 'export'`) the
 * `src` given to `next/image` is emitted verbatim. On a GitHub Pages project site —
 * served from `https://<owner>.github.io/<repo>/` — a bare `/images/…` therefore
 * resolves against the domain root and 404s.
 *
 * Every reference to a file in `public/` should go through `assetPath` so the same
 * source works at a sub-path (GitHub Pages) and at a domain root (S3/CloudFront,
 * Hostinger), where `NEXT_PUBLIC_BASE_PATH` is simply empty.
 */

export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

export function assetPath(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalised}`;
}
