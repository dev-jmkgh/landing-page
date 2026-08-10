/**
 * Brand constants for email.
 *
 * Every value here is either a colour from the website's design tokens or a fact that
 * already appears in `docs/content-map.md`. Nothing about the company is invented for
 * the benefit of an email footer.
 */
export const BRAND = {
  name: 'JMK Global Holdings',
  shortName: 'JMK',
  tagline: 'Building Skills, Businesses & Sustainable Futures',

  /** Postal address as supplied in the content document. */
  address: '22, NSR Road, Saibaba Kovil, Coimbatore, Tamil Nadu 641011, India',
  phones: ['+91 88707 73366', '+91 73057 55370'],

  colours: {
    navy: '#0a1b2e',
    navySoft: '#0f2742',
    accent: '#c08b2e',
    accentSoft: '#d9a54a',
    ink: '#101828',
    muted: '#5b6572',
    line: '#e4e7ec',
    page: '#f2f5f8',
    panel: '#f7f9fb',
  },
} as const;
