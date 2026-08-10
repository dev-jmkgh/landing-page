import type { MetadataRoute } from 'next';
import { verticals } from '@/lib/content/business';
import { absoluteUrl } from '@/lib/seo';

/**
 * Static sitemap generated at build time (`out/sitemap.xml`).
 * The admin area is intentionally excluded and is also blocked in robots.txt.
 */
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  const routes: { path: string; priority: number; changeFrequency: 'weekly' | 'monthly' | 'yearly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'weekly' },
    { path: '/about', priority: 0.9, changeFrequency: 'monthly' },
    { path: '/business', priority: 0.9, changeFrequency: 'monthly' },
    ...verticals.map((vertical) => ({
      path: `/business/${vertical.slug}`,
      priority: 0.8,
      changeFrequency: 'monthly' as const,
    })),
    { path: '/gallery', priority: 0.6, changeFrequency: 'monthly' },
    { path: '/careers', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/contact', priority: 0.8, changeFrequency: 'monthly' },
    { path: '/privacy-policy', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  ];

  return routes.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
