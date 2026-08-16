/**
 * Company identity, contact details and navigation.
 *
 * Every value here comes from `JMK Global Holdings Website Content.docx`
 * (see `docs/content-map.md`). Do not add facts that are not in that document.
 */

const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.jmkglobalholdings.com';

/** Canonical origin without a trailing slash. */
export const SITE_URL = rawSiteUrl.replace(/\/+$/, '');

export const siteConfig = {
  name: 'JMK Global Holdings',
  shortName: 'JMK',
  tagline: 'Building Skills, Businesses & Sustainable Futures',
  subTagline: 'One Group. Multiple Industries. Unlimited Possibilities.',
  foundedYear: 2023,
  locale: 'en_IN',
  description:
    'JMK Global Holdings is a diversified business group headquartered in Coimbatore, India, operating across education, engineering design, software development, exports, agriculture, renewable energy and real estate.',
  founders: ['Jose AM', 'Muthu Krishnan Anantham'],
  sectors: [
    'Education',
    'Engineering Design',
    'Software Development',
    'Exports',
    'Agriculture',
    'Renewable Energy',
    'Real Estate',
  ],
} as const;

export const contactDetails = {
  address: {
    lines: ['22, NSR Road', 'Saibaba Kovil', 'Coimbatore'],
    locality: 'Coimbatore',
    region: 'Tamil Nadu',
    postalCode: '641011',
    country: 'India',
    countryCode: 'IN',
  },
  phones: [
    { label: '+91 88707 73366', href: 'tel:+918870773366' },
    { label: '+91 73057 55370', href: 'tel:+917305755370' },
  ],
  /**
   * The number shown in the header and in single-number call actions.
   *
   * Named rather than indexed so it cannot be changed by accident: reordering
   * `phones` would otherwise silently swap the number on every page. Both numbers
   * stay listed in full on the contact page and in the footer.
   */
  primaryPhone: { label: '+91 73057 55370', href: 'tel:+917305755370' },
  email: 'info@jmkglobalholdings.com',
} as const;

/** One-line postal address, used in structured data and the footer. */
export const formattedAddress = [
  ...contactDetails.address.lines,
  `${contactDetails.address.region} ${contactDetails.address.postalCode}`,
  contactDetails.address.country,
].join(', ');

export const mapsDirectionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  `JMK Global Holdings, ${formattedAddress}`,
)}`;

export const mapsEmbedUrl = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_URL ?? '';

export type SocialLink = {
  id: 'facebook' | 'instagram' | 'linkedin' | 'youtube';
  label: string;
  href: string;
};

/**
 * Social profiles supplied by the client. The YouTube URL was not provided, so it is
 * read from configuration and simply omitted while empty — no invented link.
 */
export const socialLinks: SocialLink[] = (
  [
    {
      id: 'facebook',
      label: 'Facebook',
      href: 'https://www.facebook.com/people/CAD-DESK-Coimbatore/61561605241298/',
    },
    {
      id: 'instagram',
      label: 'Instagram',
      href: 'https://www.instagram.com/caddeskcoimbatore/',
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      href: 'https://www.linkedin.com/company/142902180/',
    },
    {
      id: 'youtube',
      label: 'YouTube',
      href: process.env.NEXT_PUBLIC_YOUTUBE_URL ?? '',
    },
  ] satisfies SocialLink[]
).filter((link) => link.href.trim().length > 0);

export const EXTERNAL_LINKS = {
  cadDeskCoimbatore: 'https://caddeskindia.com/cad-desk-coimbatore-nsr-rd/',
} as const;

export type NavItem = {
  label: string;
  href: string;
  children?: { label: string; href: string; description: string }[];
};

export const mainNavigation: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'About Us', href: '/about' },
  {
    label: 'Our Business',
    href: '/business',
    children: [
      {
        label: 'JMK Academy',
        href: '/business/jmk-academy',
        description: 'CAD DESK and SAP training',
      },
      {
        label: 'JMK Design Studio',
        href: '/business/jmk-design-studio',
        description: 'All CAD designing works',
      },
      {
        label: 'JMK Software Solutions',
        href: '/business/jmk-software-solutions',
        description: 'Software, web, mobile and cloud services',
      },
    ],
  },
  { label: 'Gallery', href: '/gallery' },
  { label: 'Careers', href: '/careers' },
  { label: 'Contact Us', href: '/contact' },
];

export const legalNavigation = [
  { label: 'Privacy Policy', href: '/privacy-policy' },
  { label: 'Terms & Conditions', href: '/terms' },
];
