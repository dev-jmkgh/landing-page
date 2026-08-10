import type { Metadata } from 'next';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { CtaBand } from '@/components/layout/CtaBand';
import { PageHero } from '@/components/layout/PageHero';
import { JsonLd } from '@/components/ui/JsonLd';
import { breadcrumbJsonLd, buildMetadata } from '@/lib/seo';

export const metadata: Metadata = buildMetadata({
  title: 'Gallery',
  description:
    'Images from across JMK Global Holdings: training, engineering design, software delivery, exports and renewable energy.',
  path: '/gallery',
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Gallery', path: '/gallery' },
];

export default function GalleryPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      <PageHero
        patternId="gallery-hero"
        trail={trail}
        eyebrow="Gallery"
        title="Our work across the group"
        intro="Images from across JMK Global Holdings. Photography is published business by business as each team releases it — nothing here is stock imagery presented as our own."
      />

      <section className="section">
        <div className="container">
          <GalleryGrid />
        </div>
      </section>

      <CtaBand
        patternId="gallery-cta"
        title="Want to see more of what we do?"
        text="Ask us for details of the work behind any of our businesses and we will share what we can."
        secondary={{ label: 'Our Business', href: '/business' }}
      />
    </>
  );
}
