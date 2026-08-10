import type { ReactNode } from 'react';

type SectionHeadingProps = {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: 'left' | 'center';
  /** Heading level — keeps the document outline correct on every page. */
  as?: 'h2' | 'h3';
  id?: string;
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'left',
  as: Tag = 'h2',
  id,
}: SectionHeadingProps) {
  return (
    <div className={`section-head${align === 'center' ? ' section-head--center' : ''}`}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <Tag id={id}>{title}</Tag>
      {description ? <p>{description}</p> : null}
    </div>
  );
}
