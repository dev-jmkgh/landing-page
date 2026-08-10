/**
 * Renders the default Open Graph card to `public/images/og/og-default.png`.
 *
 * Runs automatically before `next build` (see the `prebuild` script). Keeping the card
 * as a real PNG in `public/` means every page can reference a stable, crawler-friendly
 * URL — social platforms do not reliably render SVG share images.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { ImageResponse } from 'next/og.js';

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../public/images/og/og-default.png',
);

const SIZE = { width: 1200, height: 630 };

const h = React.createElement;

const card = h(
  'div',
  {
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      backgroundColor: '#0a1b2e',
      padding: '72px',
      color: '#ffffff',
      fontFamily: 'sans-serif',
    },
  },
  h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '20px' } },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '72px',
          height: '72px',
          backgroundColor: '#0f2742',
          borderBottom: '4px solid #c08b2e',
          fontSize: '24px',
          fontWeight: 700,
          letterSpacing: '1px',
        },
      },
      'JMK',
    ),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      h('span', { style: { fontSize: '32px', fontWeight: 700 } }, 'JMK Global Holdings'),
      h(
        'span',
        { style: { fontSize: '18px', color: '#b6c4d4', letterSpacing: '3px' } },
        'COIMBATORE, TAMIL NADU  ·  SINCE 2023',
      ),
    ),
  ),
  h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    h(
      'span',
      { style: { fontSize: '62px', fontWeight: 700, lineHeight: 1.15, maxWidth: '960px' } },
      'Building Skills, Businesses & Sustainable Futures',
    ),
    h(
      'span',
      { style: { fontSize: '28px', color: '#d9a54a', marginTop: '18px' } },
      'One Group. Multiple Industries. Unlimited Possibilities.',
    ),
  ),
  h(
    'div',
    { style: { display: 'flex', gap: '14px' } },
    ...['JMK Academy', 'JMK Design Studio', 'JMK Software Solutions'].map((label) =>
      h(
        'span',
        {
          key: label,
          style: {
            display: 'flex',
            fontSize: '20px',
            color: '#b6c4d4',
            border: '1px solid rgba(255,255,255,0.22)',
            padding: '10px 18px',
          },
        },
        label,
      ),
    ),
  ),
);

const response = new ImageResponse(card, SIZE);
const buffer = Buffer.from(await response.arrayBuffer());

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, buffer);

console.log(`Generated ${OUTPUT} (${(buffer.length / 1024).toFixed(1)} KB)`);
