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
  /** Primary first — the email footer prints them in this order. */
  phones: ['+91 73057 55370', '+91 88707 73366'],

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

    /*
     * Status tones, for figures that are good or bad news rather than neutral — the
     * daily report's tiles and its "needs attention" panel. The site's own success,
     * warning and danger tokens (frontend tokens.css), so a figure reads the same in the
     * email as on the dashboard it summarises.
     */
    good: '#17795e',
    goodSoft: '#e8f6f1',
    warn: '#b54708',
    warnSoft: '#fdf3e6',
    bad: '#b42318',
    badSoft: '#fdecea',
  },
} as const;
