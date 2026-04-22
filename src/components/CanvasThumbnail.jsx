import React, { useMemo } from 'react';
import { getNodeDims } from '../utils/constants';
import { Layers } from 'lucide-react';

import { ThumbnailNode } from './ThumbnailNode';

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
      const { w, h } = getNodeDims(n);
      const x = n.position.x, y = n.position.y;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
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

    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });
    const lines = edges.map(e => {
      const src = nodeMap[e.source], tgt = nodeMap[e.target];
      if (!src || !tgt) return null;
      const sd = getNodeDims(src), td = getNodeDims(tgt);
      
      const sx = src.position.x + sd.w;
      const sy = src.position.y + sd.h / 2;
      const tx = tgt.position.x;
      const ty = tgt.position.y + td.h / 2;
      const offset = Math.abs(tx - sx) * 0.6;
      
      return {
        id: e.id,
        d: `M${sx},${sy} C${sx + offset},${sy} ${tx - offset},${ty} ${tx},${ty}`
      };
    }).filter(Boolean);

    const paths = drawings.map((stroke, i) => {
      const pts = Array.isArray(stroke) ? stroke : stroke?.points;
      const color = stroke?.color || 'white';
      if (!Array.isArray(pts) || pts.length < 2) return null;
      return { id: i, points: pts.map(p => `${p.x},${p.y}`).join(' '), color };
    }).filter(Boolean);

    const pad = 20;

    // Centroid of the bounding box
    const centX = (minX + maxX) / 2;
    const centY = (minY + maxY) / 2;

    // Max distance from centroid is just half the diagonal of the bounding box
    let maxDist = Math.sqrt(((maxX - minX) / 2) ** 2 + ((maxY - minY) / 2) ** 2);
    if (maxDist === 0) maxDist = 50;

    const sqHalf = maxDist + pad;
    const sqSize = sqHalf * 2;
    const sqMinX = centX - sqHalf;
    const sqMinY = centY - sqHalf;

    return {
      viewBox: `${sqMinX} ${sqMinY} ${sqSize} ${sqSize}`,
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
        <path
          key={l.id}
          d={l.d}
          fill="none"
          stroke="rgba(168, 85, 247, 0.50)" strokeWidth={3}
          strokeDasharray="6,6"
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
