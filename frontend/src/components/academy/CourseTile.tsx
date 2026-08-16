import { Icon } from '@/components/ui/Icon';
import { Photo } from '@/components/ui/Photo';
import type { CourseTile as CourseTileData } from '@/lib/content/academy';

/**
 * An image-led course tile.
 *
 * Image, then a small category label, then title, then supporting text — the same
 * order on every tile, so a row reads as a set rather than as four separate designs.
 * The image sits at a fixed 16:9 regardless of the source proportions, which is what
 * keeps the row's heights even.
 *
 * The whole tile is not a link: these describe what the Academy teaches rather than
 * pointing at a page per course, and a card that looks clickable but is not is worse
 * than one that plainly is not.
 */
export function CourseTile({ tile }: { tile: CourseTileData }) {
  return (
    <article className="course-tile">
      <div className="course-tile__media">
        <Photo
          src={tile.image.src}
          alt={tile.image.alt}
          width={tile.image.width}
          height={tile.image.height}
          sizes="(max-width: 639px) 92vw, (max-width: 1023px) 46vw, 30vw"
        />
        <span className="course-tile__wash" aria-hidden="true" />
      </div>

      <div className="course-tile__body">
        <p className="course-tile__category">{tile.category}</p>
        <h3 className="course-tile__title">{tile.title}</h3>
        <p className="course-tile__text">{tile.description}</p>
      </div>
    </article>
  );
}

/**
 * A SAP module: no photograph, by design.
 *
 * There is one honest photograph of enterprise-software training available, and using
 * it six times — or padding with unrelated stock — would be exactly the filler imagery
 * the brief rules out. The modules carry the drawing language instead: a code plate, a
 * technical rule, and the module's own icon.
 */
export function SapModuleTile({
  code,
  name,
  description,
  why,
  icon,
}: {
  code: string;
  name: string;
  description: string;
  why: string;
  icon: Parameters<typeof Icon>[0]['name'];
}) {
  return (
    <article className="sap-tile">
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
