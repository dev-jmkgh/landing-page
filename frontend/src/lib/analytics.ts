/**
 * Analytics configuration and event reporting.
 *
 * Nothing here loads or records anything unless the corresponding environment variable
 * is set. That is deliberate: a static export is served from a public bucket and a
 * developer's machine alike, and neither should start reporting to a production
 * property because a script tag was compiled in unconditionally.
 *
 * It also matters for the privacy policy, which states in plain terms whether the
 * public pages set analytics cookies. That page reads these same flags, so it cannot
 * drift out of step with what the site actually does — see the Cookies section of
 * `app/(site)/privacy-policy/page.tsx`.
 */

/** GA4 measurement id, e.g. G-XXXXXXXXXX. Empty disables Google Analytics entirely. */
export const GA_MEASUREMENT_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? '').trim();

/** Microsoft Clarity project id. Empty disables Clarity entirely. */
export const CLARITY_PROJECT_ID = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID ?? '').trim();

export const analyticsEnabled = GA_MEASUREMENT_ID.length > 0;
export const clarityEnabled = CLARITY_PROJECT_ID.length > 0;

/** True when anything at all is loaded that stores something in the visitor's browser. */
export const anyTrackingEnabled = analyticsEnabled || clarityEnabled;

type GtagWindow = Window & {
  gtag?: (command: string, eventName: string, params?: Record<string, unknown>) => void;
};

/**
 * Records a conversion.
 *
 * Silent and safe when analytics is off, when the script has not loaded yet, or when a
 * blocker removed it — an unreported event must never interrupt a form submission that
 * has already succeeded, so this never throws and never returns a failure the caller
 * has to handle.
 */
export function trackEvent(name: string, params: Record<string, unknown> = {}): void {
  if (!analyticsEnabled || typeof window === 'undefined') return;
  try {
    (window as GtagWindow).gtag?.('event', name, params);
  } catch {
    // Reporting is best-effort by design.
  }
}

/**
 * The two conversions this site has.
 *
 * `generate_lead` is a GA4 recommended event name, so it maps onto the built-in lead
 * reports without configuration. The careers submission has no standard equivalent and
 * uses a plain descriptive name.
 */
export const CONVERSIONS = {
  enquiry: 'generate_lead',
  application: 'submit_application',
} as const;
