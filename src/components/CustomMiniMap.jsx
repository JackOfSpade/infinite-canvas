import React, { useMemo, useRef, useCallback } from 'react';
import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { getNodeDims } from '../utils/constants';
import { strokePoints } from '../utils/geometry';
import { ThumbnailNode } from './ThumbnailNode';

const MINIMAP_W = 200;
const MINIMAP_H = 140;
const CONTENT_PAD = 40;

/**
 * Custom SVG mini-map that renders actual node content (text preview, link labels,
 * nested canvas circles) and freehand drawing strokes. Supports click-to-pan.
 *
 * Rendered inside ReactFlow so it has access to useViewport / useReactFlow.
 */
const vpTransformSelector = (s) => s.transform;
const vpSizeSelector = (s) => ({ width: s.width, height: s.height });

function samePoint(a, b) {
  return a?.x === b?.x && a?.y === b?.y;
}

function sameStrokePreview(a, b) {
  if (a === b) return true;
  if ((a?.color || 'white') !== (b?.color || 'white')) return false;
  const aPts = strokePoints(a);
  const bPts = strokePoints(b);
  if (aPts.length !== bPts.length) return false;
  for (let i = 0; i < aPts.length; i++) {
    if (!samePoint(aPts[i], bPts[i])) return false;
  }
  return true;
}

