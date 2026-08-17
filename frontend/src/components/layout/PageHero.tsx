import { Breadcrumbs, type Crumb } from '@/components/ui/Breadcrumbs';
import { PatternBackdrop } from '@/components/ui/PatternBackdrop';
import { Photo } from '@/components/ui/Photo';
import { TechnicalOverlay } from '@/components/visuals/TechnicalOverlay';
import type { HeroImage } from '@/lib/content/heroImages';

type PageHeroProps = {
  eyebrow: string;
  title: string;
  intro?: string;
  trail: Crumb[];
  /** Small pills under the intro, e.g. service categories. */
  meta?: readonly string[];
  patternId: string;
  variant?: 'grid' | 'blueprint';
  /**
   * Photograph filling the band, as on the home hero. Each page passes its own — see
   * `lib/content/heroImages.ts`. Without it the band falls back to the drafting
   * pattern alone, which is what the legal pages use.
   */
  image?: HeroImage;
  /**
   * Small qualifying line under the intro, set off by a gold rule. The gallery uses it
   * for the notice that its photographs represent each discipline rather than showing
   * JMK's own facilities — a statement that has to travel with the images, so it lives
   * in the hero rather than further down the page.
   */
  note?: string;
};

/** Shared hero for every interior page: breadcrumbs, eyebrow, H1 and intro. */
export function PageHero({
  eyebrow,
  title,
  intro,
  trail,
  meta,
  patternId,
  variant = 'grid',
  image,
  note,
}: PageHeroProps) {
  return (
    <section className={image ? 'page-hero page-hero--photo' : 'page-hero'}>
      {image ? (
        <div className="page-hero__media">
          {/*
            An <img> rather than a CSS background so it can carry a srcSet. A
            background-image would hand every visitor the same file, and on these pages
            this is the largest contentful paint. `priority` for the same reason: it is
            above the fold, where lazy loading delays the paint instead of helping it.
          */}
          <Photo
            className="page-hero__image"
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            sizes="100vw"
            variants={image.variants}
            priority
            style={image.objectPosition ? { objectPosition: image.objectPosition } : undefined}
          />
          <span className="page-hero__scrim" aria-hidden="true" />
          <TechnicalOverlay
            variant={image.overlay}
            id={patternId}
            className="page-hero__drawing"
          />
        </div>
      ) : (
        <PatternBackdrop className="page-hero__backdrop" id={patternId} variant={variant} />
      )}

      <div className="container">
        <div className="page-hero__inner">
          <Breadcrumbs trail={trail} />
          <p className="eyebrow" style={{ marginTop: '1.25rem', marginBottom: 0 }}>
            {eyebrow}
          </p>
          <h1 className="page-hero__title">{title}</h1>
          {intro ? <p className="page-hero__intro">{intro}</p> : null}
          {note ? <p className="page-hero__note">{note}</p> : null}
          {meta && meta.length > 0 ? (
            <ul className="page-hero__meta">
              {meta.map((item) => (
                <li key={item} className="pill">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <span className="page-hero__fade" aria-hidden="true" />
    </section>
  );
}
