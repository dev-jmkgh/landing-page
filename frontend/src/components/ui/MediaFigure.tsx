import Image from 'next/image';

type MediaFigureProps = {
  /** Public path such as `/images/gallery/academy-01.jpg`. Null renders the placeholder. */
  src?: string | null;
  /** Required whenever `src` is provided. */
  alt?: string | null;
  /** Deterministic seed so a given slot always draws the same placeholder. */
  seed: string;
  /** CSS aspect-ratio value, e.g. "4 / 3". */
  ratio?: string;
  /** Small overlay label, used on the gallery grid. */
  badge?: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

const PALETTES = [
  { bg: '#f4f7fb', line: '#c9d6e5', accent: '#c08b2e', solid: '#0f2742' },
  { bg: '#eef2f6', line: '#c2cfdd', accent: '#d9a54a', solid: '#163458' },
  { bg: '#f7f9fb', line: '#cdd9e6', accent: '#c08b2e', solid: '#0a1b2e' },
];

/** Stable 32-bit hash so the same seed always yields the same composition. */
function hash(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

/**
 * A branded geometric placeholder. It never imitates a photograph — no fabricated
 * offices, staff, projects or clients — and is replaced the moment a real asset is
 * dropped into `public/images/` and referenced by `src`.
 */
function Placeholder({ seed }: { seed: string }) {
  const seedValue = hash(seed);
  const palette = PALETTES[seedValue % PALETTES.length]!;
  const variant = seedValue % 4;

  return (
    <svg
      className="figure__placeholder"
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="400" height="300" fill={palette.bg} />
      <g stroke={palette.line} strokeWidth="1" fill="none">
        {Array.from({ length: 9 }, (_, index) => (
          <path key={`h${index}`} d={`M0 ${index * 36 + 18}H400`} />
        ))}
        {Array.from({ length: 12 }, (_, index) => (
          <path key={`v${index}`} d={`M${index * 36 + 14} 0V300`} />
        ))}
      </g>

      {variant === 0 ? (
        <g fill="none" strokeWidth="2">
          <circle cx="200" cy="150" r="86" stroke={palette.solid} opacity="0.85" />
          <circle cx="200" cy="150" r="52" stroke={palette.accent} />
          <path d="M114 150h172M200 64v172" stroke={palette.solid} opacity="0.35" />
        </g>
      ) : null}

      {variant === 1 ? (
        <g strokeWidth="2" fill="none">
          <rect x="96" y="86" width="126" height="126" stroke={palette.solid} opacity="0.85" />
          <rect x="150" y="128" width="126" height="126" stroke={palette.accent} />
        </g>
      ) : null}

      {variant === 2 ? (
        <g strokeWidth="2" fill="none">
          <path d="M80 216 152 96l72 120z" stroke={palette.solid} opacity="0.85" />
          <path d="M176 216 248 96l72 120z" stroke={palette.accent} />
          <path d="M56 240h288" stroke={palette.solid} opacity="0.35" />
        </g>
      ) : null}

      {variant === 3 ? (
        <g strokeWidth="2" fill="none">
          <path d="M72 200c40-84 96-84 136 0s96 84 120 0" stroke={palette.accent} />
          <path d="M72 236c40-84 96-84 136 0s96 84 120 0" stroke={palette.solid} opacity="0.5" />
          <circle cx="300" cy="88" r="30" stroke={palette.solid} opacity="0.85" />
        </g>
      ) : null}
    </svg>
  );
}

export function MediaFigure({
  src,
  alt,
  seed,
  ratio = '4 / 3',
  badge,
  className,
  sizes = '(max-width: 768px) 100vw, 33vw',
  priority = false,
}: MediaFigureProps) {
  const hasImage = Boolean(src && alt);

  return (
    <div
      className={['figure', className].filter(Boolean).join(' ')}
      style={{ aspectRatio: ratio, position: 'relative' }}
    >
      {hasImage ? (
        <Image
          className="figure__img"
          src={src as string}
          alt={alt as string}
          fill
          sizes={sizes}
          priority={priority}
          loading={priority ? undefined : 'lazy'}
        />
      ) : (
        <Placeholder seed={seed} />
      )}
      {badge ? <span className="figure__badge">{badge}</span> : null}
    </div>
  );
}
