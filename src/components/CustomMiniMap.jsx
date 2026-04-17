import React, { useMemo, useRef, useCallback } from 'react';
import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { MINIMAP_NODE_COLORS } from '../utils/constants';

const MINIMAP_W = 200;
const MINIMAP_H = 140;
const CONTENT_PAD = 40;

/** Default dimensions per node type (matches CanvasThumbnail) */
const NODE_DIMS = {
  text:     { w: 180, h: 36  },
  link:     { w: 180, h: 50  },
  document: { w: 180, h: 36  },
  group:    { w: 160, h: 160 },
  listing:  { w: 240, h: 180 },
  jobcard:  { w: 180, h: 90  },
  jobhub:   { w: 280, h: 350 },
  sellhub:  { w: 280, h: 350 },
};

function getNodeDims(node) {
  return {
    w: node.measured?.width  || node.style?.width  || NODE_DIMS[node.type]?.w || 120,
    h: node.measured?.height || node.style?.height || NODE_DIMS[node.type]?.h || 40,
  };
}

/**
 * Custom SVG mini-map that renders actual node content (text preview, link labels,
 * nested canvas circles) and freehand drawing strokes. Supports click-to-pan.
 *
 * Rendered inside ReactFlow so it has access to useViewport / useReactFlow.
 */
const vpTransformSelector = (s) => s.transform;
const vpSizeSelector = (s) => ({ width: s.width, height: s.height });

const ViewportIndicator = React.memo(({ scale, minX, minY, offsetX, offsetY }) => {
  const transform = useStore(vpTransformSelector);
  const size = useStore(vpSizeSelector);

  const vpZoom = transform[2];
  const vpFlowX = -transform[0] / vpZoom;
  const vpFlowY = -transform[1] / vpZoom;
  const vpFlowW = size.width / vpZoom;
  const vpFlowH = size.height / vpZoom;

  const x = (vpFlowX - minX) * scale + offsetX;
  const y = (vpFlowY - minY) * scale + offsetY;
  const w = vpFlowW * scale;
  const h = vpFlowH * scale;

  return (
    <rect
      x={x} y={y}
      width={w} height={h}
      fill="rgba(255,255,255,0.04)"
      stroke="rgba(255,255,255,0.35)"
      strokeWidth={1}
      rx={1}
      style={{ pointerEvents: 'none' }}
    />
  );
});

