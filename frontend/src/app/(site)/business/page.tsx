import type { Metadata } from 'next';
import Link from 'next/link';
import { CtaBand } from '@/components/layout/CtaBand';
import { PageHero } from '@/components/layout/PageHero';
import { Icon } from '@/components/ui/Icon';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { groupSectors, verticals } from '@/lib/content/business';
import { businessVisual } from '@/lib/content/visuals';
import { breadcrumbJsonLd, buildMetadata } from '@/lib/seo';

export const metadata: Metadata = buildMetadata({
  title: 'Our Business — Training, Design & Software',
  description:
    'Explore the JMK Global Holdings ecosystem: JMK Academy, JMK Design Studio and JMK Software Solutions, plus exports, agriculture and renewable energy.',
  path: '/business',
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Our Business', path: '/business' },
];

export default function BusinessPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      <PageHero
        patternId="business-hero"
        variant="blueprint"
        trail={trail}
        eyebrow="Our Business"
        title="One group. Multiple industries. Unlimited possibilities."
        intro="Three service verticals form the core of JMK Global Holdings, supported by group activity in exports, agriculture, renewable energy and real estate."
        meta={verticals.map((vertical) => vertical.name)}
        visual={businessVisual}
      />

      {/* ------------------------------------------------------------ Verticals */}
      <section className="section">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Business Verticals"
              title="Where our teams deliver day to day"
              description="Each vertical runs its own specialists, while sharing the group's standards for quality, delivery and customer care."
            />
          </Reveal>

          <div className="card-grid card-grid--3">
            {verticals.map((vertical, index) => (
              <Reveal key={vertical.slug} delay={index * 70}>
                <article className="vertical-card">
                  <div className="vertical-card__head">
                    <span className="vertical-card__mark" aria-hidden="true">
                      {vertical.mark}
                    </span>
                    <div className="vertical-card__head-text">
                      <h3 className="vertical-card__name">{vertical.name}</h3>
                      <p className="vertical-card__tagline">{vertical.tagline}</p>
                    </div>
                  </div>

                  <div className="vertical-card__body">
                    <p className="vertical-card__summary">{vertical.cardSummary}</p>

                    <h4
                      className="footer-heading"
                      style={{ color: 'var(--ink-400)', marginTop: '1.5rem', marginBottom: '0.75rem' }}
                    >
                      Services
                    </h4>
                    <ul className="check-list">
                      {vertical.cardServices.map((service) => (
                        <li className="check-list__item" key={service}>
                          <span className="check-list__icon" aria-hidden="true">
                            <Icon name="check" size={12} strokeWidth={2.4} />
                          </span>
                          <span>{service}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="vertical-card__footer">
                      <Link className="btn btn--outline btn--block" href={`/business/${vertical.slug}`}>
                        Explore Business
                        <Icon name="arrowRight" size={16} />
                      </Link>
                    </div>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Group sectors */}
      <section className="section section--dark" id="sectors">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Group Sectors"
              title="Exports, agriculture, renewable energy and real estate"
              description="These sectors sit within the group's diversified portfolio."
            />
          </Reveal>

          <Reveal delay={60}>
            <div className="sector-list">
              {groupSectors.map((sector) => (
                <article className="sector-item" key={sector.id}>
                  <h3 className="sector-item__name">
                    <Icon name={sector.icon} size={18} />
                    {sector.name}
                  </h3>
                  <p className="sector-item__text">{sector.description}</p>
                </article>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <CtaBand
        patternId="business-cta"
        title="Not sure which team you need?"
        text="Send us one enquiry and we will route it to the right vertical — training, design, software, exports or the wider group."
        secondary={{ label: 'Contact Us', href: '/contact' }}
      />
    </>
  );
}
