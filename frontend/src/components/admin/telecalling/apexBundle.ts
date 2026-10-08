/**
 * The charting library, as one lazily loaded chunk.
 *
 * NEVER IMPORT THIS FILE STATICALLY. It is reached only through the dynamic `import()` in
 * ApexChart.tsx, for two reasons that both break something real:
 *
 * - apexcharts 4.7.0 reads `window` the moment it is evaluated. The admin pages are
 *   prerendered at build time under a static export, where there is no window, so a
 *   static import anywhere in the route — even in a 'use client' file — fails `next build`.
 *
 * - It is about 150 KB gzipped. A static import would add that to the one script every
 *   telecalling section loads, for six charts that only the dashboard draws. Behind
 *   `import()` the bundler splits it into its own chunk, fetched the first time a chart
 *   is actually on screen.
 *
 * Pinned to 4.7.0, the last MIT-licensed release; from 5.1.0 the licence requires a paid
 * licence above a revenue threshold. Every other file touches the library through
 * `import type` only, which is erased at build time. If a licensed version is adopted
 * later, only this file changes: 5.x+ splits the library into a core and per-chart
 * modules, which would be imported here and registered on the core.
 */
export { default } from 'apexcharts';
