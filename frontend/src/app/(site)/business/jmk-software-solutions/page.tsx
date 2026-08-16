import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { VerticalDetail } from '@/components/business/VerticalDetail';
import { verticalsBySlug } from '@/lib/content/business';
import { pageKeywords, softwareTerms } from '@/lib/content/keywords';
import { buildMetadata } from '@/lib/seo';

const vertical = verticalsBySlug.get('jmk-software-solutions');

export const metadata: Metadata = buildMetadata({
  title: vertical?.seo.title ?? 'JMK Software Solutions',
  description: vertical?.seo.description ?? '',
  path: '/business/jmk-software-solutions',
  keywords: pageKeywords(softwareTerms),
});

export default function SoftwareSolutionsPage() {
  if (!vertical) notFound();
  return <VerticalDetail vertical={vertical} interest="JMK Software Solutions" />;
}
