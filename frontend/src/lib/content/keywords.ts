/**
 * Search vocabulary for the site.
 *
 * Every term below describes something the company actually offers, taken from
 * `docs/content-map.md`. Nothing here names a tool, certification, client or capability
 * the source document does not — a keyword list is still a public claim about the
 * business, and an invented one is a lie that happens to be in a meta tag.
 *
 * Two consumers:
 *   - `buildMetadata` emits them as `<meta name="keywords">`
 *   - `organizationJsonLd` emits the group-level set as schema.org `knowsAbout`
 *
 * On the meta tag specifically: Google has ignored it since 2009 and Bing treats it as a
 * spam signal rather than a ranking one. It is included because it costs nothing and is
 * still read by some regional engines and on-site search tools — but the page titles and
 * descriptions in each `buildMetadata` call are what actually rank, and the terms here
 * are deliberately mirrored there.
 */

/** Brand and locality. Indian search is overwhelmingly local-intent. */
const brand = ['JMK Global Holdings', 'JMK Global Holdings Coimbatore', 'JMK Group'];

const location = ['Coimbatore', 'Tamil Nadu', 'India'];

/* -------------------------------------------------------------------------- */
/* Per-vertical vocabulary                                                     */
/* -------------------------------------------------------------------------- */

/** JMK Academy — CAD DESK and SAP training. */
export const academyTerms = [
  'CAD training Coimbatore',
  'engineering CAD training',
  'CAD DESK Coimbatore',
  'SAP training Coimbatore',
  'SAP ABAP training',
  'SAP BASIS training',
  'SAP FICO training',
  'SAP MM training',
  'SAP SD training',
  'SAP CSM training',
  'corporate training Coimbatore',
  'industry workshops',
  'placement assistance',
];

/** JMK Design Studio — all CAD designing works. */
export const designTerms = [
  'CAD design services Coimbatore',
  '2D drafting services',
  '3D modeling services',
  'product design services',
  'architectural visualization',
  'industrial design',
  'rendering services',
  'reverse engineering services',
  'engineering drawings',
];

/** JMK Software Solutions. */
export const softwareTerms = [
  'software development company Coimbatore',
  'custom software development',
  'ERP solutions',
  'case management software',
  'student management software',
  'website development Coimbatore',
  'mobile application development',
  'analytics dashboard',
  'cloud applications',
  'SAP license and server solutions',
  'digital marketing support',
  'domain and hosting services',
  'email box server',
];

/** Group activities that have no service catalogue of their own. */
export const groupSectorTerms = [
  'agricultural exports',
  'export company Coimbatore',
  'integrated farming',
  'sustainable agriculture',
  'renewable energy',
  'solar energy',
  'wind energy',
  'biogas',
  'real estate',
];

/** Careers — the published role families. */
export const careersTerms = [
  'jobs in Coimbatore',
  'careers at JMK Global Holdings',
  'CAD trainer jobs',
  'SAP trainer jobs',
  'software developer jobs Coimbatore',
  'UI UX designer jobs',
  'civil engineer jobs',
  'mechanical engineer jobs',
  'electrical engineer jobs',
  'business development executive jobs',
  'digital marketing executive jobs',
  'export executive jobs',
  'HR jobs Coimbatore',
];

/** What the group as a whole does — also emitted as schema.org `knowsAbout`. */
export const groupTerms = [
  'diversified business group',
  'education and training',
  'engineering design',
  'software development',
  'exports',
  'agriculture',
  'renewable energy',
  'real estate',
];

/* -------------------------------------------------------------------------- */

/**
 * Combines term groups into one page's keyword list.
 *
 * Brand and locality are always included, duplicates are removed case-insensitively,
 * and the result is capped: a list long enough to look like keyword stuffing is worse
 * than no list, and nothing reads past the first couple of dozen anyway.
 */
export function pageKeywords(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of [...brand, ...groups.flat(), ...location]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
  }

  return result.slice(0, 25);
}
