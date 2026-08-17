import type { Metadata } from 'next';
import { MapEmbed } from '@/components/contact/MapEmbed';
import { EnquiryForm } from '@/components/forms/EnquiryForm';
import { PageHero } from '@/components/layout/PageHero';
import { Icon, type IconName } from '@/components/ui/Icon';
import { JsonLd } from '@/components/ui/JsonLd';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { pageKeywords } from '@/lib/content/keywords';
import { contactHero } from '@/lib/content/heroImages';
import { breadcrumbJsonLd, buildMetadata, localBusinessJsonLd } from '@/lib/seo';
import { contactDetails, siteConfig, socialLinks } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: 'Contact Us — Coimbatore, Tamil Nadu',
  description:
    'Contact JMK Global Holdings at 22 NSR Road, Saibaba Kovil, Coimbatore 641011. Call +91 88707 73366 or email info@jmkglobalholdings.com.',
  path: '/contact',
  keywords: pageKeywords([
    'contact JMK Global Holdings',
    'JMK Global Holdings address',
    'JMK Global Holdings phone number',
    'NSR Road Saibaba Kovil',
    'business enquiry Coimbatore',
  ]),
});

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Contact Us', path: '/contact' },
];

export default function ContactPage() {
  return (
    <>
      <JsonLd data={[localBusinessJsonLd(), breadcrumbJsonLd(trail)]} />

      <PageHero
        patternId="contact-hero"
        trail={trail}
        eyebrow="Contact Us"
        title="Talk to JMK Global Holdings"
        intro="Reach the group directly by phone or email, or send an enquiry and we will route it to the right business vertical."
        meta={['Coimbatore, Tamil Nadu']}
        image={contactHero}
      />

      <section className="section">
        <div className="container">
          <div className="contact-grid">
            <Reveal>
              <SectionHeading eyebrow="Reach Us" title="Contact details" />

              <div className="contact-block">
                <div className="contact-item">
                  <span className="contact-item__icon" aria-hidden="true">
                    <Icon name="pin" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Address</p>
                    <address className="contact-item__value" style={{ fontStyle: 'normal' }}>
                      {contactDetails.address.lines.map((line) => (
                        <span key={line} style={{ display: 'block' }}>
                          {line},
                        </span>
                      ))}
                      <span style={{ display: 'block' }}>
                        {contactDetails.address.region} {contactDetails.address.postalCode},{' '}
                        {contactDetails.address.country}
                      </span>
                    </address>
                  </div>
                </div>

                <div className="contact-item">
                  <span className="contact-item__icon" aria-hidden="true">
                    <Icon name="phone" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Phone</p>
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
                    <Icon name="mail" size={20} />
                  </span>
                  <div>
                    <p className="contact-item__label">Email</p>
                    <p className="contact-item__value">
                      <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a>
                    </p>
                  </div>
                </div>

                {socialLinks.length > 0 ? (
                  <div className="contact-item">
                    <span className="contact-item__icon" aria-hidden="true">
                      <Icon name="globe" size={20} />
                    </span>
                    <div>
                      <p className="contact-item__label">Social Media</p>
                      <ul className="social-links" style={{ marginTop: '0.5rem' }}>
                        {socialLinks.map((link) => (
                          <li key={link.id}>
                            <a
                              className="social-links__item"
                              style={{ borderColor: 'var(--line-200)', color: 'var(--navy-800)' }}
                              href={link.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`${siteConfig.name} on ${link.label}`}
                            >
                              <Icon name={link.id as IconName} size={18} />
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="form-panel">
                <h2 style={{ fontSize: 'var(--text-2xl)' }}>Send an enquiry</h2>
                <p style={{ color: 'var(--ink-500)', margin: '0.5rem 0 1.75rem' }}>
                  Fields marked with an asterisk are required.
                </p>
                <EnquiryForm source="contact-page" submitLabel="Send Enquiry" />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section section--muted section--tight">
        <div className="container">
          <Reveal>
            <SectionHeading eyebrow="Find Us" title="Our Coimbatore office" />
          </Reveal>
          <Reveal delay={60}>
            <MapEmbed />
          </Reveal>
        </div>
      </section>
    </>
  );
}
