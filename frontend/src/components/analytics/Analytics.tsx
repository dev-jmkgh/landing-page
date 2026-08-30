import Script from 'next/script';
import {
  CLARITY_PROJECT_ID,
  GA_MEASUREMENT_ID,
  analyticsEnabled,
  clarityEnabled,
} from '@/lib/analytics';

/**
 * Third-party measurement scripts.
 *
 * Renders nothing at all unless the corresponding id is configured, so a build without
 * them ships no third-party script and sets no cookie — which is what keeps the privacy
 * policy's Cookies section true in both states.
 *
 * `afterInteractive` rather than `beforeInteractive`: measurement is not needed to
 * render the page, and loading it earlier would put a blocking third-party request in
 * front of the largest contentful paint on a site whose hero is a photograph.
 *
 * IP anonymisation is on. GA4 truncates IPs by default, but stating it explicitly means
 * the behaviour is visible here rather than assumed from a vendor default that could
 * change.
 */
export function Analytics() {
  if (!analyticsEnabled && !clarityEnabled) return null;

  return (
    <>
      {analyticsEnabled ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_MEASUREMENT_ID}', { anonymize_ip: true });
            `}
          </Script>
        </>
      ) : null}

      {clarityEnabled ? (
        <Script id="clarity-init" strategy="afterInteractive">
          {`
            (function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");
          `}
        </Script>
      ) : null}
    </>
  );
}
