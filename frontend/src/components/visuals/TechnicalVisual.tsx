import type { VisualSpec } from '@/lib/content/visuals';

/**
 * The JMK technical visualisation engine.
 *
 * One renderer, many drawings. Each page supplies a `VisualSpec` (see
 * `lib/content/visuals.ts`) describing its own geometry, nodes and measurement, and
 * this component draws it with the shared staged animation: grid → frame → geometry
 * drawing itself → connections → nodes → centre mark → dimensions → a single rule
 * sweep. The result is one visual language across the site without any page reusing
 * another page's picture.
 *
 * Everything is inline SVG animated by CSS only — no canvas, no animation library, no
 * JavaScript timers. Motion runs on `opacity`, `transform` and `stroke-dashoffset`, so
 * the compositor does the work.
 *
 * Decorative by definition: the graphic is hidden from assistive technology and the
 * surrounding heading carries the meaning. Under `prefers-reduced-motion` the finished
 * drawing is shown immediately — see `styles/technical-visuals.css`.
 */

const STROKES = {
  line: { stroke: 'rgba(255,255,255,0.5)', width: 1.6 },
  faint: { stroke: 'rgba(255,255,255,0.24)', width: 1.2 },
  accent: { stroke: 'rgba(217,165,74,0.9)', width: 2 },
  accentSoft: { stroke: 'rgba(217,165,74,0.6)', width: 1.6 },
} as const;

type Props = {
  spec: VisualSpec;
  /** Extra class on the outer frame, e.g. to constrain width in a page hero. */
  className?: string;
};

