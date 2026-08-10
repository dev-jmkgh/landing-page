import type { Metadata } from 'next';
import { ApplicationForm } from '@/components/forms/ApplicationForm';
import { PageHero } from '@/components/layout/PageHero';
import { Icon } from '@/components/ui/Icon';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { benefits, careersIntro, openPositions, roleGroups } from '@/lib/content/careers';
import { breadcrumbJsonLd, buildMetadata } from '@/lib/seo';
import { contactDetails } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: 'Careers — Join Our Team',
  description:
    'Current openings at JMK Global Holdings, Coimbatore: CAD and SAP trainers, developers, designers, engineers, sales, marketing, export and HR roles.',
  path: '/careers',
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Careers', path: '/careers' },
];

export default function CareersPage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(trail)} />

      <PageHero
        patternId="careers-hero"
        trail={trail}
        eyebrow="Careers"
        title={careersIntro.heading}
        intro={careersIntro.intro}
        meta={[`${openPositions.length} open role types`, 'Coimbatore, Tamil Nadu']}
      />

      {/* ------------------------------------------------------ Open positions */}
      <section className="section">
        <div className="container">
          <Reveal>
            <SectionHeading
              eyebrow="Current Opportunities"
              title="Roles we are hiring for"
              description="Grouped by discipline. Apply through the form below and mention the role you are interested in."
            />
          </Reveal>

          <div className="grid grid--3">
            {roleGroups.map((group, index) => (
              <Reveal key={group.id} delay={index * 60}>
                <article className="role-group">
                  <div className="role-group__head">
                    <span className="role-group__icon" aria-hidden="true">
                      <Icon name={group.icon} size={20} />
                    </span>
                    <h3 className="role-group__title">{group.title}</h3>
                  </div>
                  <ul className="role-list">
                    {group.roles.map((role) => (
                      <li className="role-list__item" key={role}>
                        <span>{role}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Benefits */}
      <section className="section section--dark">
        <div className="container">
          <Reveal>
            <SectionHeading eyebrow="Benefits" title="What we offer our people" align="center" />
          </Reveal>
          <Reveal delay={60}>
            <ul className="benefit-strip">
              {benefits.map((benefit) => (
                <li className="benefit" key={benefit.name}>
                  <Icon name={benefit.icon} size={20} />
                  {benefit.name}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* --------------------------------------------------------- Application */}
      <section className="section" id="apply">
        <div className="container">
          <div className="contact-grid">
            <Reveal>
              <SectionHeading
                eyebrow="Apply"
                title="Send us your application"
                description="Complete the form and attach your resume. Our HR team reviews every application and will contact you if there is a suitable match."
              />

              <div className="contact-block">
                <div className="contact-item">
                  <span className="contact-item__icon" aria-hidden="true">
                    <Icon name="mail" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Prefer email?</p>
                    <p className="contact-item__value">
                      <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a>
                    </p>
                  </div>
                </div>
                <div className="contact-item">
                  <span className="contact-item__icon" aria-hidden="true">
                    <Icon name="phone" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Talk to us</p>
                    <p className="contact-item__value">
                      {contactDetails.phones.map((phone) => (
                        <a key={phone.href} href={phone.href} style={{ display: 'block' }}>
                          {phone.label}
                        </a>
                      ))}
                    </p>
                  </div>
                </div>
                <div className="contact-item">
                  <span className="contact-item__icon" aria-hidden="true">
                    <Icon name="pin" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Office</p>
                    <p className="contact-item__value">
                      {contactDetails.address.lines.join(', ')},<br />
                      {contactDetails.address.region} {contactDetails.address.postalCode},{' '}
                      {contactDetails.address.country}
                    </p>
                  </div>
                </div>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="form-panel">
                <h3 style={{ marginBottom: '1.5rem' }}>Application form</h3>
                <ApplicationForm />
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </>
  );
}
