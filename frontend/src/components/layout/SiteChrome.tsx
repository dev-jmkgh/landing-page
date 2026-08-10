import type { ReactNode } from 'react';
import { EnquiryProvider } from '@/components/enquiry/EnquiryProvider';
import { FloatingEnquiryButton } from '@/components/enquiry/EnquiryTrigger';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { JsonLd } from '@/components/ui/JsonLd';
import { organizationJsonLd, webSiteJsonLd } from '@/lib/seo';

/**
 * Public site chrome: header, footer, the shared enquiry modal and the persistent
 * floating "Enquire Now" button. Used by the public route group and the 404 page —
 * the admin area deliberately does not use it.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
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
        <FloatingEnquiryButton />
      </EnquiryProvider>
    </>
  );
}