const ReactiveMiniMapSVG = React.memo(({ cMinX, cMinY, cMaxX, cMaxY, isAnimating, children }) => {
  const transform = useStore(vpTransformSelector);
  const size = useStore(vpSizeSelector);
  const { setViewport } = useReactFlow();
  const svgRef = useRef(null);

  const vpZoom = transform[2];
  const vpFlowX = -transform[0] / vpZoom;
  const vpFlowY = -transform[1] / vpZoom;
  const vpFlowW = size.width / vpZoom;
  const vpFlowH = size.height / vpZoom;

  const minX = Math.min(cMinX, vpFlowX - CONTENT_PAD);
  const minY = Math.min(cMinY, vpFlowY - CONTENT_PAD);
  const maxX = Math.max(cMaxX, vpFlowX + vpFlowW + CONTENT_PAD);
  const maxY = Math.max(cMaxY, vpFlowY + vpFlowH + CONTENT_PAD);
  const contentW = maxX - minX;
  const contentH = maxY - minY;

  const scale = Math.min(MINIMAP_W / contentW, MINIMAP_H / contentH);
  const offsetX = (MINIMAP_W - contentW * scale) / 2;
  const offsetY = (MINIMAP_H - contentH * scale) / 2;

  const handleClick = useCallback((e) => {
    if (isAnimating) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const fx = (mx - offsetX) / scale + minX;
    const fy = (my - offsetY) / scale + minY;
    
    setViewport(
      {
        x: size.width / 2 - fx * vpZoom,
        y: size.height / 2 - fy * vpZoom,
        zoom: vpZoom,
      },
      { duration: 300 }
    );
  }, [minX, minY, scale, offsetX, offsetY, setViewport, vpZoom, isAnimating, size.width, size.height]);

  return (
    <svg
      ref={svgRef}
      width={MINIMAP_W}
      height={MINIMAP_H}
      viewBox={`${minX} ${minY} ${contentW || MINIMAP_W} ${contentH || MINIMAP_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
      onClick={handleClick}
    >
      {children}
      <rect
        x={vpFlowX} y={vpFlowY}
        width={vpFlowW} height={vpFlowH}
        fill="rgba(255,255,255,0.04)"
        stroke="rgba(255,255,255,0.35)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        rx={6}
        style={{ pointerEvents: 'none' }}
      />
    </svg>
  );
});

export const CustomMiniMap = React.memo(function CustomMiniMap({ nodes, edges, drawings, isAnimating }) {
  // Only map what's actually on the canvas. Collapsed job-tree cards/groups are
  // flagged `hidden: true` (and NOT repositioned — computeLayoutPositions only
  // moves visible nodes), so without this filter the minimap keeps drawing them
  // at their last expanded spots and never reflects a collapse. React Flow's main
  // canvas hides them natively; the minimap must mirror that.
  const visibleNodes = useMemo(() => nodes.filter(n => !n.hidden), [nodes]);

  const { cMinX, cMinY, cMaxX, cMaxY } = useMemo(() => {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    visibleNodes.forEach(n => {
      const { w, h } = getNodeDims(n);
      mnX = Math.min(mnX, n.position.x);
      mnY = Math.min(mnY, n.position.y);
      mxX = Math.max(mxX, n.position.x + w);
      mxY = Math.max(mxY, n.position.y + h);
    });
    (drawings || []).forEach(stroke => {
      strokePoints(stroke).forEach(p => {
        mnX = Math.min(mnX, p.x); mnY = Math.min(mnY, p.y);
        mxX = Math.max(mxX, p.x); mxY = Math.max(mxY, p.y);
      });
    });
    if (!isFinite(mnX)) return { cMinX: -200, cMinY: -200, cMaxX: 200, cMaxY: 200, isEmpty: true };
    return { cMinX: mnX - CONTENT_PAD, cMinY: mnY - CONTENT_PAD, cMaxX: mxX + CONTENT_PAD, cMaxY: mxY + CONTENT_PAD, isEmpty: false };
  }, [visibleNodes, drawings]);

  const nodeById = useMemo(() => {
    const m = new Map();
    visibleNodes.forEach(n => m.set(n.id, n));
    return m;
  }, [visibleNodes]);

  const renderedContent = useMemo(() => (
    <>
          {/* ── Edges ────────────────────────────────────────────────── */}
          {edges.map(e => {
            const src = nodeById.get(e.source);
            const tgt = nodeById.get(e.target);
            if (!src || !tgt) return null;
            const sd = getNodeDims(src), td = getNodeDims(tgt);
            // Connect node CENTERS with a straight line. The old code drew from
            // the source's RIGHT edge to the target's LEFT edge, baking in a
            // left→right flow assumption. That's only true for the job-result
            // tree; when source cards fan in a circle around a hub, every
            // connector still left the hub's right side, so the minimap looked
            // like all cards hung off the right of the hub. Center-to-center is
            // direction-agnostic and matches the canvas for any layout. (Nodes
            // render on top of edges, so only the segment between boxes shows.)
            const sx = src.position.x + sd.w / 2;
            const sy = src.position.y + sd.h / 2;
            const tx = tgt.position.x + td.w / 2;
            const ty = tgt.position.y + td.h / 2;
            const d = `M${sx},${sy} L${tx},${ty}`;

            return (
              <path key={e.id}
                d={d}
                fill="none"
                stroke="rgba(168,85,247,0.50)" strokeWidth={2} vectorEffect="non-scaling-stroke"
                strokeDasharray="4,4"
              />
            );
          })}

          {/* ── Drawings (freehand strokes) ───────────────────────── */}
          {(drawings || []).map((stroke, i) => {
            const pts = strokePoints(stroke);
            if (pts.length < 2) return null;
            const color = stroke?.color || 'white';
            const pts2d = pts.map(p => `${p.x},${p.y}`).join(' ');
            return (
              <polyline key={i} points={pts2d} fill="none"
                stroke={color === 'white' ? 'rgba(255,255,255,0.50)' : color}
                strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* ── Nodes ────────────────────────────────────────────────── */}
          {visibleNodes.map(n => {
            const { w, h } = getNodeDims(n);
            return (
              <ThumbnailNode
                key={n.id}
                r={{ x: n.position.x, y: n.position.y, w, h, type: n.type, data: n.data }}
              />
            );
          })}
    </>
  ), [edges, nodeById, drawings, visibleNodes]);

  return (
    <Panel position="bottom-right" style={{ margin: 8, zIndex: 200 }}>
      <div
        style={{
          width: MINIMAP_W,
          height: MINIMAP_H,
          background: '#1a1a1a',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8,
          overflow: 'hidden',
          cursor: 'crosshair',
        }}
      >
        <ReactiveMiniMapSVG
          cMinX={cMinX}
          cMinY={cMinY}
          cMaxX={cMaxX}
          cMaxY={cMaxY}
          isAnimating={isAnimating}
        >
          {renderedContent}
        </ReactiveMiniMapSVG>
      </div>
    </Panel>
  );
}, (prev, next) => {
  if (prev.isAnimating !== next.isAnimating) return false;
  if (prev.nodes.length !== next.nodes.length) return false;
  if (prev.edges.length !== next.edges.length) return false;
  if ((prev.drawings || []).length !== (next.drawings || []).length) return false;
  
  const prevDrawings = prev.drawings || [];
  const nextDrawings = next.drawings || [];
  for (let i = 0; i < prevDrawings.length; i++) {
    if (!sameStrokePreview(prevDrawings[i], nextDrawings[i])) return false;
  }

  // Custom check: only re-render if nodes' coordinates or data have meaningfully changed
  for (let i = 0; i < prev.nodes.length; i++) {
    const p = prev.nodes[i];
    const n = next.nodes[i];
    if (p.id !== n.id) return false;
    if (!!p.hidden !== !!n.hidden) return false; // collapse/expand toggles visibility — must re-render
    if (p.data !== n.data) return false; // Text, label, or color changed
    if (p.measured?.width !== n.measured?.width || p.measured?.height !== n.measured?.height) return false;
    if (p.style?.width !== n.style?.width || p.style?.height !== n.style?.height) return false;
    
    // Don't re-render for ultra-micro positional changes to save SVG compute
    if (Math.abs(p.position.x - n.position.x) > 2) return false;
    if (Math.abs(p.position.y - n.position.y) > 2) return false;
  }
  return true;
});
