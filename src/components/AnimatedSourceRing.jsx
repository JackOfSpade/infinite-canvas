import React, { useMemo } from 'react';

/**
 * AnimatedSourceRing — renders orbiting source icons around a hub node
 * with GROWING SVG arrows that extend from source toward hub (or vice versa).
 *
 * Phase 2 upgrades:
 *   - Staggered entry: sources fade in with 200ms delay per icon
 *   - Completion bounce: done icons scale up briefly
 *   - Active glow: pulsing box-shadow on active icons
 *
 * Arrow behavior:
 *   - idle:   hidden
 *   - active: arrow grows from tail (source) toward hub with a pulse dot at head
 *   - done:   arrow fully connected, solid, checkmark on source icon
 *   - error:  arrow turns red, ✗ on source icon
 *
 * Each arrow shows an inline micro-label with live status text.
 *
 * Props:
 *   sources: [{ id, name, letter, color, status, statusText, hoverText, onClick }]
 *   direction: 'in' | 'out'
 *   nodeWidth, nodeHeight: hub dimensions
 *   radius: distance from center for source icons
 */
export function AnimatedSourceRing({
  sources,
  nodeId = 'hub', // unique prefix to namespace SVG IDs per instance
  direction = 'in',
  nodeWidth = 260,
  nodeHeight = 160,
  radius = 120,
}) {
  const cx = nodeWidth / 2;
  const cy = nodeHeight / 2;

  // Stable positions for ALL sources based ONLY on count and radius
  const sourceCount = sources.length;
  const positions = useMemo(() =>
    Array.from({ length: sourceCount }).map((_, i) => {
      const angle = (i / sourceCount) * 2 * Math.PI - Math.PI / 2;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    }),
    [sourceCount, cx, cy, radius]
  );

  const visibleSources = sources.filter(s => s.status !== 'idle');
  if (visibleSources.length === 0) return null;

  const svgPad = radius + 40;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: cx - svgPad,
        top: cy - svgPad,
        width: svgPad * 2,
        height: svgPad * 2,
      }}
    >
      {/* SVG layer: arrows + arrowheads + pulse dots */}
      <svg
        width={svgPad * 2}
        height={svgPad * 2}
        className="absolute inset-0"
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* Arrowhead markers per source — prefixed with nodeId to avoid document-wide ID collisions */}
          {sources.map(source => (
            <marker
              key={`marker-${nodeId}-${source.id}`}
              id={`arrowhead-${nodeId}-${source.id}`}
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <polygon
                points="0 0, 8 3, 0 6"
                fill={source.status === 'error' ? '#ef4444' : source.color}
                opacity={source.status === 'done' ? 0.4 : 0.8}
              />
            </marker>
          ))}

          {/* Glow filter for active sources — also namespaced */}
          <filter id={`activeGlow-${nodeId}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {sources.map((source, i) => {
          if (source.status === 'idle') return null;

          const pos = positions[i];
          // Convert to SVG-local coordinates (center of SVG = svgPad, svgPad)
          const sx = pos.x - cx + svgPad;
          const sy = pos.y - cy + svgPad;
          const hx = svgPad;
          const hy = svgPad;

          const isActive = source.status === 'active';
          const isDone = source.status === 'done';
          const isError = source.status === 'error';

          // Arrow endpoints with inset to avoid overlapping icons
          const dx = hx - sx;
          const dy = hy - sy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const inset = 22;
          const r = inset / dist;

          // Tail = fixed end, Head = moving end
          let tailX, tailY, headX, headY;
          if (direction === 'in') {
            tailX = sx + dx * r;
            tailY = sy + dy * r;
            headX = hx - dx * r;
            headY = hy - dy * r;
          } else {
            tailX = hx + (sx - hx) * r;
            tailY = hy + (sy - hy) * r;
            headX = sx - (sx - hx) * r;
            headY = sy - (sy - hy) * r;
          }

          const lineLength = Math.sqrt(
            (headX - tailX) ** 2 + (headY - tailY) ** 2
          );

          const dashOffset = isActive
            ? lineLength * 0.12
            : isDone || isError
            ? 0
            : lineLength;

          const transitionDuration = isActive
            ? '2.5s'
            : isDone || isError
            ? '0.4s'
            : '0s';

          // Compute arrow head position for pulse dot
          const revealFraction = isActive ? 0.85 : isDone ? 1 : 0;
          const tipX = tailX + (headX - tailX) * revealFraction;
          const tipY = tailY + (headY - tailY) * revealFraction;

          return (
            <g key={source.id} className="cursor-help">
              {/* Tooltip for the arrow itself */}
              <title>{source.hoverText || source.statusText || 'Processing...'}</title>

              {/* Growing arrow line */}
              <line
                x1={tailX}
                y1={tailY}
                x2={headX}
                y2={headY}
                stroke={isError ? '#ef4444' : source.color}
                strokeWidth={isActive ? 2.5 : 1.5}
                strokeDasharray={lineLength}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
                opacity={isDone ? 0.3 : 0.75}
                markerEnd={`url(#arrowhead-${nodeId}-${source.id})`}
                style={{
                  transition: `stroke-dashoffset ${transitionDuration} ease-out, stroke-width 0.3s, opacity 0.3s`,
                }}
              />

              {/* Pulse dot at arrow head — only when active */}
              {isActive && (
                <circle
                  cx={tipX}
                  cy={tipY}
                  r={4}
                  fill={source.color}
                  opacity={0.9}
                >
                  <animate
                    attributeName="r"
                    values="3;6;3"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.9;0.3;0.9"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}
      </svg>

      {/* Inline micro-labels on arrows — HTML positioned at arrow midpoint */}
      {sources.map((source, i) => {
        if (source.status === 'idle' || !source.statusText) return null;

        const pos = positions[i];
        const sx = pos.x - cx + svgPad;
        const sy = pos.y - cy + svgPad;
        const hx = svgPad;
        const hy = svgPad;

        // Position label at ~40% along the arrow (closer to source)
        const labelT = 0.4;
        const labelX = sx + (hx - sx) * labelT;
        const labelY = sy + (hy - sy) * labelT;

        const isActive = source.status === 'active';
        const isDone = source.status === 'done';
        const isError = source.status === 'error';

        // Calculate rotation angle for label to follow arrow direction
        const angle = Math.atan2(hy - sy, hx - sx) * (180 / Math.PI);
        const flipLabel = angle > 90 || angle < -90;
        const labelAngle = flipLabel ? angle + 180 : angle;

        return (
          <div
            key={`label-${source.id}`}
            className={`absolute pointer-events-auto transition-opacity duration-500 ${
              isActive ? 'opacity-100' : isDone || isError ? 'opacity-50' : 'opacity-0'
            }`}
            style={{
              left: labelX,
              top: labelY,
              transform: `translate(-50%, -50%) rotate(${labelAngle}deg)`,
              // Staggered entry: delay based on source index
              transitionDelay: `${i * 200}ms`,
            }}
            title={source.hoverText || source.statusText}
          >
            <div
              className="px-1.5 py-0.5 rounded text-[9px] font-medium whitespace-nowrap backdrop-blur-sm"
              style={{
                backgroundColor: `${isError ? '#ef4444' : source.color}18`,
                color: isError ? '#ef4444' : `${source.color}cc`,
                border: `1px solid ${isError ? '#ef4444' : source.color}20`,
              }}
            >
              {source.statusText}
            </div>
          </div>
        );
      })}

      {/* Source icons */}
      {sources.map((source, i) => {
        if (source.status === 'idle') return null;

        const pos = positions[i];
        const sx = pos.x - cx + svgPad;
        const sy = pos.y - cy + svgPad;
        const isActive = source.status === 'active';
        const isDone = source.status === 'done';
        const isError = source.status === 'error';

        return (
          <div
            key={source.id}
            className={`absolute pointer-events-auto ${
              source.status === 'idle'
                ? 'opacity-0 scale-0'
                : 'opacity-100 scale-100'
            }`}
            style={{
              left: sx - 18,
              top: sy - 18,
              width: 36,
              height: 36,
              // Staggered entry: each icon fades in 200ms after the previous
              transition: `opacity 0.5s ease-out ${i * 200}ms, transform 0.5s ease-out ${i * 200}ms`,
            }}
            onClick={source.onClick}
            title={source.hoverText || source.name}
          >
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shadow-lg border-2 transition-all ${
                source.onClick ? 'cursor-pointer hover:scale-110' : ''
              }`}
              style={{
                backgroundColor: isDone
                  ? `${source.color}30`
                  : isError
                  ? '#ef444420'
                  : `${source.color}15`,
                borderColor: isDone
                  ? `${source.color}60`
                  : isError
                  ? '#ef444440'
                  : `${source.color}30`,
                color: isError ? '#ef4444' : source.color,
                // Active glow effect
                boxShadow: isActive
                  ? `0 0 12px ${source.color}40, 0 0 4px ${source.color}20`
                  : 'none',
                // Completion bounce: brief scale-up on done
                animation: isDone
                  ? 'completionBounce 0.4s ease-out'
                  : isActive
                  ? 'activePulse 2s ease-in-out infinite'
                  : 'none',
              }}
            >
              {isDone ? '✓' : isError ? '✗' : source.letter}
            </div>
          </div>
        );
      })}

    </div>
  );
}
