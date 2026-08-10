import { groupSectors, verticals } from '@/lib/content/business';

/**
 * Home hero visualisation — "a technical blueprint coming to life".
 *
 * A single inline SVG driven entirely by CSS. It builds in five stages: the drafting
 * grid, engineering geometry drawing itself, links that turn the drawing into a
 * network, six industry nodes, and finally the JMK mark at the centre. A measurement
 * rule sweeps across once at the end.
 *
 * The canvas is authored at 600 x 560 and rendered at roughly that size, so strokes and
 * labels sit near 1:1 and stay razor sharp — it is drawn large rather than scaled up.
 *
 * Deliberately restrained: thin strokes, the existing navy/gold tokens, no neon, no
 * particles, no glowing text. It should read as CAD or a digital-twin view, not a game
 * HUD. Only the node rings and data pulses keep moving afterwards, slowly.
 *
 * The centre reuses the JMK wordmark treatment from the site header — no new or
 * invented logo.
 *
 * Decorative, so the whole graphic is hidden from assistive technology; the hero
 * heading and the sector list carry the meaning. Under `prefers-reduced-motion` the
 * finished composition is shown immediately.
 */

const CENTRE = { x: 300, y: 268 };

/** Six spokes: the three service verticals plus three of the group sectors. */
const NODES = [
  { id: 'academy', label: 'ACADEMY', x: 300, y: 90, labelX: 300, labelY: 58, anchor: 'middle' },
  { id: 'design', label: 'DESIGN', x: 454, y: 179, labelX: 478, labelY: 183, anchor: 'start' },
  { id: 'software', label: 'SOFTWARE', x: 454, y: 357, labelX: 478, labelY: 361, anchor: 'start' },
  { id: 'agriculture', label: 'AGRICULTURE', x: 300, y: 446, labelX: 300, labelY: 478, anchor: 'middle' },
  { id: 'renewable', label: 'RENEWABLE', x: 146, y: 357, labelX: 122, labelY: 361, anchor: 'end' },
  { id: 'exports', label: 'EXPORTS', x: 146, y: 179, labelX: 122, labelY: 183, anchor: 'end' },
] as const;

