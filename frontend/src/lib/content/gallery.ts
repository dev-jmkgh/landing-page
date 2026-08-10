/**
 * Gallery slots.
 *
 * The content document supplied no photographs and no project descriptions, so this file
 * ships **image slots only**: a category and an optional file path. A slot with `src: null`
 * renders a branded geometric placeholder — never a fabricated caption or invented project.
 *
 * To publish a real image:
 *   1. Drop the file into `frontend/public/images/gallery/` (see docs/image-assets.md).
 *   2. Set `src` to `/images/gallery/<filename>` and write a truthful `alt` description.
 *   3. Optionally add a `caption` — only if the caption is factually accurate.
 */

export type GalleryCategory = {
  id: string;
  label: string;
};

export const galleryCategories: GalleryCategory[] = [
  { id: 'all', label: 'All' },
  { id: 'academy', label: 'JMK Academy' },
  { id: 'design-studio', label: 'JMK Design Studio' },
  { id: 'software', label: 'JMK Software Solutions' },
  { id: 'exports', label: 'Exports & Farming' },
  { id: 'energy', label: 'Renewable Energy' },
];

export type GallerySlot = {
  id: string;
  /** Must match a `galleryCategories` id other than `all`. */
  category: string;
  /** Public path such as `/images/gallery/academy-01.jpg`, or `null` while unassigned. */
  src: string | null;
  /** Required whenever `src` is set. */
  alt: string | null;
  caption?: string;
  /** Wide tiles span two columns on large screens. */
  wide?: boolean;
};

export const gallerySlots: GallerySlot[] = [
  { id: 'academy-01', category: 'academy', src: null, alt: null, wide: true },
  { id: 'academy-02', category: 'academy', src: null, alt: null },
  { id: 'academy-03', category: 'academy', src: null, alt: null },
  { id: 'design-01', category: 'design-studio', src: null, alt: null },
  { id: 'design-02', category: 'design-studio', src: null, alt: null, wide: true },
  { id: 'design-03', category: 'design-studio', src: null, alt: null },
  { id: 'software-01', category: 'software', src: null, alt: null },
  { id: 'software-02', category: 'software', src: null, alt: null },
  { id: 'software-03', category: 'software', src: null, alt: null, wide: true },
  { id: 'exports-01', category: 'exports', src: null, alt: null, wide: true },
  { id: 'exports-02', category: 'exports', src: null, alt: null },
  { id: 'energy-01', category: 'energy', src: null, alt: null },
];
