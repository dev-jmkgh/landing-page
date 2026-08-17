/**
 * The photograph behind each interior page's hero band.
 *
 * IMPORTANT — the same rule as the gallery applies here, and it matters more, because
 * a hero reads as "this is us" in a way a grid tile does not. Every file below is a
 * licensed stock photograph that *represents the discipline* the page is about. The
 * `alt` text describes what the frame literally shows and never claims it is a JMK
 * facility, employee, student or project. Do not rewrite these to imply otherwise.
 *
 * When real JMK photography arrives: drop the file into `public/images/gallery/`, run
 * `node scripts/generate-hero-variants.mjs`, then swap `src`, `width`, `height` and
 * `variants` and write truthful `alt` text. Nothing else needs to change.
 *
 * On `variants`: these are the real widths on disk, which are capped at each source's
 * intrinsic width rather than upscaled to a uniform ladder — see the generator. The
 * descriptors have to match the files or the browser mis-picks.
 *
 * On `objectPosition`: the copy occupies the left of the band and the scrim is heaviest
 * there, so each crop is nudged so its subject sits right of centre, clear of the text
 * rather than behind it.
 */

export type HeroImage = {
  src: string;
  alt: string;
  width: number;
  height: number;
  variants: number[];
  /** `object-position` for the crop. Defaults to `50% center` when omitted. */
  objectPosition?: string;
  /** Which drafting film lies over the photograph — keeps the pages distinct. */
  overlay: 'measure' | 'grid' | 'flow' | 'network';
};

export const aboutHero: HeroImage = {
  src: '/images/gallery/about-team-collaboration.jpg',
  alt: 'Colleagues reviewing work together around a laptop in a bright meeting room',
  width: 1800,
  height: 1202,
  variants: [640, 1024, 1440, 1800],
  objectPosition: '62% center',
  overlay: 'grid',
};

export const businessHero: HeroImage = {
  src: '/images/gallery/design-3d-model-workstation.jpg',
  alt: 'Three-dimensional structural assembly model open on a CAD workstation display',
  width: 1800,
  height: 1201,
  variants: [640, 1024, 1440, 1800],
  objectPosition: '65% center',
  overlay: 'network',
};

export const careersHero: HeroImage = {
  src: '/images/gallery/academy-corporate-training.jpg',
  alt: 'Presenter leading a seminar for a seated group in a corporate training room',
  width: 1800,
  height: 1202,
  variants: [640, 1024, 1440, 1800],
  objectPosition: '68% center',
  overlay: 'flow',
};

export const contactHero: HeroImage = {
  src: '/images/gallery/academy-sap-business-training.jpg',
  alt: 'Trainer presenting business process and reporting charts during an enterprise software session',
  width: 1800,
  height: 1200,
  variants: [640, 1024, 1440, 1800],
  objectPosition: '66% center',
  overlay: 'measure',
};

/** Keyed by `vertical.slug` — see `lib/content/business.ts`. */
export const verticalHeroes: Record<string, HeroImage> = {
  'jmk-academy': {
    src: '/images/gallery/academy-cad-3d-workstation.jpg',
    alt: 'Engineer working on a 3D plant model in CAD software at a dual-monitor workstation',
    width: 1600,
    height: 1067,
    variants: [640, 1024, 1440, 1600],
    objectPosition: '70% center',
    overlay: 'measure',
  },
  'jmk-design-studio': {
    src: '/images/gallery/design-technical-drawing-parts.jpg',
    alt: 'Machined aluminium flange components resting on dimensioned engineering drawings',
    width: 1400,
    height: 788,
    variants: [640, 1024, 1400],
    objectPosition: '64% center',
    overlay: 'grid',
  },
  'jmk-software-solutions': {
    src: '/images/gallery/software-analytics-dashboard.jpg',
    alt: 'An analytics dashboard on screen showing charts and key performance figures',
    width: 1400,
    height: 1008,
    variants: [640, 1024, 1400],
    objectPosition: '68% center',
    overlay: 'flow',
  },
};
