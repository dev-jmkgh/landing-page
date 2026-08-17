import { CourseTile, SapModuleTile } from '@/components/academy/CourseTile';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { Carousel } from '@/components/ui/Carousel';
import { Icon } from '@/components/ui/Icon';
import { Photo } from '@/components/ui/Photo';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { TechnicalOverlay } from '@/components/visuals/TechnicalOverlay';
import { academyPromises, cadTiles, sapBanner, sapModules } from '@/lib/content/academy';

/**
 * The Academy catalogue: CAD as image tiles, then SAP as a section of its own.
 *
 * Structured as a training catalogue rather than a services list — a prospective
 * learner is choosing between disciplines, so the page leads with what each one looks
 * like and what it covers, and only then lists the service detail underneath.
 *
 * The SAP banner carries a `flow` overlay rather than the `measure` one used for CAD:
 * SAP is a chain of process steps, and the drawing should say something about its own
 * subject rather than repeating the same figure on every section.
 */
export function AcademyCatalogue() {
  return (
    <>
      {/* ------------------------------------------------------------ CAD tiles */}
      <section className="section">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="CAD & Engineering"
              title="Engineering CAD training"
              description="Delivered through CAD DESK Coimbatore, alongside corporate programmes, industry workshops and placement assistance."
            />
          </Reveal>

          {/* A carousel rather than a grid: four tiles do not fit three-up, so there
              is always one more to reach, and on a phone a row of scrollable cards
              beats a column four screens long. */}
          <Carousel label="CAD and engineering training">
            {cadTiles.map((tile, index) => (
              <Reveal key={tile.id} delay={index * 70}>
                <CourseTile tile={tile} />
              </Reveal>
            ))}
          </Carousel>
        </div>
      </section>

      {/* ----------------------------------------------------------------- SAP */}
      <section className="section section--blue">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="SAP Training"
              title="Module-wise SAP training"
              description="Functional and technical tracks across the six modules JMK Academy teaches."
            />
          </Reveal>

          <Reveal delay={60}>
            <figure className="sap-banner">
              <Photo
                src={sapBanner.src}
                alt={sapBanner.alt}
                width={sapBanner.width}
                height={sapBanner.height}
                sizes="(max-width: 1023px) 92vw, 1200px"
              />
              <span className="sap-banner__wash" aria-hidden="true" />
              <TechnicalOverlay variant="flow" id="sap" className="sap-banner__drawing" />
              <figcaption className="sap-banner__caption">
                <span className="sap-banner__caption-title">Why SAP?</span>
                <span className="sap-banner__caption-text">
                  SAP runs the core processes — finance, materials, sales, service — of a
                  great many organisations. Module training is how people learn to work
                  inside those processes rather than around them.
                </span>
              </figcaption>
            </figure>
          </Reveal>

          <Reveal delay={90}>
            <h3 className="sap-grid__heading">SAP training areas</h3>
          </Reveal>

          <div className="sap-grid">
            {sapModules.map((module, index) => (
              <Reveal key={module.code} delay={index * 50}>
                <SapModuleTile
                  code={module.code}
                  name={module.name}
                  description={module.description}
                  why={module.why}
                  icon={module.icon}
                />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- Why learn with JMK */}
      <section className="section">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Why learn with JMK"
              title="How the Academy runs its training"
              align="center"
            />
          </Reveal>

          <div className="card-grid">
            {academyPromises.map((promise, index) => (
              <Reveal key={promise.title} delay={index * 60}>
                <article className="promise-card">
                  <span className="promise-card__icon" aria-hidden="true">
                    <Icon name={promise.icon} size={20} />
                  </span>
                  <h3 className="promise-card__title">{promise.title}</h3>
                  <p className="promise-card__text">{promise.text}</p>
                </article>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120}>
            <div className="course-cta">
              <p className="course-cta__text">
                Ask about the current batches, formats and schedules for any of these
                programmes.
              </p>
              <EnquiryTrigger className="btn btn--accent btn--lg" interest="JMK Academy">
                Enquire About Training
              </EnquiryTrigger>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
