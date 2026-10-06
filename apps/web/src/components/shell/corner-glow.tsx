/**
 * Ambient decorative graphic anchored to the bottom inline-end corner of the
 * viewport (bottom-right in LTR, mirrored to bottom-left in RTL):
 * soft lemon-lime ribbons behind concentric dotted arcs. Authored as inline
 * SVG so it stays crisp at any size, tints from the lime tokens (light/dark
 * both work with no second asset), and ships no external file. Decorative
 * only — aria-hidden, pointer-events-none, sits behind content.
 */
export function CornerGlow() {
  // Dashed circles centred on the corner; only their inner quarter is on-screen,
  // which reads as arcs of dots fanning out from the corner.
  const arcs = [140, 200, 260, 320, 380, 440, 500];

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <svg
        className="absolute end-0 bottom-0 h-[75vh] max-h-[680px] w-[75vw] max-w-[820px] rtl:-scale-x-100"
        viewBox="0 0 600 480"
        fill="none"
        preserveAspectRatio="xMaxYMax slice"
      >
        <defs>
          <filter id="cg-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="26" />
          </filter>
        </defs>

        {/* Flowing ribbons — soft, blurred lime fills, layered. */}
        <g filter="url(#cg-soft)" style={{ color: "var(--lime)" }}>
          <path
            d="M600 120 C 470 180, 520 320, 380 380 C 300 415, 340 480, 600 480 Z"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <path
            d="M600 220 C 500 250, 540 360, 440 420 C 380 456, 460 480, 600 480 Z"
            fill="currentColor"
            fillOpacity="0.22"
          />
          <path
            d="M600 320 C 540 335, 560 410, 500 450 C 470 470, 540 480, 600 480 Z"
            fill="var(--lime-ring)"
            fillOpacity="0.26"
          />
        </g>

        {/* Concentric dotted arcs from the corner. */}
        <g
          stroke="var(--lime-ring)"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        >
          {arcs.map((r, i) => (
            <circle
              key={r}
              cx="600"
              cy="480"
              r={r}
              strokeDasharray="0.5 15"
              strokeOpacity={0.5 - i * 0.045}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
