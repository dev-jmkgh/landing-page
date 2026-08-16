import Link from 'next/link';
import { AcademyCatalogue } from '@/components/academy/AcademyCatalogue';
import { CtaBand } from '@/components/layout/CtaBand';
import { PageHero } from '@/components/layout/PageHero';
import { Icon } from '@/components/ui/Icon';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { verticals, type Vertical } from '@/lib/content/business';
import { verticalVisuals } from '@/lib/content/visuals';
import { breadcrumbJsonLd } from '@/lib/seo';

type VerticalDetailProps = {
  vertical: Vertical;
  /** Pre-selects the enquiry modal's "Interested In" value. */
  interest: string;
};

/**
 * Shared layout for the three business vertical pages. Content differs entirely by
 * data, so the presentation lives in one place.
 */
export function VerticalDetail({ vertical, interest }: VerticalDetailProps) {
  const trail = [
    { name: 'Home', path: '/' },
    { name: 'Our Business', path: '/business' },
    { name: vertical.name, path: `/business/${vertical.slug}` },
  ];

  const others = verticals.filter((item) => item.slug !== vertical.slug);

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      <PageHero
        patternId={`${vertical.slug}-hero`}
        variant="blueprint"
        trail={trail}
        eyebrow={`${vertical.hero.eyebrow} · ${vertical.name}`}
        title={vertical.hero.heading}
        intro={vertical.hero.intro}
        meta={vertical.cardServices.slice(0, 5)}
        visual={verticalVisuals[vertical.slug]}
      />

      {/*
        The Academy gets a catalogue ahead of its service list: image-led CAD tiles,
        then SAP as its own section with a banner and a "why" on every module. The
        other two verticals go straight to their services, which is what they are.
      */}
      {vertical.slug === 'jmk-academy' ? <AcademyCatalogue /> : null}

      <section className="section">
        <div className="container">
          {vertical.groups.map((group) => (
            <div className="service-group" key={group.id}>
              <Reveal>
                <div className="service-group__head">
                  <span className="service-group__icon" aria-hidden="true">
                    <Icon name={group.icon} size={22} />
                  </span>
                  <div>
                    <h2 className="service-group__title">{group.title}</h2>
                    {group.intro ? <p className="service-group__intro">{group.intro}</p> : null}
                  </div>
                </div>
              </Reveal>

              <div className="service-list">
                {group.services.map((service, index) => (
                  <Reveal key={service.name} delay={index * 60}>
                    <article className="service-item">
                      <h3 className="service-item__name">{service.name}</h3>
                      {service.description ? (
                        <p className="service-item__text">{service.description}</p>
                      ) : null}
                      {service.items ? (
                        <ul className="service-item__tags">
                          {service.items.map((item) => (
                            <li className="pill" key={item}>
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  </Reveal>
                ))}
              </div>

              {group.externalCta ? (
                <Reveal delay={80}>
                  <div className="external-cta">
                    <p className="external-cta__note">{group.externalCta.note}</p>
                    <a
                      className="btn btn--primary"
                      href={group.externalCta.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {group.externalCta.label}
                      <Icon name="external" size={16} />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </div>
                </Reveal>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- Other group verticals */}
      <section className="section section--muted">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Also in the group"
              title="Other JMK Global Holdings businesses"
            />
          </Reveal>
          <div className="card-grid card-grid--2">
            {others.map((item, index) => (
              <Reveal key={item.slug} delay={index * 70}>
                <article className="card card--interactive card--accent-top">
                  <span className="card__icon" aria-hidden="true">
                    <Icon name={item.icon} size={24} />
                  </span>
                  <h3 className="card__title">{item.name}</h3>
                  <p className="card__text">{item.cardSummary}</p>
                  <div className="card__footer">
                    <Link className="link-arrow" href={`/business/${item.slug}`}>
                      Explore Business
                      <Icon name="arrowRight" size={16} />
                    </Link>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CtaBand
        patternId={`${vertical.slug}-cta`}
        title={`Talk to the ${vertical.name} team`}
        text="Tell us what you are planning and we will come back with the right people, timelines and next steps."
        interest={interest}
        secondary={{ label: 'All Businesses', href: '/business' }}
      />
    </>
  );
}
