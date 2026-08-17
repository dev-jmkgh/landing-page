import type { Metadata } from 'next';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { PageHero } from '@/components/layout/PageHero';
import { CtaBand } from '@/components/layout/CtaBand';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { pageKeywords, academyTerms, designTerms, softwareTerms, groupSectorTerms } from '@/lib/content/keywords';
import { galleryHero } from '@/lib/content/heroImages';
import { breadcrumbJsonLd, buildMetadata } from '@/lib/seo';

export const metadata: Metadata = buildMetadata({
  title: 'Gallery — Skills, Engineering & Technology',
  description:
    'A visual view of the JMK Global Holdings verticals: CAD and engineering training, design and drafting, software and cloud, renewable energy, farming and exports.',
  path: '/gallery',
  keywords: pageKeywords(
    academyTerms.slice(0, 2),
    designTerms.slice(0, 3),
    softwareTerms.slice(0, 2),
    groupSectorTerms.slice(0, 4),
  ),
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Gallery', path: '/gallery' },
];

export default function GalleryPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      {/*
        The shared hero, not a bespoke one. This page used to build its own two-column
        band with a blueprint animation beside the copy — which is exactly the
        arrangement every other page moved away from, so the gallery was the one hero
        left without a photograph.
      */}
      <PageHero
        patternId="gallery-hero"
        variant="blueprint"
        trail={trail}
        eyebrow="Our Gallery"
        title="Where skills, engineering and technology come together"
        intro="A visual view of what the group actually does — CAD and engineering training, design and drafting, software and cloud, and the renewable energy, farming and export activity behind it."
        note="These are representative images of each discipline, not photographs of JMK facilities, people or projects. Our own photography replaces them as each business releases it."
        image={galleryHero}
      />

      {/* ---------------------------------------------------------- Gallery */}
      <section className="section section--canvas">
        <div className="container">
          <Reveal>
            <GalleryGrid />
          </Reveal>

          <p className="gallery-credits">
            Photography licensed via{' '}
            <a href="https://unsplash.com/license" target="_blank" rel="noopener noreferrer">
              Unsplash
            </a>
            . Each image represents the discipline described in its caption. Individual
            photographers are credited in the enlarged view.
          </p>
        </div>
      </section>

      <CtaBand
        patternId="gallery-cta"
        title="Want to see the work behind these capabilities?"
        text="Talk to the team about training, engineering design, software or a partnership across the group."
        secondary={{ label: 'Our Business', href: '/business' }}
      />
    </>
  );
}
