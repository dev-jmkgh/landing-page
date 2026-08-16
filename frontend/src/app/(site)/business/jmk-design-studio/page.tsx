import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { VerticalDetail } from '@/components/business/VerticalDetail';
import { verticalsBySlug } from '@/lib/content/business';
import { pageKeywords, designTerms } from '@/lib/content/keywords';
import { buildMetadata } from '@/lib/seo';

const vertical = verticalsBySlug.get('jmk-design-studio');

export const metadata: Metadata = buildMetadata({
  title: vertical?.seo.title ?? 'JMK Design Studio',
  description: vertical?.seo.description ?? '',
  path: '/business/jmk-design-studio',
  keywords: pageKeywords(designTerms),
});

export default function DesignStudioPage() {
  if (!vertical) notFound();
  return <VerticalDetail vertical={vertical} interest="JMK Design Studio" />;
}
