import React, { useMemo } from 'react';
import { MINIMAP_NODE_COLORS } from '../utils/constants';
import { Layers } from 'lucide-react';

// Approximate default node dimensions by type
const DEFAULT_DIMS = {
  text: { w: 180, h: 36 },
  link: { w: 180, h: 50 },
  document: { w: 180, h: 36 },
  group: { w: 160, h: 110 },
  listing: { w: 240, h: 180 },
  jobcard: { w: 180, h: 90 },
  jobhub: { w: 280, h: 350 },
  sellhub: { w: 280, h: 350 },
};

function getDims(node) {
  const w = node.style?.width || node.measured?.width || DEFAULT_DIMS[node.type]?.w || 120;
  const h = node.style?.height || node.measured?.height || DEFAULT_DIMS[node.type]?.h || 40;
  return { w, h };
}

/**
 * SVG-based live thumbnail preview of a sub-canvas.
 * Renders nodes as colored rectangles and drawings as polylines,
 * scaled to fit the container via SVG viewBox.
 */
export const CanvasThumbnail = React.memo(function CanvasThumbnail({ canvasData, width, height }) {
  const { nodes = [], edges = [], drawings = [] } = canvasData || {};

  const isEmpty = nodes.length === 0 && drawings.length === 0;

  // Calculate bounding box and build render data
  const { viewBox, nodeRects, drawingPaths, edgeLines } = useMemo(() => {
    if (isEmpty) return { viewBox: '0 0 100 100', nodeRects: [], drawingPaths: [], edgeLines: [] };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const rects = nodes.map(n => {
      const { w, h } = getDims(n);
      const x = n.position.x;
      const y = n.position.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
      return {
        id: n.id,
        x, y, w, h,
        color: MINIMAP_NODE_COLORS[n.type] || '#555',
        type: n.type,
      };
    });

    // Include drawing bounds
    drawings.forEach(stroke => {
      const pts = Array.isArray(stroke) ? stroke : stroke?.points;
      if (!Array.isArray(pts)) return;
      pts.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });

    // If we only have tiny bounds, add a minimum size
    if (maxX - minX < 50) { minX -= 25; maxX += 25; }
    if (maxY - minY < 50) { minY -= 25; maxY += 25; }

    const pad = 20;
    const vbW = maxX - minX + pad * 2;
    const vbH = maxY - minY + pad * 2;

    // Build edge lines (simple center-to-center)
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });
    const lines = edges.map(e => {
      const src = nodeMap[e.source];
      const tgt = nodeMap[e.target];
      if (!src || !tgt) return null;
      const sd = getDims(src);
      const td = getDims(tgt);
      return {
        id: e.id,
        x1: src.position.x + sd.w / 2,
        y1: src.position.y + sd.h / 2,
        x2: tgt.position.x + td.w / 2,
        y2: tgt.position.y + td.h / 2,
      };
    }).filter(Boolean);

    const paths = drawings.map((stroke, i) => {
      const pts = Array.isArray(stroke) ? stroke : stroke?.points;
      const color = stroke?.color || 'white';
      if (!Array.isArray(pts) || pts.length < 2) return null;
      return {
        id: i,
        points: pts.map(p => `${p.x},${p.y}`).join(' '),
        color,
      };
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
      className="rounded-t-lg"
      style={{ background: 'rgba(10, 10, 10, 0.6)' }}
    >
      {/* Edges */}
      {edgeLines.map(l => (
        <line
          key={l.id}
          x1={l.x1} y1={l.y1}
          x2={l.x2} y2={l.y2}
          stroke="rgba(168, 85, 247, 0.4)"
          strokeWidth={3}
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

      {/* Nodes */}
      {nodeRects.map(r => (
        <rect
          key={r.id}
          x={r.x} y={r.y}
          width={r.w} height={r.h}
          rx={6} ry={6}
          fill={r.color}
          opacity={0.75}
        />
      ))}
    </svg>
  );
});
