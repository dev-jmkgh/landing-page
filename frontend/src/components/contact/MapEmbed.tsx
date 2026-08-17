import { Icon } from '@/components/ui/Icon';
import { formattedAddress, mapsDirectionsUrl, mapsEmbedUrl, siteConfig } from '@/lib/site';

/**
 * Google Maps embed. Until `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_URL` is configured, an
 * accessible placeholder with a "Get directions" link is shown — no third-party
 * script is loaded and no fabricated coordinates are used.
 */
export function MapEmbed() {
  return (
    /*
      The modifier matters for spacing. A real map wants a 16:9 frame, but the
      placeholder is a pin, an address and a button — perhaps 200px of content. Sharing
      the 16:9 rule gave it a 675px box at desktop width, most of it empty, and that
      single element was the largest blank area anywhere on the site.
    */
    <div className={mapsEmbedUrl ? 'map-frame' : 'map-frame map-frame--placeholder'}>
      {mapsEmbedUrl ? (
        <iframe
          src={mapsEmbedUrl}
          title={`Map showing the ${siteConfig.name} office in Coimbatore`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      ) : (
        <div className="map-placeholder">
          <span className="contact-item__icon" aria-hidden="true">
            <Icon name="pin" size={22} />
          </span>
          <p style={{ fontWeight: 600, color: 'var(--navy-900)' }}>{siteConfig.name}</p>
          <p style={{ color: 'var(--ink-500)', fontSize: '0.94rem', maxWidth: '32ch' }}>
            {formattedAddress}
          </p>
          <a
            className="btn btn--outline btn--sm"
            href={mapsDirectionsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get directions
            <Icon name="external" size={15} />
          </a>
        </div>
      )}
    </div>
  );
}