export const CustomMiniMap = React.memo(function CustomMiniMap({ nodes, edges, drawings, isAnimating }) {
  const { setViewport, getViewport } = useReactFlow();
  const svgRef = useRef(null);

  // ── Part A: content bounds (memo on nodes + drawings only) ──────────────
  const { cMinX, cMinY, cMaxX, cMaxY } = useMemo(() => {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    nodes.forEach(n => {
      const { w, h } = getNodeDims(n);
      mnX = Math.min(mnX, n.position.x);
      mnY = Math.min(mnY, n.position.y);
      mxX = Math.max(mxX, n.position.x + w);
      mxY = Math.max(mxY, n.position.y + h);
    });
    (drawings || []).forEach(stroke => {
      const pts = Array.isArray(stroke) ? stroke : stroke?.points;
      if (!Array.isArray(pts)) return;
      pts.forEach(p => {
        mnX = Math.min(mnX, p.x); mnY = Math.min(mnY, p.y);
        mxX = Math.max(mxX, p.x); mxY = Math.max(mxY, p.y);
      });
    });
    if (!isFinite(mnX)) return { cMinX: -200, cMinY: -200, cMaxX: 200, cMaxY: 200, isEmpty: true };
    return { cMinX: mnX - CONTENT_PAD, cMinY: mnY - CONTENT_PAD, cMaxX: mxX + CONTENT_PAD, cMaxY: mxY + CONTENT_PAD, isEmpty: false };
  }, [nodes, drawings]);

  // ── Part A2: O(1) node lookup by id ─────────────────────────────────────
  const nodeById = useMemo(() => {
    const m = new Map();
    nodes.forEach(n => m.set(n.id, n));
    return m;
  }, [nodes]);

  // ── Part B: display bounds (fixed arbitrary vpFlow overlay for scale math)
  // We use current viewport for scaling but we don't react to it continuously.
  const currentVp = getViewport();
  const vpFlowX = -currentVp.x / currentVp.zoom;
  const vpFlowY = -currentVp.y / currentVp.zoom;
  const vpFlowW = window.innerWidth / currentVp.zoom;
  const vpFlowH = window.innerHeight / currentVp.zoom;

  const minX = Math.min(cMinX, vpFlowX - CONTENT_PAD);
  const minY = Math.min(cMinY, vpFlowY - CONTENT_PAD);
  const maxX = Math.max(cMaxX, vpFlowX + vpFlowW + CONTENT_PAD);
  const maxY = Math.max(cMaxY, vpFlowY + vpFlowH + CONTENT_PAD);
  const contentW = maxX - minX;
  const contentH = maxY - minY;

  // ── Scale to fit minimap while preserving aspect ratio ───────────────────
  const scale = Math.min(MINIMAP_W / contentW, MINIMAP_H / contentH);
  // Center content within the minimap rectangle
  const offsetX = (MINIMAP_W - contentW * scale) / 2;
  const offsetY = (MINIMAP_H - contentH * scale) / 2;

  /** Convert a flow-space coordinate to minimap-pixel coordinate */
  const toM = useCallback((fx, fy) => ({
    x: (fx - minX) * scale + offsetX,
    y: (fy - minY) * scale + offsetY,
  }), [minX, minY, scale, offsetX, offsetY]);

  // ── Click-to-pan ──────────────────────────────────────────────────────────
  const handleClick = useCallback((e) => {
    if (isAnimating) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Minimap pixel → flow coordinate
    const fx = (mx - offsetX) / scale + minX;
    const fy = (my - offsetY) / scale + minY;
    // Center that flow point in the screen
    const liveVp = getViewport();
    setViewport(
      {
        x: window.innerWidth  / 2 - fx * liveVp.zoom,
        y: window.innerHeight / 2 - fy * liveVp.zoom,
        zoom: liveVp.zoom,
      },
      { duration: 300 }
    );
  }, [minX, minY, scale, offsetX, offsetY, setViewport, getViewport, isAnimating]);

  // ── Render ────────────────────────────────────────────────────────────────
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
        <svg
          ref={svgRef}
          width={MINIMAP_W}
          height={MINIMAP_H}
          style={{ display: 'block' }}
          onClick={handleClick}
        >
          {/* ── Edges ────────────────────────────────────────────────── */}
          {edges.map(e => {
            const src = nodeById.get(e.source);
            const tgt = nodeById.get(e.target);
            if (!src || !tgt) return null;
            const sd = getNodeDims(src), td = getNodeDims(tgt);
            const p1 = toM(src.position.x + sd.w / 2, src.position.y + sd.h / 2);
            const p2 = toM(tgt.position.x + td.w / 2, tgt.position.y + td.h / 2);
            return (
              <line key={e.id}
                x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                stroke="rgba(168,85,247,0.30)" strokeWidth={1}
              />
            );
          })}

          {/* ── Drawings (freehand strokes) ───────────────────────── */}
          {(drawings || []).map((stroke, i) => {
            const pts = Array.isArray(stroke) ? stroke : stroke?.points;
            if (!Array.isArray(pts) || pts.length < 2) return null;
            const color = stroke?.color || 'white';
            const pts2d = pts.map(p => { const m = toM(p.x, p.y); return `${m.x},${m.y}`; }).join(' ');
            return (
              <polyline key={i} points={pts2d} fill="none"
                stroke={color === 'white' ? 'rgba(255,255,255,0.50)' : color}
                strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
              />
            );
          })}

          {/* ── Nodes ────────────────────────────────────────────────── */}
          {nodes.map(n => {
            const { w, h } = getNodeDims(n);
            const pos = toM(n.position.x, n.position.y);
            const mw  = Math.max(w * scale, 3);
            const mh  = Math.max(h * scale, 3);

            if (n.type === 'text') {
              const raw     = (n.data?.text || '').replace(/[#*_`>|[\]]/g, '').trim();
              const preview = raw.slice(0, 28);
              const bg      = n.data?.isSticky ? 'rgba(254,243,199,0.45)' : 'rgba(255,255,255,0.07)';
              const fill    = n.data?.isSticky
                ? 'rgba(30,30,30,0.85)'
                : (n.data?.textColor || 'rgba(255,255,255,0.75)');
              const fontFam = n.data?.fontFamily || 'sans-serif';
              const fs      = Math.max(4, Math.min(mh * 0.65, 7));
              return (
                <g key={n.id}>
                  <rect x={pos.x} y={pos.y} width={mw} height={mh} rx={2} fill={bg} />
                  {preview && (
                    <text x={pos.x + 2} y={pos.y + fs + 1} fontSize={fs} fill={fill}
                      fontFamily={fontFam} style={{ pointerEvents: 'none' }}>
                      {preview}
                    </text>
                  )}
                </g>
              );
            }

            if (n.type === 'link') {
              const label   = (n.data?.label || n.data?.url || '').slice(0, 22);
              const fs      = Math.max(4, Math.min(mh * 0.65, 7));
              const fill    = n.data?.textColor || 'rgba(96,165,250,0.85)';
              const fontFam = n.data?.fontFamily || 'sans-serif';
              return (
                <g key={n.id}>
                  <rect x={pos.x} y={pos.y} width={mw} height={mh} rx={2}
                    fill="rgba(96,165,250,0.15)" stroke="rgba(96,165,250,0.50)" strokeWidth={0.5} />
                  {label && (
                    <text x={pos.x + 2} y={pos.y + fs + 1} fontSize={fs}
                      fill={fill} fontFamily={fontFam}
                      style={{ pointerEvents: 'none' }}>
                      ↗ {label}
                    </text>
                  )}
                </g>
              );
            }

            if (n.type === 'group') {
              const r  = Math.max(Math.min(mw, mh) / 2, 2);
              const cx = pos.x + mw / 2;
              const cy = pos.y + mh / 2;
              const fs = Math.max(4, r * 0.3);
              const titleColor  = n.data?.textColor  || 'rgba(255,255,255,0.55)';
              const titleFamily = n.data?.fontFamily || 'sans-serif';
              const maxChars    = Math.max(4, Math.floor((r * 1.8) / (fs * 0.6)));
              const label = n.data?.title
                ? (n.data.title.length > maxChars ? n.data.title.slice(0, maxChars - 1) + '…' : n.data.title)
                : null;
              return (
                <g key={n.id}>
                  <circle cx={cx} cy={cy} r={r}
                    fill="rgba(96,165,250,0.08)" stroke="rgba(96,165,250,0.50)" strokeWidth={0.5} />
                  {label && r > 6 && (
                    <text x={cx} y={cy} fontSize={fs}
                      fill={titleColor} textAnchor="middle" dominantBaseline="middle"
                      fontFamily={titleFamily} fontWeight="500"
                      style={{ pointerEvents: 'none' }}>
                      {label}
                    </text>
                  )}
                </g>
              );
            }

            if (n.type === 'document') {
              return (
                <rect key={n.id} x={pos.x} y={pos.y} width={mw} height={mh} rx={2}
                  fill="rgba(251,191,36,0.25)" stroke="rgba(251,191,36,0.50)" strokeWidth={0.5} />
              );
            }

            // Fallback — use the minimap colour palette
            return (
              <rect key={n.id} x={pos.x} y={pos.y} width={mw} height={mh} rx={2}
                fill={MINIMAP_NODE_COLORS[n.type] || '#555'} opacity={0.70} />
            );
          })}

          <ViewportIndicator scale={scale} minX={minX} minY={minY} offsetX={offsetX} offsetY={offsetY} />
        </svg>
      </div>
    </Panel>
  );
}, (prev, next) => {
  if (prev.isAnimating !== next.isAnimating) return false;
  if (prev.nodes.length !== next.nodes.length) return false;
  if (prev.edges.length !== next.edges.length) return false;
  if ((prev.drawings || []).length !== (next.drawings || []).length) return false;
  
  // Custom check: only re-render if nodes' coordinates or data have meaningfully changed
  for (let i = 0; i < prev.nodes.length; i++) {
    const p = prev.nodes[i];
    const n = next.nodes[i];
    if (p.id !== n.id) return false;
    if (p.data !== n.data) return false; // Text, label, or color changed
    if (p.measured?.width !== n.measured?.width || p.measured?.height !== n.measured?.height) return false;
    if (p.style?.width !== n.style?.width || p.style?.height !== n.style?.height) return false;
    
    // Don't re-render for ultra-micro positional changes to save SVG compute
    if (Math.abs(p.position.x - n.position.x) > 2) return false;
    if (Math.abs(p.position.y - n.position.y) > 2) return false;
  }
  return true;
});
