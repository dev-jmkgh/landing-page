/**
 * Loads the Google Maps JavaScript API, once.
 *
 * WHY A LOADER RATHER THAN A `<script>` IN THE LAYOUT
 *
 * The admin is a static export and the map is used on exactly one panel, behind a tab
 * most administrators never open. A script tag in the document head would pull ~200KB
 * of Google JavaScript into every admin page load — including the sign-in screen — for
 * a feature almost nobody on that page is about to use.
 *
 * This loads it on demand and caches the promise, so several components mounting at
 * once share a single fetch and a second visit to the tab is instant.
 *
 * THE KEY IS PUBLIC. It is embedded in a page served to the browser; there is no way
 * to hide it and no point trying. What makes that safe is RESTRICTING it in the Google
 * Cloud console — by HTTP referrer to the admin's own domain, and to the Maps
 * JavaScript API alone. An unrestricted key lifted from the page can be used by anyone
 * and billed to the account.
 */

const SRC = 'https://maps.googleapis.com/maps/api/js';

/** Cached so concurrent callers share one load and later ones resolve immediately. */
let loading: Promise<boolean> | null = null;

export function mapsApiKey(): string {
  return (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '').trim();
}

/** True when a key is configured. Callers fall back to manual entry when it is not. */
export function mapsAvailable(): boolean {
  return mapsApiKey().length > 0;
}

/**
 * Resolves true once the API is usable, false when it cannot be loaded.
 *
 * Never rejects. A map that fails to load must degrade to the coordinate fields, not
 * take the panel down with it — HR still has to be able to add a site when Google is
 * blocked by a corporate proxy.
 */
export function loadGoogleMaps(): Promise<boolean> {
  if (loading) return loading;

  const key = mapsApiKey();
  if (!key) return Promise.resolve(false);

  loading = new Promise<boolean>((resolve) => {
    // Already present, e.g. after a hot reload.
    if (typeof window !== 'undefined' && (window as { google?: unknown }).google) {
      resolve(true);
      return;
    }

    const script = document.createElement('script');
    // `loading=async` is what Google's own console asks for; without it the API logs a
    // performance warning on every load.
    script.src = `${SRC}?key=${encodeURIComponent(key)}&loading=async&libraries=marker`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      // Allow a later retry rather than caching the failure forever: a transient
      // network error on first open should not disable the map for the session.
      loading = null;
      resolve(false);
    };

    document.head.appendChild(script);
  });

  return loading;
}
