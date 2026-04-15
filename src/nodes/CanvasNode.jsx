import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Lock, X } from 'lucide-react';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { EventLogger } from '../utils/EventLogger';

const MIN_SIZE    = 80;
const MAX_SIZE    = 600;
const DEFAULT_SIZE = 160;
const EDGE_ZONE   = 12; // screen-px from circle edge that activates resize cursor

export const CanvasNode = React.memo(function CanvasNode({ id, data, selected, width, height }) {
  const SIZE = Math.round(width || DEFAULT_SIZE);
  const R    = SIZE / 2;
  const mainFlow = useReactFlow();

  const [title, setTitle]                 = useState(data.title || '');
  const [isEditing, setIsEditing]         = useState(false);
  const [showFontDialog, setShowFontDialog] = useState(false);
  const [edgeCursorStyle, setEdgeCursorStyle] = useState(null);
  // isResizing state = visual signal only (hint text, etc.)
  // isResizingRef = synchronous flag used inside pointer handlers (no re-render lag)
  const [isResizing, setIsResizing]       = useState(false);
  const isResizingRef   = useRef(false);
  const resizeCenterRef = useRef(null); // { flowCx, flowCy }
  const inputRef        = useRef(null);
  const containerRef    = useRef(null);
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

  // Font & Size dialog trigger (from context menu)
  useEffect(() => {
    const handleOpenFont = () => { if (!data.locked) setShowFontDialog(true); };
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id, data.locked]);

  // ── Continuously-rotating SVG resize cursor ───────────────────────────────
  const getResizeCursor = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 'ew-resize';
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const angleDeg = Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
    // +90° so the double-headed arrow points radially (toward/away from center)
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><g transform='rotate(${(angleDeg + 90).toFixed(1)},10,10)' stroke-linecap='round' stroke-linejoin='round'><path d='M10 2L10 18M7 5L10 2L13 5M7 15L10 18L13 15' stroke='black' stroke-width='3.5' fill='none'/><path d='M10 2L10 18M7 5L10 2L13 5M7 15L10 18L13 15' stroke='white' stroke-width='2' fill='none'/></g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, ew-resize`;
  }, []);

  const getDistToEdge = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return Infinity;
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    return Math.abs(Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2) - rect.width / 2);
  }, []);

  // ── Pointer handlers (pointer-capture approach — no useEffect race condition) ─
  //
  // setPointerCapture ensures the element receives ALL pointermove/pointerup
  // events even if the pointer leaves the element bounds, and fires them
  // synchronously in the same event loop (no React re-render gap).

  const handleContainerPointerDown = useCallback((e) => {
    if (data.locked) return;
    // Edge check FIRST — resize takes priority over click-to-edit.
    if (getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE) {
      e.stopPropagation();
      if (isEditing) {
        mainFlow.updateNodeData(id, { title: title.trim() });
        setIsEditing(false);
      }
      // Capture all subsequent pointer events on this element (even outside bounds).
      containerRef.current?.setPointerCapture(e.pointerId);
      // Measure screen center from DOM → convert to flow coords.
      // Using the DOM rect avoids any stale React prop / store values.
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const screenCx = rect.left + rect.width  / 2;
      const screenCy = rect.top  + rect.height / 2;
      const fc = mainFlow.screenToFlowPosition({ x: screenCx, y: screenCy });
      resizeCenterRef.current = { flowCx: fc.x, flowCy: fc.y };
      isResizingRef.current = true;
      setIsResizing(true);
      EventLogger.log(`canvas-node resize start id=${id} size=${SIZE}`);
    }
  }, [data.locked, getDistToEdge, isEditing, mainFlow, id, title, SIZE]);

  const handleContainerPointerMove = useCallback((e) => {
    // ── Active resize ─────────────────────────────────────────────────────
    if (isResizingRef.current && resizeCenterRef.current) {
      const { flowCx, flowCy } = resizeCenterRef.current;
      const fp = mainFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const flowDist = Math.sqrt((fp.x - flowCx) ** 2 + (fp.y - flowCy) ** 2);
      const newSize  = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, flowDist * 2)));
      mainFlow.setNodes(nds => nds.map(n =>
        n.id === id ? {
          ...n,
          position: { x: flowCx - newSize / 2, y: flowCy - newSize / 2 },
          width:  newSize,
          height: newSize,
          style:  { ...(n.style || {}), width: newSize, height: newSize },
        } : n
      ));
      setEdgeCursorStyle(getResizeCursor(e.clientX, e.clientY));
      return;
    }
    // ── Hover: update edge cursor ─────────────────────────────────────────
    const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
    setEdgeCursorStyle(near ? getResizeCursor(e.clientX, e.clientY) : null);
  }, [id, mainFlow, getResizeCursor, getDistToEdge]);

  const handleContainerPointerUp = useCallback((e) => {
    if (!isResizingRef.current) return;
    containerRef.current?.releasePointerCapture(e.pointerId);
    isResizingRef.current = false;
    resizeCenterRef.current = null;
    setIsResizing(false);
    EventLogger.log(`canvas-node resize end id=${id}`);
    // Restore hover cursor
    const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
    setEdgeCursorStyle(near ? getResizeCursor(e.clientX, e.clientY) : null);
  }, [id, getDistToEdge, getResizeCursor]);

  // ── Derived values ────────────────────────────────────────────────────────
  const canvasData = data.canvasData || {
    nodes: data.nodes || [], edges: data.edges || [], drawings: data.drawings || [],
  };
  const nodeCount    = canvasData.nodes?.length || 0;
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

  const arcPath   = `M 0,${R} A ${R},${R} 0 0,1 ${SIZE},${R}`;
  const titleFill = textColor ?? (title ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.22)');
  const edgeCursor = edgeCursorStyle || undefined;

  return (
    <>
      <div
        ref={containerRef}
        className="group"
        style={{ width: SIZE, height: SIZE, position: 'relative', cursor: edgeCursor }}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handleContainerPointerUp}
        onPointerLeave={() => { if (!isResizingRef.current) setEdgeCursorStyle(null); }}
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

        {/* ── Curved title — always visible, turns blue while editing ──────── */}
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

        {/* ── Title edit click zone ─────────────────────────────────────────── */}
        {/* Positioned at the exact location of the arc text so the text cursor  */}
        {/* only appears when hovering directly over the title glyphs.            */}
        {/* dy={-titleSpacing} moves the text UP by titleSpacing from the arc     */}
        {/* bottom (y = SIZE). Estimated width from title length × font size.      */}
        {!isEditing && !data.locked && (() => {
          const titleText = title || 'Sub-Canvas';
          const estWidth  = Math.min(SIZE * 0.88, Math.max(56, titleText.length * fontSize * 0.58 + 12));
          const zoneTop   = SIZE - titleSpacing - fontSize - 4;
          return (
            <div
              style={{
                position: 'absolute',
                top:    zoneTop,
                left:   (SIZE - estWidth) / 2,
                width:  estWidth,
                height: fontSize + 10,
                cursor: 'text',
                zIndex: 15,
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setIsEditing(true); }}
              onDoubleClick={e => e.stopPropagation()}
            />
          );
        })()}

        {/* ── Transparent input overlay — only the caret is visible ────────── */}
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
                background:  'transparent',
                color:       'transparent',
                caretColor:  'rgba(96, 165, 250, 0.95)',
                border:      'none',
                outline:     'none',
                width:       '100%',
                textAlign:   'center',
                fontSize:    `${fontSize}px`,
                fontFamily,
                padding:     0,
                cursor:      'text',
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
