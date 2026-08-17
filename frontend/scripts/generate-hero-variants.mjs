/**
 * Generates the WebP widths used by full-bleed hero bands.
 *
 *   node scripts/generate-hero-variants.mjs
 *
 * The card widths (480/800/1280) that ship with the gallery imagery are too small for
 * a hero: stretched across a 1920px viewport a 1280px file is visibly soft. These are
 * generated once and committed, because `output: 'export'` means there is no image
 * server in production and a native encoder in the build would be a heavy dependency
 * for assets that change a handful of times a year.
 *
 * Widths are never upscaled past the source. A 1400px photograph gets a 1400px top
 * variant rather than a 1920px one that would carry more bytes and no more detail, and
 * the map below records the real widths so the `srcSet` descriptors stay honest — a
 * `1920w` descriptor on a 1400px file makes the browser over-estimate and pick wrong.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.join(here, '..', 'public', 'images', 'gallery');

/** Every photograph used behind a hero band, and the steps each one can support. */
const SOURCES = [
  'about-team-collaboration.jpg',
  'design-3d-model-workstation.jpg',
  'academy-corporate-training.jpg',
  'academy-sap-business-training.jpg',
  'academy-cad-3d-workstation.jpg',
  'design-technical-drawing-parts.jpg',
  'software-analytics-dashboard.jpg',
];

const TARGET_WIDTHS = [640, 1024, 1440, 1920];

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

let written = 0;
let skipped = 0;

for (const file of SOURCES) {
  const src = path.join(imagesDir, file);
  if (!(await exists(src))) {
    console.error(`  MISSING  ${file}`);
    process.exitCode = 1;
    continue;
  }

  const buffer = await readFile(src);
  const { width: srcWidth, height: srcHeight } = await sharp(buffer).metadata();

  // Cap at the source width, and drop any step that would land within 10% of the one
  // below it — two near-identical files only cost bytes in the repo.
  const widths = [];
  for (const w of TARGET_WIDTHS) {
    const target = Math.min(w, srcWidth);
    const previous = widths.at(-1);
    if (previous && target <= previous * 1.1) continue;
    widths.push(target);
  }

  const base = file.replace(/\.jpe?g$/i, '');
  const made = [];

  for (const width of widths) {
    const out = path.join(imagesDir, `${base}-${width}.webp`);
    if (await exists(out)) {
      skipped += 1;
      made.push(`${width} (exists)`);
      continue;
    }
    const data = await sharp(buffer)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78, effort: 5 })
      .toBuffer();
    await writeFile(out, data);
    written += 1;
    made.push(`${width} (${Math.round(data.length / 1024)}kB)`);
  }

  console.log(`  ${base}`);
  console.log(`     source ${srcWidth}x${srcHeight} -> ${made.join(', ')}`);
  console.log(`     variants: [${widths.join(', ')}]`);
}

console.log(`\n  ${written} written, ${skipped} already present`);
