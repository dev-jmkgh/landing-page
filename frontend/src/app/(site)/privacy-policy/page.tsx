import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero } from '@/components/layout/PageHero';
import { buildMetadata } from '@/lib/seo';
import { contactDetails, formattedAddress, siteConfig } from '@/lib/site';

export const metadata: Metadata = buildMetadata({
  title: 'Privacy Policy',
  description:
    'How JMK Global Holdings collects, uses, stores and protects the personal information submitted through jmkglobalholdings.com.',
  path: '/privacy-policy',
});

/** Update whenever the policy text changes. */
const LAST_UPDATED = '10 August 2026';

const trail = [
  { name: 'Home', path: '/' },
  { name: 'Privacy Policy', path: '/privacy-policy' },
];

export default function PrivacyPolicyPage() {
  return (
    <>
      <PageHero
        patternId="privacy-hero"
        trail={trail}
        eyebrow="Legal"
        title="Privacy Policy"
        intro={`How we handle information you share with ${siteConfig.name} through this website. Last updated ${LAST_UPDATED}.`}
      />

      <section className="section">
        <div className="container">
          <div className="legal-content">
            <h2>1. Scope</h2>
            <p>
              This policy explains what personal information {siteConfig.name} collects through
              this website, why we collect it, and how it is stored and shared. It covers the
              website at www.jmkglobalholdings.com and the enquiry, contact and career
              application forms it provides.
            </p>

            <h2>2. Information we collect</h2>
            <p>We collect only the information you choose to submit through our forms:</p>
            <ul>
              <li>
                <strong>Enquiry and contact forms:</strong> your name, email address, phone
                number, company or organisation (optional), the business or service you are
                interested in, and your message.
              </li>
              <li>
                <strong>Career applications:</strong> your full name, email address, phone
                number, the position you are applying for, an optional message, and the resume
                file you upload.
              </li>
              <li>
                <strong>Technical information:</strong> our servers record the IP address and
                timestamp of form submissions. This is used for security, spam prevention and
                rate limiting.
              </li>
            </ul>
            <p>
              We do not use advertising trackers on this website, and we do not sell personal
              information.
            </p>

            <h2>3. How we use your information</h2>
            <ul>
              <li>To respond to your enquiry and provide the information or service you asked for.</li>
              <li>To assess career applications and contact shortlisted candidates.</li>
              <li>To keep a record of communication with customers, partners and applicants.</li>
              <li>To protect the website against spam, abuse and automated submissions.</li>
            </ul>

            <h2>4. Storage and retention</h2>
            <p>
              Form submissions are stored in our own database, and uploaded resumes are stored
              outside the public web root so they cannot be downloaded directly from the
              internet. Access is restricted to authorised {siteConfig.name} personnel through
              an authenticated administration area. Records are retained only as long as they
              are needed for the purpose above, or as required by applicable law.
            </p>

            <h2>5. Sharing</h2>
            <p>
              Enquiries are shared internally with the JMK Global Holdings team responsible for
              the business vertical you contacted. Notification emails are delivered through our
              email service provider. We do not share your information with third parties for
              marketing purposes.
            </p>

            <h2>6. Cookies</h2>
            <p>
              The public pages of this website do not set marketing or analytics cookies. A
              session cookie is used only in the restricted administration area to keep
              authorised staff signed in.
            </p>

            <h2>7. Security</h2>
            <p>
              We use HTTPS, server-side validation, rate limiting, parameterised database
              queries and restricted file storage to protect your information. No method of
              transmission or storage is completely secure, but we take reasonable technical and
              organisational measures to protect the data we hold.
            </p>

            <h2>8. Your choices</h2>
            <p>
              You can ask us to confirm what information we hold about you, correct it, or delete
              it. Write to{' '}
              <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a> and we will
              respond to your request.
            </p>

            <h2>9. Third-party links</h2>
            <p>
              This website links to external sites, including the CAD DESK Coimbatore website and
              our social media profiles. Those sites operate under their own privacy policies,
              which we do not control.
            </p>

            <h2>10. Changes to this policy</h2>
            <p>
              We may update this policy as our services or legal obligations change. The date at
              the top of this page shows when it was last revised.
            </p>

            <h2>11. Contact</h2>
            <p>
              {siteConfig.name}
              <br />
              {formattedAddress}
              <br />
              Email: <a href={`mailto:${contactDetails.email}`}>{contactDetails.email}</a>
              <br />
              Phone: {contactDetails.phones.map((phone) => phone.label).join(' · ')}
            </p>

            <p>
              See also our <Link href="/terms">Terms &amp; Conditions</Link>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
