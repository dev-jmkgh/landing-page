import type { Metadata } from 'next';
import { BlueprintAnimation } from '@/components/gallery/BlueprintAnimation';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { CtaBand } from '@/components/layout/CtaBand';
import { Breadcrumbs } from '@/components/ui/Breadcrumbs';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { pageKeywords, academyTerms, designTerms, softwareTerms, groupSectorTerms } from '@/lib/content/keywords';
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

      {/* ------------------------------------------------------------- Hero */}
      <section className="gallery-hero">
        <div className="container">
          <div className="gallery-hero__inner">
            <div>
              <Breadcrumbs trail={trail} />
              <p className="eyebrow" style={{ marginTop: '1.25rem', marginBottom: 0 }}>
                Our Gallery
              </p>
              <h1 className="gallery-hero__title">
                Where skills, engineering and technology come together
              </h1>
              <p className="gallery-hero__intro">
                A visual view of what the group actually does — CAD and engineering training,
                design and drafting, software and cloud, and the renewable energy, farming and
                export activity behind it.
              </p>
              <p className="gallery-hero__note">
                These are representative images of each discipline, not photographs of JMK
                facilities, people or projects. Our own photography replaces them as each
                business releases it.
              </p>
            </div>

            <BlueprintAnimation />
          </div>
        </div>
      </section>

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
