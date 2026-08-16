/**
 * Gallery data.
 *
 * IMPORTANT — how to read the titles and descriptions.
 *
 * The content document supplied no JMK photography. Every image here is a licensed
 * stock photograph that *represents the discipline* a business vertical works in. So
 * the copy describes the capability ("Engineering Design", "CAD & Engineering
 * Training") and never claims the frame shows a JMK facility, a JMK employee, a JMK
 * student or a JMK project. Do not retitle these to imply otherwise.
 *
 * When real JMK photography arrives: drop the file into
 * `frontend/public/images/gallery/`, swap `src`, `width` and `height`, write truthful
 * `alt` text, and delete the `credit` field. Nothing else needs to change.
 *
 * Images: Unsplash (https://unsplash.com/license — free for commercial use, no
 * attribution required; credited anyway as a courtesy).
 */

import { assetPath } from '@/lib/paths';

export type GalleryCategoryId = 'academy' | 'design-studio' | 'software' | 'sustainability';

export type GalleryCategory = {
  id: GalleryCategoryId | 'all';
  label: string;
  /** Short label used on the tile overlay. */
  short: string;
};

export const galleryCategories: GalleryCategory[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'academy', label: 'JMK Academy', short: 'Academy' },
  { id: 'design-studio', label: 'Design Studio', short: 'Design Studio' },
  { id: 'software', label: 'Software Solutions', short: 'Software' },
  { id: 'sustainability', label: 'Sustainability', short: 'Sustainability' },
];

export type GalleryItem = {
  id: string;
  category: GalleryCategoryId;
  /** Names the capability, never a project or a client. */
  title: string;
  description: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  credit?: { photographer: string; url: string };
};

const BASE = assetPath('/images/gallery');

