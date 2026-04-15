import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Lock, X } from 'lucide-react';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { FontSizeDialog } from '../components/FontSizeDialog';

const MIN_SIZE = 80;
const MAX_SIZE = 600;
const DEFAULT_SIZE = 160;
const EDGE_ZONE = 12; // screen-px from circle edge that activates resize cursor

export const CanvasNode = React.memo(function CanvasNode({ id, data, selected, width, height }) {
  const SIZE = Math.round(width || DEFAULT_SIZE);
  const R    = SIZE / 2;
  const mainFlow = useReactFlow();
  const [title, setTitle]           = useState(data.title || '');
  const [isEditing, setIsEditing]   = useState(false);
  const [showFontDialog, setShowFontDialog] = useState(false);
  const [edgeCursorStyle, setEdgeCursorStyle] = useState(null); // null | CSS cursor string
  const [isResizing, setIsResizing] = useState(false);
  const inputRef        = useRef(null);
  const containerRef    = useRef(null);
  const resizeCenterRef = useRef(null); // { flowCx, flowCy }
  const pathId = `tcp-${id}`;

  useEffect(() => { setTitle(data.title || ''); }, [data.title]);

  useEffect(() => {
    if (data.isNew) {
      setIsEditing(true);
      mainFlow.updateNodeData(id, { isNew: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isEditing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [isEditing]);

  // Font & Size dialog trigger
  useEffect(() => {
    const handleOpenFont = () => { if (!data.locked) setShowFontDialog(true); };
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id, data.locked]);

  // ── Continuously-rotating SVG cursor that always points radially toward center ─
  const getResizeCursor = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 'ew-resize';
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const angleDeg = Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
    // Double-headed arrow SVG rotated to the exact radial angle
    // +90° because the SVG arrow is vertical by default; rotating by angleDeg alone
    // would make it tangent to the circle. Adding 90° makes it point radially (toward center).
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><g transform='rotate(${(angleDeg + 90).toFixed(1)},10,10)' stroke-linecap='round' stroke-linejoin='round'><path d='M10 2L10 18M7 5L10 2L13 5M7 15L10 18L13 15' stroke='black' stroke-width='3.5' fill='none'/><path d='M10 2L10 18M7 5L10 2L13 5M7 15L10 18L13 15' stroke='white' stroke-width='2' fill='none'/></g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, ew-resize`;
  }, []);

  // ── Custom edge resize via window listeners ────────────────────────────────
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e) => {
      if (!resizeCenterRef.current) return;
      const { flowCx, flowCy } = resizeCenterRef.current;
      const fp = mainFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const flowDist = Math.sqrt((fp.x - flowCx) ** 2 + (fp.y - flowCy) ** 2);
      const newSize = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, flowDist * 2)));
      mainFlow.setNodes(nds => nds.map(n =>
        n.id === id ? {
          ...n,
          position: { x: flowCx - newSize / 2, y: flowCy - newSize / 2 },
          width: newSize,
          height: newSize,
          style: { ...(n.style || {}), width: newSize, height: newSize },
        } : n
      ));
      // Keep cursor direction updating during resize
      setEdgeCursorStyle(getResizeCursor(e.clientX, e.clientY));
    };
    const onUp = () => { setIsResizing(false); resizeCenterRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
    };
  }, [isResizing, id, mainFlow, getResizeCursor]);

  const getDistToEdge = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return Infinity;
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    return Math.abs(Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2) - rect.width / 2);
  }, []);

  const handleContainerMouseMove = useCallback((e) => {
    if (isResizing) return;
    const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
    setEdgeCursorStyle(near ? getResizeCursor(e.clientX, e.clientY) : null);
  }, [isResizing, getDistToEdge, getResizeCursor]);

  const handleContainerPointerDown = useCallback((e) => {
    if (data.locked) return;
    // Check edge FIRST — resize takes priority over editing so the initial-drop
    // auto-editing state never blocks the resize gesture.
    if (getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE) {
      e.stopPropagation();
      // Commit any in-progress title edit before resizing
      if (isEditing) {
        mainFlow.updateNodeData(id, { title: title.trim() });
        setIsEditing(false);
      }
      const node = mainFlow.getNode(id);
      if (!node) return;
      resizeCenterRef.current = {
        flowCx: node.position.x + SIZE / 2,
        flowCy: node.position.y + SIZE / 2,
      };
      setIsResizing(true);
    }
  }, [data.locked, getDistToEdge, isEditing, mainFlow, id, title, SIZE]);

  const canvasData = data.canvasData || {
    nodes: data.nodes || [], edges: data.edges || [], drawings: data.drawings || [],
  };
  const nodeCount = canvasData.nodes?.length || 0;

  const fontSize     = data.fontSize     || 11;
  const fontFamily   = data.fontFamily   || 'Inter, ui-sans-serif, system-ui, sans-serif';
  const textColor    = data.textColor    || null;
  const titleSpacing = data.titleSpacing ?? 0;

  const commitTitle = useCallback((val) => {
    const v = (val ?? title).trim();
    setTitle(v);
    mainFlow.updateNodeData(id, { title: v });
    setIsEditing(false);
  }, [id, mainFlow, title]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    mainFlow.deleteElements({ nodes: [{ id }] });
  }, [id, mainFlow]);

  const arcPath  = `M 0,${R} A ${R},${R} 0 0,1 ${SIZE},${R}`;
  const titleFill = textColor ?? (title ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.22)');
  const edgeCursor = edgeCursorStyle || undefined;

  return (
    <>
      <div
        ref={containerRef}
        className="group"
        style={{ width: SIZE, height: SIZE, position: 'relative', cursor: edgeCursor }}
        onMouseMove={handleContainerMouseMove}
        onMouseLeave={() => { if (!isResizing) setEdgeCursorStyle(null); }}
        onPointerDown={handleContainerPointerDown}
      >
        {/* ── Circle body ──────────────────────────────────────────────────── */}
        <div
          style={{
            position:        'absolute',
            inset:           0,
            borderRadius:    '50%',
            overflow:        'hidden',
            border:          isEditing
              ? '2px solid rgba(96,165,250,0.70)'
              : selected
                ? '2px solid rgba(96,165,250,0.85)'
                : '2px solid rgba(255,255,255,0.10)',
            backgroundColor: data.backgroundColor || 'rgba(12,12,18,0.97)',
            boxShadow:       isEditing
              ? '0 0 0 3px rgba(96,165,250,0.15), 0 8px 40px rgba(0,0,0,0.65)'
              : selected
                ? '0 0 0 4px rgba(96,165,250,0.15), 0 8px 40px rgba(0,0,0,0.65)'
                : '0 4px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)',
            cursor: edgeCursor || 'pointer',
          }}
        >
          <CanvasThumbnail canvasData={canvasData} width="100%" height="100%" />
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.35) 100%)',
          }} />
          {!data.locked && !isResizing && !isEditing && (
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-all
                            bg-black/0 group-hover:bg-black/45 flex items-center justify-center
                            pointer-events-none">
              <span className="text-[9px] text-white/90 bg-black/60 rounded-full px-2 py-0.5
                               backdrop-blur-sm font-medium tracking-wide">
                Double-click to open
              </span>
            </div>
          )}
          {nodeCount > 0 && (
            <span className="absolute top-3 right-3 bg-blue-500/90 text-white text-[9px] font-bold
                             rounded-full min-w-[16px] h-[16px] px-1 flex items-center justify-center shadow-md">
              {nodeCount}
            </span>
          )}
          {data.locked && (
            <div className="absolute top-3 right-3 bg-black/70 rounded-full p-1 text-white/60 backdrop-blur-sm">
              <Lock size={9} />
            </div>
          )}
        </div>

        {/* ── Curved title — always visible, updates live during edit ──────── */}
        <svg width={SIZE} height={SIZE} style={{
          position: 'absolute', inset: 0, overflow: 'visible',
          pointerEvents: 'none', zIndex: 10,
        }}>
          <defs><path id={pathId} d={arcPath} /></defs>
          <text
            fontSize={fontSize}
            fontFamily={fontFamily}
            fontWeight="500"
            letterSpacing="0.5"
            dy={-titleSpacing}
            fill={isEditing ? 'rgba(96,165,250,0.90)' : titleFill}
          >
            <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
              {title || 'Sub-Canvas'}
            </textPath>
          </text>
        </svg>

        {/* ── Title edit click zone — parallel arc at the text's actual radius ──────── */}
        {!isEditing && !data.locked && (() => {
          // The text sits on arcPath (radius R) with dy={-titleSpacing}.
          // dy is perpendicular-outward from the arc, so the text lives on a
          // parallel arc at radius R + titleSpacing from the circle centre.
          const clickR   = Math.max(R + titleSpacing, 4);
          const clickArcD = `M ${R - clickR},${R} A ${clickR},${clickR} 0 0,1 ${R + clickR},${R}`;
          // Stroke width = just enough to cover the glyph height, nothing more
          const clickSW  = Math.max(fontSize + 4, 14);
          return (
            <svg
              width={SIZE}
              height={SIZE}
              style={{ position: 'absolute', inset: 0, overflow: 'visible', zIndex: 15 }}
            >
              <path
                d={clickArcD}
                fill="none"
                stroke="transparent"
                strokeWidth={clickSW}
                pointerEvents="stroke"
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); setIsEditing(true); }}
                onDoubleClick={e => e.stopPropagation()}
                style={{ cursor: 'text' }}
              />
            </svg>
          );
        })()}

        {/* ── Transparent input overlay — sits over the arc, only caret is visible ── */}
        {isEditing && (
          <div
            style={{
              position: 'absolute',
              top: -(Math.max(fontSize, 14) + titleSpacing + 2),
              left: 0, width: SIZE, zIndex: 20,
            }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={e  => commitTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter')  commitTitle(e.target.value);
                if (e.key === 'Escape') { setTitle(data.title || ''); setIsEditing(false); }
              }}
              placeholder="Sub-Canvas"
              style={{
                background: 'transparent',
                color: 'transparent',
                caretColor: 'rgba(96, 165, 250, 0.95)',
                border: 'none',
                outline: 'none',
                width: '100%',
                textAlign: 'center',
                fontSize: `${fontSize}px`,
                fontFamily,
                padding: 0,
                cursor: 'text',
              }}
            />
          </div>
        )}

        {/* ── Delete button ─────────────────────────────────────────────────── */}
        {!data.locked && (
          <button
            onClick={handleDelete}
            onPointerDown={e => e.stopPropagation()}
            title="Delete canvas"
            style={{ position: 'absolute', top: -6, left: -6, zIndex: 10 }}
            className="w-5 h-5 rounded-full flex items-center justify-center
                       bg-black/60 text-white/0 group-hover:text-white/60
                       hover:!text-red-400 hover:!bg-red-900/70
                       opacity-0 group-hover:opacity-100
                       transition-all backdrop-blur-sm border border-white/10"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {showFontDialog && (
        <FontSizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={data.textColor || '#ffffff'}
          titleSpacing={titleSpacing}
          onApply={({ fontSize: fs, fontFamily: ff, textColor: tc, titleSpacing: ts }) =>
            mainFlow.updateNodeData(id, { fontSize: fs, fontFamily: ff, textColor: tc, titleSpacing: ts })
          }
          onClose={() => setShowFontDialog(false)}
        />
      )}

      <Handle type="target" position={Position.Left}  id="canvas-target" className="opacity-0" />
      <Handle type="source" position={Position.Right} id="canvas-source" className="opacity-0" />
    </>
  );
});
