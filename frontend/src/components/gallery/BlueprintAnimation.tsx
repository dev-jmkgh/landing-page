/**
 * Animated engineering blueprint for the Gallery hero.
 *
 * Pure inline SVG + CSS: a grid fades in, a technical outline draws itself, dimension
 * markers appear and a drafting ruler glides once across the drawing. It runs a single
 * slow pass rather than looping aggressively, so it reads as "a drawing being made"
 * rather than decoration in motion.
 *
 * Under `prefers-reduced-motion` every animation is disabled in CSS and the finished
 * drawing is shown immediately — the `stroke-dashoffset` and opacity end states are
 * declared as the defaults there, so nothing is left half-drawn.
 *
 * Decorative: hidden from assistive technology, with the meaning carried by the
 * surrounding heading and copy.
 */
export function BlueprintAnimation() {
  return (
    <div className="blueprint" aria-hidden="true">
      <svg
        className="blueprint__svg"
        viewBox="0 0 520 360"
        role="presentation"
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="bp-grid-sm" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          </pattern>
          <pattern id="bp-grid-lg" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M100 0H0V100" fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="1" />
          </pattern>
          <linearGradient id="bp-ruler" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(217,165,74,0.42)" />
            <stop offset="100%" stopColor="rgba(217,165,74,0.06)" />
          </linearGradient>
          <clipPath id="bp-clip">
            <rect x="0" y="0" width="520" height="360" rx="10" />
          </clipPath>
        </defs>

        <g clipPath="url(#bp-clip)">
          {/* 1 — the grid */}
          <g className="blueprint__grid">
            <rect width="520" height="360" fill="url(#bp-grid-sm)" />
            <rect width="520" height="360" fill="url(#bp-grid-lg)" />
          </g>

          {/* 2 — the part outline drawing itself */}
          <g
            className="blueprint__outline"
            fill="none"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <path
              className="blueprint__path blueprint__path--1"
              d="M140 232V150a18 18 0 0 1 18-18h44l22-30h72l22 30h44a18 18 0 0 1 18 18v82Z"
            />
            <circle className="blueprint__path blueprint__path--2" cx="260" cy="186" r="42" />
            <circle className="blueprint__path blueprint__path--3" cx="260" cy="186" r="22" />
            <path className="blueprint__path blueprint__path--4" d="M140 232h240" />
          </g>

          {/* 3 — centre marks and dimension lines */}
          <g
            className="blueprint__dims"
            fill="none"
            stroke="rgba(217,165,74,0.85)"
            strokeWidth="1.1"
          >
            <path d="M260 128v116M202 186h116" strokeDasharray="5 5" opacity="0.65" />
            <path d="M140 268h240M140 262v12M380 262v12" />
            <path d="M104 132v100M98 132h12M98 232h12" />
          </g>

          <g className="blueprint__labels" fill="rgba(217,165,74,0.95)" fontSize="11" fontFamily="monospace">
            <text x="243" y="286" className="blueprint__label">
              240.00
            </text>
            <text x="58" y="186" className="blueprint__label">
              100.0
            </text>
            <text x="286" y="152" className="blueprint__label">
              R42
            </text>
          </g>

          {/* 4 — the ruler, gliding once across the drawing */}
          <g className="blueprint__ruler">
            <rect x="-70" y="0" width="70" height="360" fill="url(#bp-ruler)" />
            <path d="M0 0V360" stroke="rgba(217,165,74,0.9)" strokeWidth="1.5" />
            {Array.from({ length: 19 }, (_, index) => (
              <path
                key={index}
                d={`M-${index % 5 === 0 ? 16 : 9} ${index * 20} H0`}
                stroke="rgba(217,165,74,0.75)"
                strokeWidth="1"
              />
            ))}
          </g>
        </g>

        <rect
          x="0.5"
          y="0.5"
          width="519"
          height="359"
          rx="10"
          fill="none"
          stroke="rgba(255,255,255,0.16)"
        />
      </svg>
    </div>
  );
}