export const galleryItems: GalleryItem[] = [
  /* ---------------------------------------------------------------- design */
  {
    id: 'engineering-design',
    category: 'design-studio',
    title: 'Engineering Design & Drafting',
    description:
      'Dimensioned technical drawings and precision-machined geometry — the drafting-to-manufacture span of JMK Design Studio.',
    src: `${BASE}/design-technical-drawing-parts.jpg`,
    alt: 'Machined aluminium flange components resting on dimensioned engineering drawings',
    width: 1400,
    height: 788,
    credit: { photographer: 'EnCata PD', url: 'https://unsplash.com/photos/SRqJ3eli-4I' },
  },
  {
    id: 'cad-drafting',
    category: 'design-studio',
    title: '2D Drafting',
    description: 'Layered CAD linework with hatching, dimension strings and drawing callouts.',
    src: `${BASE}/design-cad-drafting-screen.jpg`,
    alt: 'A monitor showing a detailed 2D CAD plan drawing with coloured linework and dimensions',
    width: 1400,
    height: 934,
    credit: {
      photographer: 'ThisisEngineering',
      url: 'https://unsplash.com/photos/hoivM01c-vg',
    },
  },
  {
    id: 'product-design',
    category: 'design-studio',
    title: 'Product & Industrial Design',
    description:
      'Concept drawings, precision instruments and a physical prototype on the design bench.',
    src: `${BASE}/design-product-design-bench.jpg`,
    alt: 'Technical drawings of a product with drafting instruments and a metal prototype on a desk',
    width: 1400,
    height: 933,
    credit: { photographer: 'Vooglam Eyewear', url: 'https://unsplash.com/photos/0dhIl78b__o' },
  },

  /* --------------------------------------------------------------- academy */
  {
    id: 'cad-training',
    category: 'academy',
    title: 'CAD & Engineering Training',
    description:
      '3D modelling on screen — the software skills taught through CAD DESK Coimbatore.',
    src: `${BASE}/academy-cad-workstation.jpg`,
    alt: 'A widescreen monitor displaying a 3D CAD model of a structural steel assembly',
    width: 1400,
    height: 933,
    credit: {
      photographer: 'Evgeniy Surzhan',
      url: 'https://unsplash.com/photos/lVWozBOVY2M',
    },
  },
  {
    id: 'engineering-workstation',
    category: 'academy',
    title: 'Technical Skills Development',
    description:
      'Multi-screen engineering workstations of the kind our training prepares professionals to work at.',
    src: `${BASE}/academy-engineering-workstation.jpg`,
    alt: 'A dual-monitor engineering workstation showing a circuit schematic and a 3D board layout',
    width: 1400,
    height: 788,
    credit: { photographer: 'EnCata PD', url: 'https://unsplash.com/photos/ZmDk8tXQRS0' },
  },

  /* -------------------------------------------------------------- software */
  {
    id: 'software-development',
    category: 'software',
    title: 'Custom Software Development',
    description: 'Application code — ERP, web and mobile builds from JMK Software Solutions.',
    src: `${BASE}/software-source-code.jpg`,
    alt: 'Source code with syntax highlighting displayed on a monitor at a developer workstation',
    width: 1400,
    height: 911,
    credit: {
      photographer: 'Jakub Żerdzicki',
      url: 'https://unsplash.com/photos/v-jFS1AsHXo',
    },
  },
  {
    id: 'analytics',
    category: 'software',
    title: 'Analytics Dashboards',
    description: 'Operational data turned into the measures a business actually decides on.',
    src: `${BASE}/software-analytics-dashboard.jpg`,
    alt: 'An analytics dashboard on screen showing charts and key performance figures',
    width: 1400,
    height: 1008,
    credit: {
      photographer: 'Stephen Dawson',
      url: 'https://unsplash.com/photos/qwtCeJ5cLYs',
    },
  },
  {
    id: 'cloud-infrastructure',
    category: 'software',
    title: 'Cloud & Hosting',
    description: 'The server infrastructure behind cloud applications, email and hosting services.',
    src: `${BASE}/software-server-infrastructure.jpg`,
    alt: 'Rows of rack-mounted server hardware with status indicator lights',
    width: 1400,
    height: 2100,
    credit: {
      photographer: 'Matthieu Beaumont',
      url: 'https://unsplash.com/photos/iYnpYeyu57k',
    },
  },

  /* -------------------------------------------------------- sustainability */
  {
    id: 'solar',
    category: 'sustainability',
    title: 'Renewable Energy',
    description:
      'Solar generation at scale — part of the group’s contribution to decentralised clean power.',
    src: `${BASE}/sustainability-solar-farm.jpg`,
    alt: 'Aerial view of long rows of solar photovoltaic panels across open ground',
    width: 1400,
    height: 788,
    credit: { photographer: 'Vlad Burac', url: 'https://unsplash.com/photos/e5kpS6Xpg04' },
  },
  {
    id: 'integrated-farming',
    category: 'sustainability',
    title: 'Integrated Farming',
    description:
      'Cultivated farmland — food security, rural employment and responsible resource use.',
    src: `${BASE}/sustainability-farmland.jpg`,
    alt: 'Aerial view of cultivated farmland divided by tree lines under a cloudy sky',
    width: 1400,
    height: 788,
    credit: {
      photographer: 'Alin Gavriliuc',
      url: 'https://unsplash.com/photos/64-zcsRkJZo',
    },
  },

  /* ------------------------------------------------------------------ group */
  /*
    The three container photographs that stood here were removed: each was dominated
    by another company's livery (MAERSK, Hapag-Lloyd), and a JMK page is not the place
    to advertise a shipping line. The export sector is represented by the agriculture
    and energy frames below until photography of JMK's own trade operations exists.
  */
];

export function itemsForCategory(category: GalleryCategoryId | 'all'): GalleryItem[] {
  return category === 'all'
    ? galleryItems
    : galleryItems.filter((item) => item.category === category);
}

export function categoryLabel(id: GalleryCategoryId): string {
  return galleryCategories.find((category) => category.id === id)?.label ?? '';
}
