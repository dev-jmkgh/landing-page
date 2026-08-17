import type { Metadata } from 'next';
import Link from 'next/link';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { ContributionGrid } from '@/components/home/ContributionGrid';
import { CtaBand } from '@/components/layout/CtaBand';
import { CountUp } from '@/components/ui/CountUp';
import { Icon } from '@/components/ui/Icon';
import { Reveal } from '@/components/ui/Reveal';
import { HERO_VARIANTS, Photo } from '@/components/ui/Photo';
import { TechnicalOverlay } from '@/components/visuals/TechnicalOverlay';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pageKeywords, groupTerms, groupSectorTerms } from '@/lib/content/keywords';
import { groupSectors, verticals } from '@/lib/content/business';
import { heroContent, successStats, welcomeContent, whyChooseUs } from '@/lib/content/home';
import { buildMetadata } from '@/lib/seo';
import { siteConfig } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: `${siteConfig.name} — ${siteConfig.tagline}`,
  description:
    'JMK Global Holdings is a diversified business group in Coimbatore spanning education, engineering design, software, exports, agriculture and renewable energy.',
  path: '/',
  keywords: pageKeywords(groupTerms, groupSectorTerms),
  absoluteTitle: true,
});

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      {/*
        A cinematic band: the photograph fills the section and the copy sits on it,
        rather than the copy sitting beside a picture in a card. The image is an <img>
        rather than a CSS background so it can carry a srcset — a background-image
        would hand every visitor the same file, and this is the largest contentful
        paint on the site.
      */}
      <section className="hero">
        <div className="hero__media">
          <Photo
            className="hero__image"
            src="/images/gallery/hero-engineering-design-review.jpg"
            alt="Two engineers reviewing a detailed technical cross-section drawing alongside the physical assembly"
            width={2400}
            height={1601}
            sizes="100vw"
            variants={HERO_VARIANTS}
            priority
          />
          <span className="hero__scrim" aria-hidden="true" />
          <TechnicalOverlay variant="measure" id="hero" className="hero__drawing" />
        </div>

        <div className="container">
          <div className="hero__content">
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
              <EnquiryTrigger className="btn btn--outline btn--lg">
                Enquire Now
              </EnquiryTrigger>
            </div>
          </div>
        </div>

        <span className="hero__fade" aria-hidden="true" />
      </section>

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
      <section className="section section--canvas">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Our Business"
              title="Three focused verticals inside one group"
              description="JMK Academy, JMK Design Studio and JMK Software Solutions deliver training, engineering design and technology services — supported by the group's activity in exports, agriculture, renewable energy and real estate."
            />
          </Reveal>

          <div className="card-grid card-grid--3">
            {verticals.map((vertical, index) => (
              <Reveal key={vertical.slug} delay={index * 70}>
                <article className="vertical-card">
                  {/* Image first: the card leads with the discipline, then names it. */}
                  <div className="vertical-card__media">
                    <Photo
                      src={vertical.image.src}
                      alt={vertical.image.alt}
                      width={vertical.image.width}
                      height={vertical.image.height}
                      sizes="(max-width: 639px) 92vw, (max-width: 1199px) 46vw, 30vw"
                    />
                  </div>
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
      <section className="section section--blue">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Contribution to National Development"
              title="How our businesses support India's economic development"
              description="JMK Global Holdings actively contributes to India's economic development through its diversified business ecosystem."
            />
          </Reveal>

          <ContributionGrid />
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
