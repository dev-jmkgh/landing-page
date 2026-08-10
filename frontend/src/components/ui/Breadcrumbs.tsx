import Link from 'next/link';

export type Crumb = { name: string; path: string };

type BreadcrumbsProps = {
  trail: Crumb[];
  onDark?: boolean;
};

export function Breadcrumbs({ trail, onDark = false }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={`breadcrumbs${onDark ? ' breadcrumbs--on-dark' : ''}`}>
      <ol className="breadcrumbs__list">
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          return (
            <li className="breadcrumbs__item" key={crumb.path}>
              {isLast ? (
                <span aria-current="page">{crumb.name}</span>
              ) : (
                <>
                  <Link href={crumb.path}>{crumb.name}</Link>
                  <span className="breadcrumbs__sep" aria-hidden="true">
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
