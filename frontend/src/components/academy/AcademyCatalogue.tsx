import { PrimaryCourseTile, SapModuleTile } from '@/components/academy/CourseTile';
import { EnquiryTrigger } from '@/components/enquiry/EnquiryTrigger';
import { Icon } from '@/components/ui/Icon';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import {
  academyPromises,
  cadHighlights,
  primaryCadTile,
  primarySapTile,
  sapModules,
} from '@/lib/content/academy';
import { EXTERNAL_LINKS } from '@/lib/site';

/**
 * The Academy catalogue: CAD once, then SAP once.
 *
 * Both disciplines used to be presented twice on this page — a four-tile CAD carousel
 * and a SAP banner here, then "Engineering CAD Training" and "SAP Training" again
 * lower down from the vertical's service groups, listing the same six module codes a
 * second time. Each now appears exactly once: one primary tile, its explanation, and
 * its supporting detail. `VerticalDetail` skips the service groups for this vertical
 * because this component is that content.
 *
 * The CAD DESK link leads the CAD section rather than closing it. Course details,
 * batches and enrolment genuinely live on caddeskindia.com, so a visitor who wants to
 * enrol should meet that link before the explanation, not after scrolling past it.
 *
 * Each section's drawing sits inside the tile's own media box, absolutely positioned
 * over the photograph, so the animation adds no height of its own.
 */
export function AcademyCatalogue() {
  return (
    <>
      {/* ------------------------------------------------------------------ CAD */}
      <section className="section">
        <div className="container">
          {/* Before the explanation, deliberately — see the note above. The tile
              below carries this section's heading; there is no separate one. */}
          <Reveal>
            <div className="partner-link">
              <div className="partner-link__text">
                <p className="partner-link__label">Training partner</p>
                <p className="partner-link__name">CAD DESK Coimbatore</p>
                <p className="partner-link__note">
                  Course details, batches and enrolment are handled on the CAD DESK
                  website.
                </p>
              </div>
              <a
                className="btn btn--primary"
                href={EXTERNAL_LINKS.cadDeskCoimbatore}
                target="_blank"
                rel="noopener noreferrer"
              >
                Visit CAD DESK
                <Icon name="arrowUpRight" size={16} />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
          </Reveal>

          <Reveal delay={70}>
            <PrimaryCourseTile
              tile={primaryCadTile}
              overlay="measure"
              overlayId="cad-tile"
              action={{
                label: 'Explore CAD courses',
                href: EXTERNAL_LINKS.cadDeskCoimbatore,
                external: true,
              }}
              highlights={cadHighlights}
            />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ SAP */}
      <section className="section section--blue">
        <div className="container">
          <Reveal>
            <PrimaryCourseTile
              tile={primarySapTile}
              overlay="flow"
              overlayId="sap-tile"
              why={{ label: 'Why SAP?', text: primarySapTile.why }}
              action={{ label: 'Explore the modules', href: '#sap-modules' }}
            />
          </Reveal>

          <Reveal delay={90}>
            <h3 className="sap-grid__heading" id="sap-modules">
              SAP training areas
            </h3>
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
