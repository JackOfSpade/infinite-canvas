import React, { useMemo } from 'react';
import { MINIMAP_NODE_COLORS } from '../utils/constants';
import { Layers } from 'lucide-react';

// Approximate default node dimensions by type
const DEFAULT_DIMS = {
  text:     { w: 180, h: 36 },
  link:     { w: 180, h: 50 },
  document: { w: 180, h: 36 },
  group:    { w: 160, h: 110 },
  listing:  { w: 240, h: 180 },
  jobcard:  { w: 180, h: 90 },
  jobhub:   { w: 280, h: 350 },
  sellhub:  { w: 280, h: 350 },
};

function getDims(node) {
  const w = node.style?.width  || node.measured?.width  || DEFAULT_DIMS[node.type]?.w || 120;
  const h = node.style?.height || node.measured?.height || DEFAULT_DIMS[node.type]?.h || 40;
  return { w, h };
}

/** Strip basic markdown markers so we show raw text in the thumbnail */
function stripMarkdown(str) {
  return (str || '')
    .replace(/!\[.*?\]\(.*?\)/g, '')   // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url)
    .replace(/#{1,6}\s?/g, '')          // headings
    .replace(/[*_~`>|]/g, '')           // emphasis / code
    .replace(/\n{2,}/g, '\n')           // collapse blank lines
    .trim();
}

/** Try to extract a short domain-or-label string from a LinkNode's data */
function getLinkDisplay(data) {
  const raw = data?.label || data?.url || '';
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return raw; }
}

/**
 * Node renderer for the thumbnail SVG.
 * - text nodes: white SVG text lines (first 3, stripped of markdown)
 * - link nodes: muted blue background + domain/label text
 * - all others: solid-color rectangle (minimap palette)
 */
function ThumbnailNode({ r }) {
  const { x, y, w, h, type, data } = r;

  if (type === 'text') {
    const lines = stripMarkdown(data?.text)
      .split('\n')
      .filter(l => l.trim())
      .slice(0, 4);

    const lineH   = Math.min(h / (lines.length || 1), 14);
    const fontSize = Math.max(7, Math.min(11, lineH * 0.8));

    return (
      <g>
        {/* Faint bg so it's distinguishable from canvas bg */}
        <rect x={x} y={y} width={w} height={h} rx={4} fill="rgba(255,255,255,0.05)" />
        {lines.length === 0 ? (
          <text x={x + 6} y={y + 14} fontSize={fontSize} fill="rgba(255,255,255,0.2)"
                fontFamily="Inter, ui-sans-serif, sans-serif">
            (empty)
          </text>
        ) : lines.map((line, i) => {
          const maxChars = Math.floor(w / (fontSize * 0.55));
          const display  = line.length > maxChars ? line.slice(0, maxChars - 1) + '…' : line;
          return (
            <text
              key={i}
              x={x + 6}
              y={y + (i + 1) * lineH - 2}
              fontSize={fontSize}
              fill="rgba(255,255,255,0.70)"
              fontFamily="Inter, ui-sans-serif, sans-serif"
            >
              {display}
            </text>
          );
        })}
      </g>
    );
  }

  if (type === 'link') {
    const display  = getLinkDisplay(data);
    const maxChars = Math.floor(w / 8);
    const label    = display.length > maxChars ? display.slice(0, maxChars - 1) + '…' : display;

    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={4} fill="rgba(96,165,250,0.07)"
              stroke="rgba(96,165,250,0.20)" strokeWidth="1" />
        <text x={x + 7} y={y + h / 2 + 4} fontSize={9} fill="rgba(96,165,250,0.75)"
              fontFamily="Inter, ui-sans-serif, sans-serif">
          ↗ {label || '—'}
        </text>
      </g>
    );
  }

  // All other node types: solid rectangle (minimap palette)
  return (
    <rect
      x={x} y={y} width={w} height={h}
      rx={6} ry={6}
      fill={MINIMAP_NODE_COLORS[type] || '#555'}
      opacity={0.75}
    />
  );
}

/**
 * SVG-based live thumbnail preview of a sub-canvas.
 * Text and link nodes render their actual content; other nodes use color blocks.
 */
export const CanvasThumbnail = React.memo(function CanvasThumbnail({ canvasData, width, height }) {
  const { nodes = [], edges = [], drawings = [] } = canvasData || {};
  const isEmpty = nodes.length === 0 && drawings.length === 0;

  const { viewBox, nodeRects, drawingPaths, edgeLines } = useMemo(() => {
    if (isEmpty) return { viewBox: '0 0 100 100', nodeRects: [], drawingPaths: [], edgeLines: [] };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const rects = nodes.map(n => {
      const { w, h } = getDims(n);
      const x = n.position.x, y = n.position.y;
      minX = Math.min(minX, x);    minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      return { id: n.id, x, y, w, h, type: n.type, data: n.data };
    });

    drawings.forEach(stroke => {
      const pts = Array.isArray(stroke) ? stroke : stroke?.points;
      if (!Array.isArray(pts)) return;
      pts.forEach(p => {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      });
    });

    if (maxX - minX < 50) { minX -= 25; maxX += 25; }
    if (maxY - minY < 50) { minY -= 25; maxY += 25; }

    const pad = 20;
    const vbW = maxX - minX + pad * 2;
    const vbH = maxY - minY + pad * 2;

    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });
    const lines = edges.map(e => {
      const src = nodeMap[e.source], tgt = nodeMap[e.target];
      if (!src || !tgt) return null;
      const sd = getDims(src), td = getDims(tgt);
      return {
        id: e.id,
        x1: src.position.x + sd.w / 2, y1: src.position.y + sd.h / 2,
        x2: tgt.position.x + td.w / 2, y2: tgt.position.y + td.h / 2,
      };
    }).filter(Boolean);

    const paths = drawings.map((stroke, i) => {
      const pts   = Array.isArray(stroke) ? stroke : stroke?.points;
      const color = stroke?.color || 'white';
      if (!Array.isArray(pts) || pts.length < 2) return null;
      return { id: i, points: pts.map(p => `${p.x},${p.y}`).join(' '), color };
    }).filter(Boolean);

    return {
      viewBox: `${minX - pad} ${minY - pad} ${vbW} ${vbH}`,
      nodeRects: rects,
      drawingPaths: paths,
      edgeLines: lines,
    };
  }, [nodes, edges, drawings, isEmpty]);

  if (isEmpty) {
    return (
      <div
        className="flex items-center justify-center rounded-t-lg"
        style={{ width, height, background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="flex flex-col items-center gap-1.5 text-white/15">
          <Layers size={20} />
          <span className="text-[9px] font-medium tracking-wide">EMPTY</span>
        </div>
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      style={{ background: 'rgba(10, 10, 10, 0.6)', display: 'block' }}
    >
      {/* Edges */}
      {edgeLines.map(l => (
        <line
          key={l.id}
          x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="rgba(168, 85, 247, 0.4)" strokeWidth={3}
        />
      ))}

      {/* Drawings */}
      {drawingPaths.map(p => (
        <polyline
          key={p.id}
          points={p.points}
          fill="none"
          stroke={p.color === 'white' ? 'rgba(255,255,255,0.35)' : `${p.color}80`}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {/* Nodes — text/link render actual content; others are color blocks */}
      {nodeRects.map(r => <ThumbnailNode key={r.id} r={r} />)}
    </svg>
  );
});
