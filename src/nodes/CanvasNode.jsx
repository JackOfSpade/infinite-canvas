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
  // currentSize is updated both from the width prop (via useEffect) AND synchronously
  // during active resize so SIZE is always fresh without waiting for ResizeObserver.
  const [currentSize, setCurrentSize] = useState(() => Math.round(width || DEFAULT_SIZE));
  useEffect(() => { setCurrentSize(Math.round(width || DEFAULT_SIZE)); }, [width]);
  const SIZE = currentSize;
  const R    = SIZE / 2;
  const mainFlow = useReactFlow();

  const [title, setTitle]                   = useState(data.title || '');
  const [isEditing, setIsEditing]           = useState(false);
  const [showFontDialog, setShowFontDialog] = useState(false);
  const [edgeCursorStyle, setEdgeCursorStyle] = useState(null);
  const [isResizing, setIsResizing]         = useState(false);

  // Synchronous refs — read inside native pointer handlers without re-render lag
  const isResizingRef   = useRef(false);
  const resizeCenterRef = useRef(null);  // { flowCx, flowCy }
  const resizeMoveCount = useRef(0);     // pointermove count per session (0 = phantom RF drag)

  const inputRef     = useRef(null);
  const containerRef = useRef(null);
  const pathId = `tcp-${id}`;

  // liveRef gives the stable native-listener useEffect access to values that
  // change between renders (isEditing, title, data, SIZE) without needing to
  // re-register the listeners every render.
  const liveRef = useRef(null);
  liveRef.current = { isEditing, title, data, SIZE };

  // Keep the EventLogger registry up-to-date so bug reports show React
  // component state (isEditing, isResizing, edgeCursorStyle) per node.
  useEffect(() => {
    EventLogger.registerNodeState(id, {
      isEditing,
      isResizing,
      hasEdgeCursor: !!edgeCursorStyle,
      size: SIZE,
    });
  }, [id, isEditing, isResizing, edgeCursorStyle, SIZE]);

  useEffect(() => {
    return () => EventLogger.unregisterNodeState(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  // ── Native pointer listeners ──────────────────────────────────────────────
  //
  // WHY NATIVE instead of React onPointerXxx props:
  //
  // ReactFlow adds its node-drag handler as a native addEventListener on the
  // node wrapper div (parent of our container). Native listeners on a PARENT
  // element fire AFTER the event has already bubbled through child elements,
  // BUT React synthetic events use delegation at the React root — they fire
  // even later, after the entire bubble chain. This means:
  //
  //   pointerdown fires → bubbles → RF's native handler on wrapper fires → drag starts
  //                     → reaches React root → our synthetic onPointerDown fires
  //                     → e.stopPropagation() → too late, RF already started the drag
  //
  // By attaching native listeners to OUR inner div, our handler fires BEFORE
  // the event reaches RF's wrapper. e.stopPropagation() here actually works.
  //
  // For the title zone: data-no-resize="true" on child elements lets us skip
  // resize initiation without relying on React synthetic stopPropagation.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onDown = (e) => {
      // Let interactive children (title zone, delete button) handle their own clicks.
      if (e.target.closest('[data-no-resize]')) return;

      if (liveRef.current.data.locked) return;

      const dist = getDistToEdge(e.clientX, e.clientY);
      if (dist < EDGE_ZONE) {
        // ── NATIVE stopPropagation ────────────────────────────────────────
        // This fires before the event bubbles to RF's wrapper div native
        // listener. RF never sees this pointerdown → no drag tracking starts.
        e.stopPropagation();

        if (liveRef.current.isEditing) {
          mainFlow.updateNodeData(id, { title: liveRef.current.title.trim() });
          setIsEditing(false);
        }

        el.setPointerCapture(e.pointerId);

        // Read center from Zustand store — always synchronous and up-to-date.
        const node = mainFlow.getNode(id);
        if (!node) return;
        const liveSize = node.style?.width || node.measured?.width || node.width || DEFAULT_SIZE;
        resizeCenterRef.current = {
          flowCx: node.position.x + liveSize / 2,
          flowCy: node.position.y + liveSize / 2,
        };
        isResizingRef.current = true;
        resizeMoveCount.current = 0;
        setIsResizing(true);
        EventLogger.log(`canvas-node resize start id=${id} size=${liveRef.current.SIZE} distToEdge=${dist.toFixed(1)}`);
      }
    };

    const onMove = (e) => {
      if (isResizingRef.current && resizeCenterRef.current) {
        // ── NATIVE stopPropagation during resize ──────────────────────────
        // Prevents RF from seeing pointermove events and tracking a drag
        // that would override our center-anchored position on pointerup.
        e.stopPropagation();

        const { flowCx, flowCy } = resizeCenterRef.current;
        const fp = mainFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const flowDist = Math.sqrt((fp.x - flowCx) ** 2 + (fp.y - flowCy) ** 2);
        const newSize  = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, flowDist * 2)));
        mainFlow.setNodes(nds => nds.map(n =>
          n.id === id ? {
            ...n,
            position: { x: flowCx - newSize / 2, y: flowCy - newSize / 2 },
            width:    newSize,
            height:   newSize,
            // Do NOT set measured — it races with RF's ResizeObserver and
            // causes size to compound between sessions.
            style:    { ...(n.style || {}), width: newSize, height: newSize },
          } : n
        ));
        resizeMoveCount.current++;
        setCurrentSize(newSize);
        setEdgeCursorStyle(getResizeCursor(e.clientX, e.clientY));
        return;
      }
      // ── Hover: show edge cursor ─────────────────────────────────────────
      const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
      setEdgeCursorStyle(near ? getResizeCursor(e.clientX, e.clientY) : null);
    };

    const onUp = (e) => {
      if (!isResizingRef.current) return;
      // ── NATIVE stopPropagation on pointerup ───────────────────────────
      // Prevents RF from finalizing a drag to the wrong position on resize end.
      e.stopPropagation();
      el.releasePointerCapture(e.pointerId);
      isResizingRef.current = false;
      resizeCenterRef.current = null;
      setIsResizing(false);
      EventLogger.log(`canvas-node resize end id=${id} moves=${resizeMoveCount.current}`);
      const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
      setEdgeCursorStyle(near ? getResizeCursor(e.clientX, e.clientY) : null);
    };

    const onLeave = () => {
      if (!isResizingRef.current) setEdgeCursorStyle(null);
    };

    const onCancel = (e) => {
      if (!isResizingRef.current) return;
      el.releasePointerCapture(e.pointerId);
      isResizingRef.current = false;
      resizeCenterRef.current = null;
      setIsResizing(false);
      setEdgeCursorStyle(null);
    };

    el.addEventListener('pointerdown',  onDown);
    el.addEventListener('pointermove',  onMove);
    el.addEventListener('pointerup',    onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointercancel', onCancel);

    return () => {
      el.removeEventListener('pointerdown',  onDown);
      el.removeEventListener('pointermove',  onMove);
      el.removeEventListener('pointerup',    onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointercancel', onCancel);
    };
  // getDistToEdge, getResizeCursor, mainFlow are all stable across renders.
  // id is stable for the component's lifetime. State setters are stable.
  // liveRef gives us fresh isEditing/title/data/SIZE inside the closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mainFlow, getDistToEdge, getResizeCursor]);

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
        // noDrag: when the cursor is near the edge, tell RF's drag system
        // to skip this element. Belt-and-suspenders on top of native stopPropagation.
        className={`group${edgeCursorStyle ? ' noDrag' : ''}`}
        style={{ width: SIZE, height: SIZE, position: 'relative', cursor: edgeCursor }}
        // No React onPointerXxx props — all resize pointer handling is done via
        // native addEventListener in the useEffect above so that stopPropagation
        // fires before ReactFlow's parent-wrapper native drag listener.
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
        {/* data-no-resize tells the native pointerdown handler to skip resize   */}
        {/* initiation when the click originates from this element, so clicking  */}
        {/* the title text doesn't accidentally trigger resize (the title sits   */}
        {/* on the circle rim where distToEdge ≈ 0).                             */}
        {!isEditing && !data.locked && (() => {
          const titleText = title || 'Sub-Canvas';
          const estWidth  = Math.min(SIZE * 0.85, Math.max(SIZE * 0.45, titleText.length * fontSize * 0.65 + 24));
          const zoneTop   = SIZE - titleSpacing - fontSize - 6;
          return (
            <div
              data-no-resize="true"
              style={{
                position: 'absolute',
                top:    zoneTop,
                left:   (SIZE - estWidth) / 2,
                width:  estWidth,
                height: fontSize + 14,
                cursor: 'text',
                zIndex: 15,
              }}
              onClick={e => { e.stopPropagation(); setIsEditing(true); }}
              onDoubleClick={e => e.stopPropagation()}
            />
          );
        })()}

        {/* ── Transparent input overlay — only the caret is visible ────────── */}
        {isEditing && (
          <div
            data-no-resize="true"
            style={{
              position: 'absolute',
              top: -(Math.max(fontSize, 14) + titleSpacing + 2),
              left: 0, width: SIZE, zIndex: 20,
            }}
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
            data-no-resize="true"
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
