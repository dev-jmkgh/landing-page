import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Photo } from '@/components/ui/Photo';
import { TechnicalOverlay } from '@/components/visuals/TechnicalOverlay';
import type { CourseTile as CourseTileData } from '@/lib/content/academy';

type Action = { label: string; href: string; external?: boolean };

/**
 * The single primary tile for a discipline: photograph, then category, title,
 * explanation, an optional "why", optional supporting points, and one action.
 *
 * One tile per discipline rather than a carousel of four. The photograph is fixed at
 * 16:9 by the media box and `object-fit: cover`, so CAD and SAP present at identical
 * heights whatever their source proportions — a 1400x933 and an 1800x1200 would
 * otherwise sit at different depths side by side.
 *
 * The drawing is absolutely positioned inside the media box, which is what keeps it
 * from adding any height: it is a film over the photograph, not a block above it.
 */
export function PrimaryCourseTile({
  tile,
  overlay,
  overlayId,
  action,
  why,
  highlights,
}: {
  tile: CourseTileData;
  overlay: 'measure' | 'grid' | 'flow' | 'network';
  overlayId: string;
  action?: Action;
  why?: { label: string; text: string };
  highlights?: { title: string; text: string; icon: IconName }[];
}) {
  return (
    <article className="primary-tile">
      <div className="primary-tile__media">
        <Photo
          src={tile.image.src}
          alt={tile.image.alt}
          width={tile.image.width}
          height={tile.image.height}
          sizes="(max-width: 1023px) 92vw, 560px"
        />
        <span className="primary-tile__wash" aria-hidden="true" />
        <TechnicalOverlay
          variant={overlay}
          id={overlayId}
          className="primary-tile__drawing"
        />
      </div>

      <div className="primary-tile__body">
        {/*
          h2, and there is no separate section heading above it. There used to be one,
          and it repeated this line almost word for word — "Engineering CAD training"
          followed immediately by "Engineering CAD Training" — which is the duplication
          this tile exists to remove. The tile is the section's heading.
        */}
        <p className="primary-tile__category">{tile.category}</p>
        <h2 className="primary-tile__title">{tile.title}</h2>
        <p className="primary-tile__text">{tile.description}</p>

        {why ? (
          <p className="primary-tile__why">
            <span className="primary-tile__why-label">{why.label}</span>
            {why.text}
          </p>
        ) : null}

        {highlights && highlights.length > 0 ? (
          <ul className="primary-tile__points">
            {highlights.map((point) => (
              <li className="primary-tile__point" key={point.title}>
                <span className="primary-tile__point-icon" aria-hidden="true">
                  <Icon name={point.icon} size={16} />
                </span>
                <span>
                  <strong>{point.title}</strong> {point.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {action ? (
          /* Pushed to the bottom by the body's flex column, so the action sits on the
             same line whichever tile has the longer explanation. */
          <div className="primary-tile__footer">
            {action.external ? (
              <a
                className="link-arrow"
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {action.label}
                <Icon name="arrowUpRight" size={16} />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <Link className="link-arrow" href={action.href}>
                {action.label}
                <Icon name="arrowRight" size={16} />
              </Link>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A SAP module tile.
 *
 * The photograph shows the *domain the module works in* — source code for ABAP, a
 * server hall for BASIS, a warehouse aisle for MM — because there is no photograph of
 * SAP itself. Each module gets its own frame and none is reused, so the six read as six
 * subjects rather than one stock library. The alt text describes what the frame shows
 * and never implies it is a JMK site or a JMK class.
 */
export function SapModuleTile({
  code,
  name,
  description,
  why,
  icon,
  image,
}: {
  code: string;
  name: string;
  description: string;
  why: string;
  icon: Parameters<typeof Icon>[0]['name'];
  image: { src: string; alt: string; width: number; height: number };
}) {
  return (
    <article className="sap-tile">
      <div className="sap-tile__media">
        <Photo
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes="(max-width: 639px) 92vw, (max-width: 1023px) 46vw, 30vw"
        />
      </div>

      <div className="sap-tile__head">
        <span className="sap-tile__code">
          <span className="sr-only">SAP module </span>
          {code}
        </span>
        <span className="sap-tile__icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      </div>

      <h3 className="sap-tile__name">{name}</h3>
      <p className="sap-tile__text">{description}</p>

      <p className="sap-tile__why">
        <span className="sap-tile__why-label">Why it matters</span>
        {why}
      </p>
    </article>
  );
}
