import type { Metadata } from 'next';
import { CtaBand } from '@/components/layout/CtaBand';
import { PageHero } from '@/components/layout/PageHero';
import { CountUp } from '@/components/ui/CountUp';
import { Icon } from '@/components/ui/Icon';
import { JsonLd } from '@/components/ui/JsonLd';
import { Photo } from '@/components/ui/Photo';
import { Reveal } from '@/components/ui/Reveal';
import { TechnicalOverlay } from '@/components/visuals/TechnicalOverlay';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pageKeywords, groupTerms, groupSectorTerms } from '@/lib/content/keywords';
import { coreValues, founders, missionPoints, visionStatement, whoWeAre } from '@/lib/content/about';
import { successStats } from '@/lib/content/home';
import { aboutHero } from '@/lib/content/heroImages';
import { breadcrumbJsonLd, buildMetadata } from '@/lib/seo';
import { siteConfig } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: 'About Us — Our Story, Vision & Values',
  description:
    'Founded in 2023 by Jose AM and Muthu Krishnan Anantham, JMK Global Holdings is a diversified corporate group headquartered in Coimbatore, Tamil Nadu.',
  path: '/about',
  keywords: pageKeywords(['about JMK Global Holdings', 'diversified business group Coimbatore'], groupTerms, groupSectorTerms),
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'About Us', path: '/about' },
];

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export default function AboutPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      <PageHero
        patternId="about-hero"
        trail={trail}
        eyebrow="About Us"
        title="One group, seven sectors, a single standard of quality"
        intro="JMK Global Holdings brings together training, engineering design, software, exports, agriculture, renewable energy and real estate under one brand — with a commitment to creating opportunity alongside profit."
        meta={siteConfig.sectors}
        image={aboutHero}
      />

      {/* ----------------------------------------------------------- Who we are */}
      <section className="section">
        <div className="container">
          <div className="split">
            <Reveal>
              <SectionHeading eyebrow={whoWeAre.eyebrow} title={whoWeAre.heading} />
              <div className="intro-copy">
                {whoWeAre.paragraphs.map((paragraph) => (
                  <p key={paragraph.slice(0, 32)}>{paragraph}</p>
                ))}
              </div>

              <h3 style={{ marginTop: '2.5rem', fontSize: 'var(--text-xl)' }}>Leadership</h3>
              <div className="founder-row" style={{ marginTop: '1rem' }}>
                {founders.map((founder) => (
                  <div className="founder-card" key={founder.name}>
                    <span className="founder-card__initials" aria-hidden="true">
                      {initials(founder.name)}
                    </span>
                    <span className="label-stack">
                      <span className="label-stack__title">{founder.name}</span>
                      <span className="label-stack__description">{founder.role}</span>
                    </span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={80}>
              {/* A real photograph with the drawing laid over it — the recurring JMK
                  signature, rather than a generated placeholder composition. */}
              <figure className="about-figure">
                <Photo
                  src="/images/gallery/about-team-collaboration.jpg"
                  alt="Colleagues reviewing work together around a laptop in a bright meeting room"
                  width={1800}
                  height={1202}
                  sizes="(max-width: 900px) 92vw, 45vw"
                />
                <span className="about-figure__wash" aria-hidden="true" />
                <TechnicalOverlay variant="grid" id="about" className="about-figure__drawing" />
              </figure>
              <div className="highlight-row" style={{ marginTop: '1.5rem' }}>
                <div>
                  <p className="highlight-row__label">Founded</p>
                  <p className="highlight-row__value">2023</p>
                </div>
                <div>
                  <p className="highlight-row__label">Headquarters</p>
                  <p className="highlight-row__value">Coimbatore, Tamil Nadu</p>
                </div>
                <div>
                  <p className="highlight-row__label">Co-Founders</p>
                  <p className="highlight-row__value">Jose AM · Muthu Krishnan Anantham</p>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- Success stories */}
      <section className="section section--muted">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Success Stories"
              title="Progress since 2023"
              align="center"
            />
          </Reveal>
          <Reveal delay={60}>
            <ul className="card-grid card-grid--3" style={{ textAlign: 'center' }}>
              {successStats.map((stat) => (
                <li className="card stat--light" key={stat.label} style={{ alignItems: 'center' }}>
                  <span className="stat__value">
                    <CountUp value={stat.value} suffix={stat.suffix} />
                  </span>
                  <span className="stat__label" style={{ marginTop: '0.5rem' }}>
                    {stat.label}
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------ Vision & mission */}
      <section className="section">
        <div className="container">
          <div className="split">
            <Reveal>
              <SectionHeading eyebrow="Vision" title="Our vision" />
              <div className="vision-panel">
                <span className="vision-panel__mark" aria-hidden="true">
                  “
                </span>
                <p className="vision-panel__quote">{visionStatement}</p>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <SectionHeading eyebrow="Mission" title="Our mission" />
              <ol className="mission-list">
                {missionPoints.map((point) => (
                  <li className="mission-list__item" key={point}>
                    <p className="mission-list__text">{point}</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- Values */}
      <section className="section section--sunken">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Core Values"
              title="Eight values, applied across every business"
              align="center"
            />
          </Reveal>
          <div className="values-grid">
            {coreValues.map((value, index) => (
              <Reveal key={value.name} delay={index * 50}>
                <article className="value-card">
                  <span className="value-card__index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="value-card__icon" aria-hidden="true">
                    <Icon name={value.icon} size={26} />
                  </span>
                  <h3 className="value-card__name">{value.name}</h3>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CtaBand
        patternId="about-cta"
        title="Work with a group built for the long term"
        text="Talk to us about training, engineering design, software, exports or a partnership across the group."
        secondary={{ label: 'Our Business', href: '/business' }}
      />
    </>
  );
}
