import React from 'react';
import { useViewport } from '@xyflow/react';

const GAP        = 48;   // must match Canvas.jsx
const DOT_RADIUS = 2.5;  // screen-space px (before zoom correction)

/**
 * Replaces React Flow's <Background> with a custom SVG that keeps
 * dots and grid lines pixel-perfectly aligned.
 *
 * Root cause of the misalignment in the built-in component:
 *   - "dots"  renders circles at tile CENTER  (cx = gap/2, cy = gap/2)
 *   - "lines" renders lines at tile EDGE      (x = 0,      y = 0)
 *
 * Fix: shift the dots pattern origin by -(scaledGap/2) so the circle
 * center maps onto the same screen coordinate as the grid-line intersection.
 *
 *   dots  → pattern x = offX − scaledGap/2,  circle at (scaledGap/2, scaledGap/2)
 *           screen position = (offX − gap/2) + gap/2 = offX  ✓
 *   lines → pattern x = offX,                line at x = 0
 *           screen position = offX + 0       = offX  ✓
 */
export function AlignedBackground({ variant = 'dots', color = 'rgba(255,255,255,0.08)' }) {
  const { x, y, zoom } = useViewport();

  if (variant === 'none') return null;

  const scaledGap = GAP * zoom;

  // Positive modulo — the phase of the repeating grid in screen space
  const offX = ((x % scaledGap) + scaledGap) % scaledGap;
  const offY = ((y % scaledGap) + scaledGap) % scaledGap;

  // Scale dot radius with zoom so it feels consistent
  const r = Math.max(1, DOT_RADIUS * Math.min(zoom, 1.5));

  const pid = variant; // stable id; only one background is ever mounted

  return (
    <svg
      style={{
        position:      'absolute',
        inset:         0,
        width:         '100%',
        height:        '100%',
        pointerEvents: 'none',
        zIndex:        0,
      }}
    >
      <defs>
        {variant === 'dots' ? (
          <pattern
            id={`ab-${pid}`}
            // Shift origin back by half a period so the centered circle
            // lands exactly on the grid intersection.
            x={offX - scaledGap / 2}
            y={offY - scaledGap / 2}
            width={scaledGap}
            height={scaledGap}
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx={scaledGap / 2}
              cy={scaledGap / 2}
              r={r}
              fill={color}
            />
          </pattern>
        ) : (
          <pattern
            id={`ab-${pid}`}
            x={offX}
            y={offY}
            width={scaledGap}
            height={scaledGap}
            patternUnits="userSpaceOnUse"
          >
            {/* L-shaped path draws one horizontal + one vertical line per tile */}
            <path
              d={`M ${scaledGap} 0 L 0 0 0 ${scaledGap}`}
              stroke={color}
              strokeWidth="0.6"
              fill="none"
            />
          </pattern>
        )}
      </defs>

      <rect width="100%" height="100%" fill={`url(#ab-${pid})`} />
    </svg>
  );
}
