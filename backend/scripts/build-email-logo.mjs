/**
 * Regenerates src/services/email/layout/logo.ts from the brand asset.
 *
 *   node scripts/build-email-logo.mjs
 *
 * The logo travels inside every email as a Content-ID part rather than as a link, so
 * it renders without the reader allowing remote images. That means the bytes have to
 * live in the build, and embedding them in a module is what avoids TypeScript's output
 * step needing to copy a binary alongside the JavaScript.
 *
 * sharp comes from the frontend's dependencies — it is a build-time tool here, not a
 * runtime one, so it is not a backend dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const sharp = createRequire(path.join(repo, 'frontend', 'package.json'))('sharp');

const SOURCE = path.join(repo, 'frontend', 'public', 'images', 'brand', 'logo-on-dark.png');
const TARGET = path.join(here, '..', 'src', 'services', 'email', 'layout', 'logo.ts');

/** Twice the 150px display width, so it stays sharp on a high-density screen. */
const WIDTH = 300;
/** The email header's navy. Transparency renders unevenly across clients. */
const BACKGROUND = '#0a1b2e';

const png = await sharp(SOURCE)
  .resize({ width: WIDTH })
  .flatten({ background: BACKGROUND })
  .png({ compressionLevel: 9, palette: true, quality: 90 })
  .toBuffer();

const chunks = png.toString('base64').match(/.{1,96}/g) ?? [];
const body = chunks
  .map((chunk, i) => `  ${JSON.stringify(chunk)}${i === chunks.length - 1 ? '' : ' +'}`)
  .join('\n');

fs.writeFileSync(
  TARGET,
  `/**
 * The JMK wordmark, embedded rather than linked.
 *
 * A remote <img> is the usual way to put a logo in an email and it is the reason so
 * many branded emails arrive looking broken: most clients block remote images until
 * the reader allows them. Embedding the bytes and referencing them by Content-ID means
 * the mark always renders, with no external request and nothing for a tracker-blocker
 * to strip.
 *
 * GENERATED FILE — do not edit by hand. Run scripts/build-email-logo.mjs after any
 * change to the brand asset.
 */

/** Referenced from the header as <img src="cid:jmk-logo">. */
export const EMAIL_LOGO_CID = 'jmk-logo';

const BASE64 =
${body};

export const EMAIL_LOGO_PNG = Buffer.from(BASE64, 'base64');
`,
  'utf8',
);

console.log(`  logo.ts regenerated — ${WIDTH}px, ${Math.round(png.length / 1024)}kB`);
