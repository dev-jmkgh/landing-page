import Link from 'next/link';
import { SiteChrome } from '@/components/layout/SiteChrome';
import { Icon } from '@/components/ui/Icon';
import { mainNavigation } from '@/lib/site';

export const metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <SiteChrome>
      <section className="section">
        <div className="container">
          <div className="not-found">
            <p className="not-found__code" aria-hidden="true">
              404
            </p>
            <h1>This page could not be found</h1>
            <p style={{ color: 'var(--ink-500)', maxWidth: '48ch', marginTop: '1rem' }}>
              The page you were looking for may have moved. Use the links below to get back to
              the right place.
            </p>

            <div className="hero__actions" style={{ justifyContent: 'center' }}>
              <Link className="btn btn--primary btn--lg" href="/">
                Back to Home
                <Icon name="arrowRight" size={16} />
              </Link>
              <Link className="btn btn--outline btn--lg" href="/contact">
                Contact Us
              </Link>
            </div>

            <ul
              className="hero__sectors"
              style={{ justifyContent: 'center', marginTop: '2.5rem' }}
              aria-label="Main pages"
            >
              {mainNavigation.map((item) => (
                <li key={item.href}>
                  <Link className="pill" href={item.href} style={{ display: 'inline-flex' }}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </SiteChrome>
  );
}