export function HeroVisualization() {
  // Anchor: the spokes correspond to real parts of the group, not invented divisions.
  const spokeCount = verticals.length + groupSectors.length;

  return (
    <div className="hero-viz" aria-hidden="true" data-spokes={spokeCount}>
      <svg
        className="hero-viz__svg"
        viewBox="0 0 600 560"
        role="presentation"
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="hv-fine" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
          </pattern>
          <pattern id="hv-coarse" width="120" height="120" patternUnits="userSpaceOnUse">
            <path d="M120 0H0V120" fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="1" />
          </pattern>
          <linearGradient id="hv-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(217,165,74,0)" />
            <stop offset="60%" stopColor="rgba(217,165,74,0.3)" />
            <stop offset="100%" stopColor="rgba(217,165,74,0)" />
          </linearGradient>
          <radialGradient id="hv-core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(192,139,46,0.3)" />
            <stop offset="100%" stopColor="rgba(192,139,46,0)" />
          </radialGradient>
          <clipPath id="hv-clip">
            <rect x="0" y="0" width="600" height="560" rx="14" />
          </clipPath>
        </defs>

        <g clipPath="url(#hv-clip)">
          {/* Stage 1 — drafting grid and frame markers */}
          <g className="hv-grid">
            <rect width="600" height="560" fill="url(#hv-fine)" />
            <rect width="600" height="560" fill="url(#hv-coarse)" />
          </g>

          <g className="hv-frame" stroke="rgba(217,165,74,0.55)" strokeWidth="1.2" fill="none">
            <path d="M24 54V24h30M546 24h30v30M576 506v30h-30M54 536H24v-30" />
            <path d="M288 24v12M312 24v12M288 536v-12M312 536v-12" opacity="0.6" />
            <path d="M24 256h12M24 280h12M576 256h-12M576 280h-12" opacity="0.6" />
          </g>

          {/* Stage 2 — engineering geometry drawing itself */}
          <g className="hv-geometry" fill="none" strokeLinecap="round">
            <circle
              className="hv-draw hv-draw--1"
              cx={CENTRE.x}
              cy={CENTRE.y}
              r="212"
              stroke="rgba(255,255,255,0.24)"
              strokeWidth="1.2"
              strokeDasharray="5 7"
            />
            <circle
              className="hv-draw hv-draw--2"
              cx={CENTRE.x}
              cy={CENTRE.y}
              r="150"
              stroke="rgba(255,255,255,0.52)"
              strokeWidth="1.6"
            />
            <path
              className="hv-draw hv-draw--3"
              d="M300 118a150 150 0 0 1 130 225"
              stroke="rgba(217,165,74,0.9)"
              strokeWidth="2"
            />
            <path
              className="hv-draw hv-draw--4"
              d="M170 343a150 150 0 0 1 0-150"
              stroke="rgba(217,165,74,0.62)"
              strokeWidth="2"
            />
            <path
              className="hv-draw hv-draw--5"
              d="M300 190v156M222 268h156"
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1.2"
              strokeDasharray="7 6"
            />
          </g>

          {/* Stage 3 — the drawing becomes a network */}
          <g className="hv-links" fill="none" strokeWidth="1.3" stroke="rgba(255,255,255,0.32)">
            {NODES.map((node, index) => (
              <path
                key={node.id}
                className={`hv-link hv-link--${index + 1}`}
                d={`M${CENTRE.x} ${CENTRE.y}L${node.x} ${node.y}`}
              />
            ))}
          </g>

          {/* Data pulses travelling outward along each link */}
          <g
            className="hv-pulses"
            fill="none"
            strokeWidth="2.6"
            stroke="rgba(217,165,74,0.92)"
            strokeLinecap="round"
          >
            {NODES.map((node, index) => (
              <path
                key={node.id}
                className={`hv-pulse hv-pulse--${index + 1}`}
                d={`M${CENTRE.x} ${CENTRE.y}L${node.x} ${node.y}`}
              />
            ))}
          </g>

          {/* Stage 4 — industry nodes */}
          <g className="hv-nodes">
            {NODES.map((node, index) => (
              <g key={node.id} className={`hv-node hv-node--${index + 1}`}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="22"
                  fill="rgba(10,27,46,0.92)"
                  stroke="rgba(255,255,255,0.24)"
                  strokeWidth="1.2"
                />
                <circle cx={node.x} cy={node.y} r="6" fill="rgba(217,165,74,0.95)" />
                <circle
                  className="hv-node__ring"
                  cx={node.x}
                  cy={node.y}
                  r="22"
                  fill="none"
                  stroke="rgba(217,165,74,0.6)"
                  strokeWidth="1.2"
                />
                <text
                  className="hv-node__label"
                  x={node.labelX}
                  y={node.labelY}
                  textAnchor={node.anchor}
                  fill="rgba(219,230,243,0.94)"
                >
                  {node.label}
                </text>
              </g>
            ))}
          </g>

          {/* Stage 5 — the JMK mark resolves at the centre */}
          <g className="hv-core">
            <circle cx={CENTRE.x} cy={CENTRE.y} r="96" fill="url(#hv-core-glow)" />
            <rect
              x={CENTRE.x - 76}
              y={CENTRE.y - 40}
              width="152"
              height="80"
              rx="8"
              fill="rgba(9,24,42,0.95)"
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="1.2"
            />
            <text className="hv-core__word" x={CENTRE.x} y={CENTRE.y + 4} textAnchor="middle">
              JMK
            </text>
            <text className="hv-core__sub" x={CENTRE.x} y={CENTRE.y + 25} textAnchor="middle">
              GLOBAL HOLDINGS
            </text>
            {/* The gold rule under the wordmark, as on the header brand mark. */}
            <rect x={CENTRE.x - 76} y={CENTRE.y + 36} width="152" height="4" fill="#c08b2e" />
          </g>

          {/* Measurement rule */}
          <g className="hv-dims" stroke="rgba(217,165,74,0.85)" strokeWidth="1.2" fill="none">
            <path d="M112 520h376M112 512v16M488 512v16" />
          </g>
          <text className="hv-dims__label" x="300" y="510" textAnchor="middle">
            376.00
          </text>

          {/* A single slow sweep once the drawing is complete */}
          <g className="hv-sweep">
            <rect x="-140" y="0" width="140" height="560" fill="url(#hv-sweep)" />
            <path d="M0 0V560" stroke="rgba(217,165,74,0.78)" strokeWidth="1.4" />
            {Array.from({ length: 29 }, (_, index) => (
              <path
                key={index}
                d={`M-${index % 5 === 0 ? 16 : 9} ${index * 20} H0`}
                stroke="rgba(217,165,74,0.6)"
                strokeWidth="1"
              />
            ))}
          </g>
        </g>

        <rect
          x="0.5"
          y="0.5"
          width="599"
          height="559"
          rx="14"
          fill="none"
          stroke="rgba(255,255,255,0.15)"
        />
      </svg>
    </div>
  );
}
