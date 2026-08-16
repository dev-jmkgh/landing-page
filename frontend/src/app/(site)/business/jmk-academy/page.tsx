import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { VerticalDetail } from '@/components/business/VerticalDetail';
import { verticalsBySlug } from '@/lib/content/business';
import { pageKeywords, academyTerms } from '@/lib/content/keywords';
import { buildMetadata } from '@/lib/seo';

const vertical = verticalsBySlug.get('jmk-academy');

export const metadata: Metadata = buildMetadata({
  title: vertical?.seo.title ?? 'JMK Academy',
  description: vertical?.seo.description ?? '',
  path: '/business/jmk-academy',
  keywords: pageKeywords(academyTerms),
});

export default function AcademyPage() {
  if (!vertical) notFound();
  return <VerticalDetail vertical={vertical} interest="JMK Academy" />;
}
