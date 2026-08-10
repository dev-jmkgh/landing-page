type PatternBackdropProps = {
  className?: string;
  /** Unique id per instance — SVG pattern ids must not collide on a page. */
  id: string;
  variant?: 'grid' | 'blueprint';
};

/**
 * Decorative background lattice used behind dark hero sections. Purely presentational,
 * so it is hidden from assistive technology.
 */
export function PatternBackdrop({ className, id, variant = 'grid' }: PatternBackdropProps) {
  const gridId = `${id}-grid`;
  const fadeId = `${id}-fade`;

  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1200 600"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id={gridId} width="48" height="48" patternUnits="userSpaceOnUse">
          <path
            d="M48 0H0v48"
            fill="none"
            stroke="rgba(255,255,255,0.09)"
            strokeWidth="1"
          />
        </pattern>
        <linearGradient id={fadeId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="70%" stopColor="#fff" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect width="1200" height="600" fill={`url(#${fadeId})`} />
        </mask>
      </defs>

      <rect width="1200" height="600" fill={`url(#${gridId})`} mask={`url(#${id}-mask)`} />

      {variant === 'blueprint' ? (
        <g
          fill="none"
          stroke="rgba(192,139,46,0.35)"
          strokeWidth="1"
          mask={`url(#${id}-mask)`}
        >
          <circle cx="980" cy="140" r="120" />
          <circle cx="980" cy="140" r="76" />
          <path d="M860 140h240M980 20v240" />
          <path d="M120 480h280l90-90" />
        </g>
      ) : null}
    </svg>
  );
}
