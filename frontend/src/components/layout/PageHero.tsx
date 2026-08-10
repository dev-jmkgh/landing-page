import { Breadcrumbs, type Crumb } from '@/components/ui/Breadcrumbs';
import { PatternBackdrop } from '@/components/ui/PatternBackdrop';

type PageHeroProps = {
  eyebrow: string;
  title: string;
  intro?: string;
  trail: Crumb[];
  /** Small pills under the intro, e.g. service categories. */
  meta?: readonly string[];
  patternId: string;
  variant?: 'grid' | 'blueprint';
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
}: PageHeroProps) {
  return (
    <section className="page-hero">
      <PatternBackdrop className="page-hero__backdrop" id={patternId} variant={variant} />
      <div className="container">
        <div className="page-hero__inner">
          <Breadcrumbs trail={trail} onDark />
          <p className="eyebrow" style={{ marginTop: '1.25rem', marginBottom: 0 }}>
            {eyebrow}
          </p>
          <h1 className="page-hero__title">{title}</h1>
          {intro ? <p className="page-hero__intro">{intro}</p> : null}
          {meta && meta.length > 0 ? (
            <ul className="page-hero__meta">
              {meta.map((item) => (
                <li key={item} className="pill pill--on-dark">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
