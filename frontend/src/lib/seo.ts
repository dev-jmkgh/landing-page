import type { Metadata } from 'next';
import { SITE_URL, contactDetails, formattedAddress, siteConfig, socialLinks } from '@/lib/site';

/** Absolute URL for a route path such as `/about`. */
export function absoluteUrl(path = '/'): string {
  if (path === '/') return `${SITE_URL}/`;
  const clean = `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  return `${SITE_URL}${clean}`;
}

type PageMetaInput = {
  title: string;
  description: string;
  path: string;
  /** Page-specific social card. Defaults to the generated group card. */
  image?: string;
  /**
   * Skips the `%s | JMK Global Holdings` template. Used by the home page, whose title
   * already carries the company name.
   */
  absoluteTitle?: boolean;
};

/**
 * Default social card, produced as a real 1200×630 PNG by
 * `scripts/generate-og-image.mjs` on every build (social platforms do not reliably
 * render SVG share images).
 */
export const DEFAULT_OG_IMAGE = '/images/og/og-default.png';

/**
 * Builds the per-page metadata block: unique title, description, canonical URL,
 * Open Graph and Twitter cards.
 */
export function buildMetadata({
  title,
  description,
  path,
  image,
  absoluteTitle = false,
}: PageMetaInput): Metadata {
  const url = absoluteUrl(path);
  const imageUrl = `${SITE_URL}${image ?? DEFAULT_OG_IMAGE}`;

  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      url,
      siteName: siteConfig.name,
      title,
      description,
      locale: siteConfig.locale,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [imageUrl],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Structured data                                                             */
/*                                                                             */
/* Only properties backed by the supplied document are emitted — no invented    */
/* founding dates beyond 2023, employee counts, ratings or price ranges.        */
/* -------------------------------------------------------------------------- */

export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: siteConfig.name,
    url: `${SITE_URL}/`,
    description: siteConfig.description,
    foundingDate: String(siteConfig.foundedYear),
    founders: siteConfig.founders.map((name) => ({ '@type': 'Person', name })),
    email: contactDetails.email,
    telephone: contactDetails.phones[0].label,
    address: {
      '@type': 'PostalAddress',
      streetAddress: contactDetails.address.lines.join(', '),
      addressLocality: contactDetails.address.locality,
      addressRegion: contactDetails.address.region,
      postalCode: contactDetails.address.postalCode,
      addressCountry: contactDetails.address.countryCode,
    },
    sameAs: socialLinks.map((link) => link.href),
  };
}

export function localBusinessJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${SITE_URL}/contact/#localbusiness`,
    name: siteConfig.name,
    url: absoluteUrl('/contact'),
    description: siteConfig.description,
    email: contactDetails.email,
    telephone: contactDetails.phones.map((phone) => phone.label),
    address: {
      '@type': 'PostalAddress',
      streetAddress: contactDetails.address.lines.join(', '),
      addressLocality: contactDetails.address.locality,
      addressRegion: contactDetails.address.region,
      postalCode: contactDetails.address.postalCode,
      addressCountry: contactDetails.address.countryCode,
    },
    parentOrganization: { '@id': `${SITE_URL}/#organization` },
  };
}

export function webSiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: siteConfig.name,
    description: siteConfig.description,
    publisher: { '@id': `${SITE_URL}/#organization` },
    inLanguage: 'en-IN',
  };
}

export function breadcrumbJsonLd(trail: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

export function postalAddressText() {
  return formattedAddress;
}
