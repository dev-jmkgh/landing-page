import Link from 'next/link';
import { Brand } from '@/components/layout/SiteHeader';
import { Icon, type IconName } from '@/components/ui/Icon';
import { verticals } from '@/lib/content/business';
import {
  contactDetails,
  legalNavigation,
  mainNavigation,
  siteConfig,
  socialLinks,
} from '@/lib/site';

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-about">
            <Brand variant="footer" />
            <p>
              A diversified business group headquartered in Coimbatore, Tamil Nadu, operating
              across education, engineering design, software development, exports, agriculture,
              renewable energy and real estate.
            </p>
            {socialLinks.length > 0 ? (
              <ul className="social-links">
                {socialLinks.map((link) => (
                  <li key={link.id}>
                    <a
                      className="social-links__item"
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
            ) : null}
          </div>

          <div>
            <h2 className="footer-heading">Quick Links</h2>
            <ul className="footer-list">
              {mainNavigation.map((item) => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Business</h2>
            <ul className="footer-list">
              {verticals.map((vertical) => (
                <li key={vertical.slug}>
                  <Link href={`/business/${vertical.slug}`}>{vertical.name}</Link>
                </li>
              ))}
              <li>
                <Link href="/business#sectors">Group Sectors</Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="footer-heading">Contact</h2>
            <address className="footer-contact" style={{ fontStyle: 'normal' }}>
              <div className="footer-contact__row">
                <Icon name="pin" size={18} />
                <span>
                  {contactDetails.address.lines.join(', ')},
                  <br />
                  {contactDetails.address.region} {contactDetails.address.postalCode},{' '}
                  {contactDetails.address.country}
                </span>
              </div>
              <div className="footer-contact__row">
                <Icon name="phone" size={18} />
                <span>
                  {contactDetails.phones.map((phone) => (
                    <a key={phone.href} href={phone.href} style={{ display: 'block' }}>
                      {phone.label}
                    </a>
                  ))}
                </span>
              </div>
              <div className="footer-contact__row">
                <Icon name="mail" size={18} />
                <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a>
              </div>
            </address>
          </div>
        </div>

        <div className="footer-bottom">
          <p>
            © {year} {siteConfig.name}. All rights reserved.
          </p>
          <ul className="footer-bottom__links">
            {legalNavigation.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
            <li>
              <Link href="/contact">Contact Us</Link>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
