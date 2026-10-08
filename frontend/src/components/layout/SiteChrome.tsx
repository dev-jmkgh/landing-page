import type { ReactNode } from 'react';
import { Analytics } from '@/components/analytics/Analytics';
import { EnquiryProvider } from '@/components/enquiry/EnquiryProvider';
import { FloatingEnquiryButton } from '@/components/enquiry/EnquiryTrigger';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { BackToTopButton } from '@/components/ui/BackToTopButton';
import { JsonLd } from '@/components/ui/JsonLd';
import { organizationJsonLd, webSiteJsonLd } from '@/lib/seo';

/**
 * Public site chrome: header, footer, the shared enquiry modal and the persistent
 * floating "Enquire Now" button. Used by the public route group and the 404 page —
 * the admin area deliberately does not use it.
 *
 * The measurement scripts live here too, not in the root layout, so they load on the
 * public site only. Admin screens show customers' names and phone numbers, keep their
 * filters (search text included) in the address, and are noindex — none of that should
 * reach Google Analytics page views or Clarity session recordings.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <Analytics />
      <JsonLd data={[organizationJsonLd(), webSiteJsonLd()]} />
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <EnquiryProvider>
        <div className="page-shell">
          <SiteHeader />
          <main className="page-main" id="main-content">
            {children}
          </main>
          <SiteFooter />
        </div>
        <BackToTopButton />
        <FloatingEnquiryButton />
      </EnquiryProvider>
    </>
  );
}
