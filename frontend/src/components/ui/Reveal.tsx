'use client';

import type { ElementType, ReactNode } from 'react';
import { useInView } from '@/hooks/useInView';

type RevealProps = {
  children: ReactNode;
  /** Rendered element. Defaults to a plain div. */
  as?: ElementType;
  className?: string;
  /** Stagger in milliseconds. Keep small — the motion should read as fast and subtle. */
  delay?: number;
  id?: string;
};

/**
 * Fades content up once as it enters the viewport. All motion is disabled by
 * `prefers-reduced-motion` in CSS, and content stays visible without JavaScript.
 */
export function Reveal({ children, as: Tag = 'div', className, delay = 0, id }: RevealProps) {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <Tag
      ref={ref}
      id={id}
      className={['reveal', inView ? 'is-visible' : '', className].filter(Boolean).join(' ')}
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