export function TechnicalVisual({ spec, className }: Props) {
  const uid = spec.id;
  const centre = spec.centre;

  return (
    <div className={['tv', className].filter(Boolean).join(' ')} aria-hidden="true">
      {spec.caption ? (
        <p className="tv__caption">
          <span>{spec.caption[0]}</span>
          <span>{spec.caption[1]}</span>
        </p>
      ) : null}

      <div className="tv__frame">
        <svg
          className="tv__svg"
          viewBox={`0 0 ${spec.width} ${spec.height}`}
          role="presentation"
          focusable="false"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern id={`${uid}-fine`} width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            </pattern>
            <pattern id={`${uid}-coarse`} width="120" height="120" patternUnits="userSpaceOnUse">
              <path d="M120 0H0V120" fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="1" />
            </pattern>
            <linearGradient id={`${uid}-sweep`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(217,165,74,0)" />
              <stop offset="60%" stopColor="rgba(217,165,74,0.3)" />
              <stop offset="100%" stopColor="rgba(217,165,74,0)" />
            </linearGradient>
            <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(192,139,46,0.3)" />
              <stop offset="100%" stopColor="rgba(192,139,46,0)" />
            </radialGradient>
            <clipPath id={`${uid}-clip`}>
              <rect x="0" y="0" width={spec.width} height={spec.height} rx="14" />
            </clipPath>
          </defs>

          <g clipPath={`url(#${uid}-clip)`}>
            {/* Drafting grid */}
            <g className="tv-grid">
              <rect width={spec.width} height={spec.height} fill={`url(#${uid}-fine)`} />
              <rect width={spec.width} height={spec.height} fill={`url(#${uid}-coarse)`} />
            </g>

            {/* Corner registration marks */}
            <g className="tv-frame" stroke="rgba(217,165,74,0.55)" strokeWidth="1.2" fill="none">
              <path
                d={`M24 54V24h30M${spec.width - 54} 24h30v30M${spec.width - 24} ${
                  spec.height - 54
                }v30h-30M54 ${spec.height - 24}H24v-30`}
              />
            </g>

            {/* Geometry.
                Solid outlines draw themselves; dashed construction lines fade in.
                A dashed line cannot also be drawn by `stroke-dashoffset` — the two uses
                of `stroke-dasharray` collide — and in drafting the centre lines are laid
                down first anyway, so this reads correctly as well as rendering correctly.
                Solid paths carry `pathLength={1}`, which normalises every outline to a
                length of 1 so a short line and a long arc take the same time to draw
                instead of the short one snapping into place. */}
            <g className="tv-geometry" fill="none" strokeLinecap="round">
              {spec.geometry.map((shape, index) => {
                const preset = STROKES[shape.tone];
                const delay = { '--tv-delay': `${700 + index * 260}ms` } as React.CSSProperties;
                return shape.dash ? (
                  <path
                    key={index}
                    className="tv-construct"
                    style={delay}
                    d={shape.d}
                    stroke={preset.stroke}
                    strokeWidth={preset.width}
                    strokeDasharray={shape.dash}
                  />
                ) : (
                  <path
                    key={index}
                    className="tv-draw"
                    style={delay}
                    d={shape.d}
                    pathLength={1}
                    stroke={preset.stroke}
                    strokeWidth={preset.width}
                  />
                );
              })}
            </g>

            {/* Connections from the centre to each node */}
            {centre && spec.connect !== false ? (
              <>
                <g className="tv-links" fill="none" strokeWidth="1.3" stroke="rgba(255,255,255,0.32)">
                  {spec.nodes.map((node, index) => (
                    <path
                      key={node.label}
                      className="tv-link"
                      style={{ '--tv-delay': `${2300 + index * 120}ms` } as React.CSSProperties}
                      pathLength={1}
                      d={`M${centre.x} ${centre.y}L${node.x} ${node.y}`}
                    />
                  ))}
                </g>
                <g
                  className="tv-pulses"
                  fill="none"
                  strokeWidth="2.6"
                  stroke="rgba(217,165,74,0.92)"
                  strokeLinecap="round"
                >
                  {spec.nodes.map((node, index) => (
                    <path
                      key={node.label}
                      className="tv-pulse"
                      style={{ '--tv-delay': `${5000 + index * 300}ms` } as React.CSSProperties}
                      pathLength={1}
                      d={`M${centre.x} ${centre.y}L${node.x} ${node.y}`}
                    />
                  ))}
                </g>
              </>
            ) : null}

            {/* Nodes */}
            <g className="tv-nodes">
              {spec.nodes.map((node, index) => (
                <g
                  key={node.label}
                  className="tv-node"
                  style={{ '--tv-delay': `${2900 + index * 120}ms` } as React.CSSProperties}
                >
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
                    className="tv-node__ring"
                    style={{ '--tv-delay': `${4200 + index * 300}ms` } as React.CSSProperties}
                    cx={node.x}
                    cy={node.y}
                    r="22"
                    fill="none"
                    stroke="rgba(217,165,74,0.6)"
                    strokeWidth="1.2"
                  />
                  <text
                    className="tv-node__label"
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

            {/* Centre mark */}
            {centre ? (
              <g className="tv-core">
                <circle cx={centre.x} cy={centre.y} r="96" fill={`url(#${uid}-glow)`} />
                <rect
                  x={centre.x - 76}
                  y={centre.y - 40}
                  width="152"
                  height="80"
                  rx="8"
                  fill="rgba(9,24,42,0.95)"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="1.2"
                />
                <text className="tv-core__word" x={centre.x} y={centre.y + 4} textAnchor="middle">
                  {centre.primary}
                </text>
                {centre.secondary ? (
                  <text className="tv-core__sub" x={centre.x} y={centre.y + 25} textAnchor="middle">
                    {centre.secondary}
                  </text>
                ) : null}
                <rect x={centre.x - 76} y={centre.y + 36} width="152" height="4" fill="#c08b2e" />
              </g>
            ) : null}

            {/* Dimension line */}
            {spec.measurement ? (
              <>
                <g className="tv-dims" stroke="rgba(217,165,74,0.85)" strokeWidth="1.2" fill="none">
                  <path
                    d={`M${spec.measurement.x1} ${spec.measurement.y}h${
                      spec.measurement.x2 - spec.measurement.x1
                    }M${spec.measurement.x1} ${spec.measurement.y - 8}v16M${spec.measurement.x2} ${
                      spec.measurement.y - 8
                    }v16`}
                  />
                </g>
                <text
                  className="tv-dims__label"
                  x={(spec.measurement.x1 + spec.measurement.x2) / 2}
                  y={spec.measurement.y - 10}
                  textAnchor="middle"
                >
                  {spec.measurement.label}
                </text>
              </>
            ) : null}

            {/* One slow measuring sweep once the drawing is complete */}
            <g
              className="tv-sweep"
              style={{ '--tv-travel': `${spec.width + 160}px` } as React.CSSProperties}
            >
              <rect x={-140} y="0" width="140" height={spec.height} fill={`url(#${uid}-sweep)`} />
              <path d={`M0 0V${spec.height}`} stroke="rgba(217,165,74,0.78)" strokeWidth="1.4" />
              {Array.from({ length: Math.ceil(spec.height / 20) }, (_, index) => (
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
            width={spec.width - 1}
            height={spec.height - 1}
            rx="14"
            fill="none"
            stroke="rgba(255,255,255,0.15)"
          />
        </svg>
      </div>
    </div>
  );
}
