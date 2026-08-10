import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero } from '@/components/layout/PageHero';
import { buildMetadata } from '@/lib/seo';
import { contactDetails, formattedAddress, siteConfig } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: 'Terms & Conditions',
  description:
    'The terms that govern use of the JMK Global Holdings website, including acceptable use, intellectual property, form submissions and limitation of liability.',
  path: '/terms',
});

/** Update whenever the terms change. */
const LAST_UPDATED = '10 August 2026';

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Terms & Conditions', path: '/terms' },
];

export default function TermsPage() {
  return (
    <>
      <PageHero
        patternId="terms-hero"
        trail={trail}
        eyebrow="Legal"
        title="Terms & Conditions"
        intro={`The terms on which ${siteConfig.name} provides this website. Last updated ${LAST_UPDATED}.`}
      />

      <section className="section">
        <div className="container">
          <div className="legal-content">
            <h2>1. Acceptance</h2>
            <p>
              By accessing www.jmkglobalholdings.com you agree to these terms. If you do not
              agree with them, please do not use the website.
            </p>

            <h2>2. About this website</h2>
            <p>
              This website provides information about {siteConfig.name} and its business
              verticals. It is intended as general information about our activities and does not
              constitute a binding offer, quotation or professional advice. Specific engagements
              are governed by a separate written agreement between you and the relevant JMK
              business.
            </p>

            <h2>3. Accuracy of information</h2>
            <p>
              We take care to keep the content of this website accurate and current. Service
              descriptions, training programmes and business activities may change without
              notice. Where a page links to an external website — for example the CAD DESK
              Coimbatore site — that site&apos;s content is maintained by its own operator.
            </p>

            <h2>4. Acceptable use</h2>
            <ul>
              <li>Do not use this website for any unlawful purpose.</li>
              <li>
                Do not attempt to gain unauthorised access to the website, its servers, its
                database or the administration area.
              </li>
              <li>
                Do not submit automated, bulk, spam or fraudulent enquiries, or upload files
                containing malicious code.
              </li>
              <li>Do not copy, scrape or republish site content for commercial use without permission.</li>
            </ul>

            <h2>5. Form submissions</h2>
            <p>
              When you submit an enquiry or a career application you confirm that the
              information provided is accurate and that you are entitled to share it. Submitting
              a form does not create a contractual relationship, a guarantee of a response within
              a fixed time, or an offer of employment. Uploaded resumes must be your own.
            </p>

            <h2>6. Intellectual property</h2>
            <p>
              The JMK Global Holdings name, the names of its business verticals, and the text,
              layout, graphics and code of this website are owned by {siteConfig.name} or its
              licensors, except where a third-party trademark is referenced. Trademarks belonging
              to other organisations named on this website remain the property of their
              respective owners.
            </p>

            <h2>7. Limitation of liability</h2>
            <p>
              This website is provided on an &quot;as is&quot; basis. To the extent permitted by
              applicable law, {siteConfig.name} is not liable for any indirect or consequential
              loss arising from the use of, or inability to use, this website. Nothing in these
              terms excludes liability that cannot be excluded under Indian law.
            </p>

            <h2>8. Privacy</h2>
            <p>
              Our handling of personal information is described in the{' '}
              <Link href="/privacy-policy">Privacy Policy</Link>, which forms part of these
              terms.
            </p>

            <h2>9. Governing law</h2>
            <p>
              These terms are governed by the laws of India, and the courts at Coimbatore, Tamil
              Nadu have jurisdiction over any dispute arising from them.
            </p>

            <h2>10. Contact</h2>
            <p>
              {siteConfig.name}
              <br />
              {formattedAddress}
              <br />
              Email: <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a>
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
