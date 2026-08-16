import type { CSSProperties } from 'react';

/**
 * The drawing signature, laid over a photograph.
 *
 * This is the third and lightest member of the visual family. `TechnicalVisual` draws a
 * full diagram that *is* the picture; this one is a drafting film placed on top of a
 * photograph that is already the picture — corner registration marks, a construction
 * line or two, a dimension, and a rule that sweeps once. It has to stay quiet: the
 * brief is that the photograph remains clearly visible.
 *
 * Each variant says something about its own page rather than repeating one animation
 * everywhere:
 *
 *   measure  — a dimension line extending between witness marks (CAD, Design Studio)
 *   grid     — a construction grid resolving into a framed area (Academy, general)
 *   flow     — a process chain advancing through stages (SAP, training pathways)
 *   network  — nodes linking into an architecture (Software Solutions)
 *
 * Decorative by definition, so it is hidden from assistive technology; the surrounding
 * heading and the photograph's own alt text carry the meaning. Under
 * `prefers-reduced-motion` the finished state is shown with no movement.
 */

export type OverlayVariant = 'measure' | 'grid' | 'flow' | 'network';

type Props = {
  variant?: OverlayVariant;
  className?: string;
  /** Distinguishes the SVG ids when more than one overlay is on a page. */
  id?: string;
};

/**
 * Construction lines are light blue; gold is kept for measurements only.
 *
 * When every line was gold the drawing read as decoration laid on the photograph.
 * Blue lines look like draughting on it, and the few gold marks that remain — the
 * dimension, the registration corners — are then genuinely the thing you notice.
 */
const STROKE = 'rgba(56, 93, 122, 0.55)';
const ACCENT = 'rgba(160, 114, 32, 0.85)';
const FRAME = 'rgba(56, 93, 122, 0.4)';

function delay(ms: number): CSSProperties {
  return { '--tv-delay': `${ms}ms` } as CSSProperties;
}

export function TechnicalOverlay({ variant = 'measure', className, id = 'ov' }: Props) {
  const uid = `${id}-${variant}`;

  return (
    <svg
      className={['tech-overlay', `tech-overlay--${variant}`, className].filter(Boolean).join(' ')}
      viewBox="0 0 600 420"
      preserveAspectRatio="none"
      role="presentation"
      focusable="false"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id={`${uid}-grid`} width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M48 0H0V48" fill="none" stroke="rgba(56,93,122,0.13)" strokeWidth="1" />
        </pattern>
        <linearGradient id={`${uid}-sweep`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(217,165,74,0)" />
          <stop offset="70%" stopColor="rgba(160,114,32,0.18)" />
          <stop offset="100%" stopColor="rgba(217,165,74,0)" />
        </linearGradient>
      </defs>

      {/* Grid, faint, on every variant — the common ground of the language. */}
      <rect className="tech-overlay__grid" width="600" height="420" fill={`url(#${uid}-grid)`} />

      {/* Corner registration marks. */}
      <path
        className="tech-overlay__frame"
        d="M22 52V22h30M548 22h30v30M578 368v30h-30M52 398H22v-30"
        fill="none"
        stroke={FRAME}
        strokeWidth="1.4"
      />

      {variant === 'measure' ? (
        <g fill="none" strokeLinecap="round">
          {/* Witness lines, then the dimension between them, then the figure. */}
          <path
            className="tech-overlay__draw"
            style={delay(500)}
            pathLength={1}
            d="M150 250v96M450 250v96"
            stroke={STROKE}
            strokeWidth="1.2"
          />
          <path
            className="tech-overlay__draw"
            style={delay(1100)}
            pathLength={1}
            d="M150 320h300M150 312v16M450 312v16"
            stroke={ACCENT}
            strokeWidth="1.6"
          />
          <text className="tech-overlay__figure" x="300" y="306" textAnchor="middle">
            300.00
          </text>
        </g>
      ) : null}

      {variant === 'grid' ? (
        <g fill="none" strokeLinecap="round">
          <path
            className="tech-overlay__draw"
            style={delay(500)}
            pathLength={1}
            d="M120 110h360v200H120z"
            stroke={STROKE}
            strokeWidth="1.3"
          />
          <path
            className="tech-overlay__draw"
            style={delay(1200)}
            pathLength={1}
            d="M120 110 480 310M480 110 120 310"
            stroke={FRAME}
            strokeWidth="1.1"
          />
        </g>
      ) : null}

      {variant === 'flow' ? (
        <g fill="none" strokeLinecap="round">
          <path
            className="tech-overlay__draw"
            style={delay(500)}
            pathLength={1}
            d="M110 210h380"
            stroke={STROKE}
            strokeWidth="1.4"
          />
          <path
            className="tech-overlay__draw"
            style={delay(1000)}
            pathLength={1}
            d="M110 196v28M236 196v28M362 196v28M488 196v28"
            stroke={ACCENT}
            strokeWidth="1.6"
          />
          <path
            className="tech-overlay__pulse"
            style={delay(2200)}
            pathLength={1}
            d="M110 210h380"
            stroke={ACCENT}
            strokeWidth="3"
          />
        </g>
      ) : null}

      {variant === 'network' ? (
        <g fill="none" strokeLinecap="round">
          <path
            className="tech-overlay__draw"
            style={delay(500)}
            pathLength={1}
            d="M300 130 160 250 300 330 440 250Z"
            stroke={STROKE}
            strokeWidth="1.3"
          />
          <path
            className="tech-overlay__draw"
            style={delay(1200)}
            pathLength={1}
            d="M300 130v200M160 250h280"
            stroke={FRAME}
            strokeWidth="1.1"
          />
          {[
            [300, 130],
            [160, 250],
            [440, 250],
            [300, 330],
          ].map(([x, y], index) => (
            <circle
              key={`${x}-${y}`}
              className="tech-overlay__node"
              style={delay(1800 + index * 140)}
              cx={x}
              cy={y}
              r="5"
              fill={ACCENT}
              stroke="none"
            />
          ))}
        </g>
      ) : null}

      {/* One slow rule sweep, once the drawing has settled. */}
      <g className="tech-overlay__sweep">
        <rect x={-120} y="0" width="120" height="420" fill={`url(#${uid}-sweep)`} />
        <path d="M0 0V420" stroke="rgba(160,114,32,0.5)" strokeWidth="1.2" />
      </g>
    </svg>
  );
}
