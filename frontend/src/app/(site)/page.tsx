import type { Metadata } from 'next';
import Link from 'next/link';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { GroupDiagram } from '@/components/home/GroupDiagram';
import { CtaBand } from '@/components/layout/CtaBand';
import { CountUp } from '@/components/ui/CountUp';
import { Icon } from '@/components/ui/Icon';
import { PatternBackdrop } from '@/components/ui/PatternBackdrop';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { coreValues, missionPoints, visionStatement } from '@/lib/content/about';
import { groupSectors, verticals } from '@/lib/content/business';
import { contributions, heroContent, successStats, welcomeContent, whyChooseUs } from '@/lib/content/home';
import { buildMetadata } from '@/lib/seo';
import { siteConfig } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: `${siteConfig.name} — ${siteConfig.tagline}`,
  description:
    'JMK Global Holdings is a diversified business group in Coimbatore spanning education, engineering design, software, exports, agriculture and renewable energy.',
  path: '/',
  absoluteTitle: true,
});

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="hero">
        <PatternBackdrop className="hero__backdrop" id="hero" variant="blueprint" />
        <span className="hero__glow" aria-hidden="true" />

        <div className="container">
          <div className="hero__inner">
            <div>
              <p className="hero__eyebrow">
                <span>Since 2023</span>
                Coimbatore, Tamil Nadu
              </p>

              <h1 className="hero__title">{heroContent.headline}</h1>
              <p className="hero__subtitle">{heroContent.subheadline}</p>
              <p className="hero__intro">{heroContent.intro}</p>

              <div className="hero__actions">
                <Link className="btn btn--accent btn--lg" href="/business">
                  Explore Our Businesses
                  <Icon name="arrowRight" size={17} />
                </Link>
                <Link className="btn btn--ghost-light btn--lg" href="/contact">
                  Contact Us
                </Link>
              </div>

              <ul className="hero__sectors" aria-label="Sectors we operate in">
                {siteConfig.sectors.map((sector) => (
                  <li className="hero__sector" key={sector}>
                    {sector}
                  </li>
                ))}
              </ul>
            </div>

            <div className="hero__visual">
              <div className="hero__visual-frame">
                <p className="hero__visual-caption">
                  <span>Group Structure</span>
                  <span>3 Verticals</span>
                </p>
                <GroupDiagram />
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------ Success statistics */}
        <div className="hero-stats">
          <div className="container">
            <h2 className="sr-only">Success stories</h2>
            <ul className="hero-stats__grid">
              {successStats.map((stat) => (
                <li className="hero-stats__item" key={stat.label}>
                  <span className="stat__value">
                    <CountUp value={stat.value} suffix={stat.suffix} />
                  </span>
                  <span className="stat__label">{stat.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- Company introduction */}
      <section className="section">
        <div className="container">
          <div className="split">
            <Reveal>
              <SectionHeading eyebrow={welcomeContent.eyebrow} title={welcomeContent.heading} />
              <div className="intro-copy">
                {welcomeContent.paragraphs.map((paragraph) => (
                  <p key={paragraph.slice(0, 32)}>{paragraph}</p>
                ))}
              </div>
              <div className="highlight-row">
                {welcomeContent.highlights.map((highlight) => (
                  <div key={highlight.label}>
                    <p className="highlight-row__label">{highlight.label}</p>
                    <p className="highlight-row__value">{highlight.value}</p>
                  </div>
                ))}
              </div>
              <p style={{ marginTop: '2rem' }}>
                <Link className="link-arrow" href="/about">
                  More about the group
                  <Icon name="arrowRight" size={16} />
                </Link>
              </p>
            </Reveal>

            <Reveal delay={80}>
              <div className="why-grid">
                {whyChooseUs.slice(0, 6).map((reason, index) => (
                  <div className="why-item" key={reason}>
                    <span className="why-item__number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="why-item__label">{reason}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------- Business vertical overview */}
      <section className="section section--muted">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Our Business"
              title="Three focused verticals inside one group"
              description="JMK Academy, JMK Design Studio and JMK Software Solutions deliver training, engineering design and technology services — supported by the group's activity in exports, agriculture, renewable energy and real estate."
            />
          </Reveal>

          <div className="grid grid--3">
            {verticals.map((vertical, index) => (
              <Reveal key={vertical.slug} delay={index * 70}>
                <article className="vertical-card">
                  <div className="vertical-card__head">
                    <span className="vertical-card__mark" aria-hidden="true">
                      {vertical.mark}
                    </span>
                    <div>
                      <h3 className="vertical-card__name">{vertical.name}</h3>
                      <p className="vertical-card__tagline">{vertical.tagline}</p>
                    </div>
                  </div>
                  <div className="vertical-card__body">
                    <p className="vertical-card__summary">{vertical.cardSummary}</p>
                    <ul className="vertical-card__services">
                      {vertical.cardServices.slice(0, 5).map((service) => (
                        <li className="vertical-card__service" key={service}>
                          {service}
                        </li>
                      ))}
                    </ul>
                    <div className="vertical-card__footer">
                      <Link className="link-arrow" href={`/business/${vertical.slug}`}>
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

      {/* ----------------------------------------- Government / national contribution */}
      <section className="section section--dark">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Contribution to National Development"
              title="How our businesses support India's economic development"
              description="JMK Global Holdings actively contributes to India's economic development through its diversified business ecosystem."
            />
          </Reveal>

          <Reveal delay={60}>
            <div className="contribution-grid">
              {contributions.map((contribution) => (
                <article className="contribution" key={contribution.id}>
                  <span className="contribution__icon" aria-hidden="true">
                    <Icon name={contribution.icon} size={22} />
                  </span>
                  <h3 className="contribution__title">{contribution.title}</h3>
                  <p className="contribution__text">{contribution.description}</p>
                </article>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ Why choose */}
      <section className="section">
        <div className="container">
          <div className="split">
            <Reveal>
              <SectionHeading
                eyebrow="Why Choose Us"
                title="Why organisations work with JMK Global Holdings"
                description="One group, multiple industries — with the same commitment to quality across every business."
              />
              <div className="hero__actions" style={{ marginTop: 0 }}>
                <EnquiryTrigger className="btn btn--primary" withIcon>
                  Talk to our team
                </EnquiryTrigger>
                <Link className="btn btn--outline" href="/business">
                  Our Business
                </Link>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="why-grid">
                {whyChooseUs.map((reason, index) => (
                  <div className="why-item" key={reason}>
                    <span className="why-item__number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="why-item__label">{reason}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- Vision & mission */}
      <section className="section section--muted">
        <div className="container">
          <div className="split">
            <Reveal>
              <SectionHeading eyebrow="Vision" title="Where the group is heading" />
              <div className="vision-panel">
                <span className="vision-panel__mark" aria-hidden="true">
                  “
                </span>
                <p className="vision-panel__quote">{visionStatement}</p>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <SectionHeading eyebrow="Mission" title="What we do about it" as="h2" />
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

      {/* -------------------------------------------------------------- Core values */}
      <section className="section">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Core Values"
              title="The standards every JMK business works to"
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

      {/* ----------------------------------------------------------- Group sectors */}
      <section className="section section--sunken">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Group Sectors"
              title="Beyond our three service verticals"
              description="Sectors named in the group's portfolio, described exactly as they contribute to national development."
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
        patternId="home-cta"
        title="Let's build something that lasts"
        text="Whether you are looking for training, engineering design, software or a business partnership across our group, our team will point you to the right people."
        secondary={{ label: 'View Careers', href: '/careers' }}
      />
    </>
  );
}
