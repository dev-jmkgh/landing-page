import { Breadcrumbs, type Crumb } from '@/components/ui/Breadcrumbs';
import { PatternBackdrop } from '@/components/ui/PatternBackdrop';
import { TechnicalVisual } from '@/components/visuals/TechnicalVisual';
import type { VisualSpec } from '@/lib/content/visuals';

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
   * Optional technical drawing shown beside the copy. Each page passes its own spec so
   * no two heroes render the same picture — see `lib/content/visuals.ts`.
   */
  visual?: VisualSpec;
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
  visual,
}: PageHeroProps) {
  return (
    <section className="page-hero">
      <PatternBackdrop className="page-hero__backdrop" id={patternId} variant={variant} />
      <div className="container">
        <div className={visual ? 'page-hero__grid' : undefined}>
          <div className="page-hero__inner">
            <Breadcrumbs trail={trail} />
            <p className="eyebrow" style={{ marginTop: '1.25rem', marginBottom: 0 }}>
              {eyebrow}
            </p>
            <h1 className="page-hero__title">{title}</h1>
            {intro ? <p className="page-hero__intro">{intro}</p> : null}
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
          {visual ? <TechnicalVisual spec={visual} className="page-hero__visual" /> : null}
        </div>
      </div>
    </section>
  );
}
