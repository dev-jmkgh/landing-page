import { verticals } from '@/lib/content/business';
import { groupSectors } from '@/lib/content/business';
import { Icon } from '@/components/ui/Icon';

/**
 * Structural summary of the group, used as the hero visual. It shows real structure
 * from the content document rather than standing in for a photograph we do not have.
 */
export function GroupDiagram() {
  return (
    <div className="group-diagram">
      <div className="group-diagram__root">
        <span className="group-diagram__root-label">Parent Group</span>
        <span className="group-diagram__root-name">JMK Global Holdings</span>
        <span className="group-diagram__root-meta">Coimbatore, Tamil Nadu · Since 2023</span>
      </div>

      <ul className="group-diagram__branches">
        {verticals.map((vertical) => (
          <li className="group-diagram__branch" key={vertical.slug}>
            <span className="group-diagram__mark" aria-hidden="true">
              {vertical.mark}
            </span>
            <span>
              <span className="group-diagram__branch-name">{vertical.name}</span>
              <span className="group-diagram__branch-tagline">{vertical.tagline}</span>
            </span>
          </li>
        ))}
      </ul>

      <ul className="group-diagram__sectors">
        {groupSectors.map((sector) => (
          <li key={sector.id}>
            <Icon name={sector.icon} size={15} />
            {sector.name.replace(' & Integrated Farming', '')}
          </li>
        ))}
      </ul>
    </div>
  );
}
