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

// ── ResizeCorrection ─────────────────────────────────────────────────────────
// Module-level map shared with Canvas.jsx. When a resize session starts, we
// record the center + size here. When RF fires onNodeDragStop (because it
// intercepted our pointerdown before our stopPropagation could block it),
// Canvas.jsx reads this map to correct RF's wrong dragged-to position back to
// the center-anchored value we computed. The map entry is cleared by Canvas.jsx
// inside onNodeDragStop immediately after applying the correction.
export const ResizeCorrection = new Map();
// Shape: Map<nodeId, { flowCx, flowCy, size }>

// ── ResizeActive ─────────────────────────────────────────────────────────────
// Set of nodeIds that currently have an active resize session (pointerdown on
// rim, before the matching pointerup). Canvas.jsx reads this in onNodeDragStart
// to tag the RF drag as "resize-initiated". Only resize-tagged drags consume
// a ResizeCorrection entry in onNodeDragStop. This prevents stale ResizeCorrection
// entries (from 0-moves phantom resizes where RF never fires onNodeDragStop)
// from wrongly snapping the node when the user later does a normal drag.
export const ResizeActive = new Set();

// ── TitleZoneCorrection / TitleZoneActive ─────────────────────────────────────
// Mirror of ResizeCorrection/ResizeActive for title-zone presses.
//
// Problem: RF uses a capture-phase drag listener on the node wrapper, which fires
// BEFORE our bubble-phase onDown. When the user presses the bottom arc (title zone)
// to start editing, RF sees the pointerdown and starts tracking a drag. If the user
// holds and moves even slightly, RF displaces the node — even though our onUp will
// correctly start editing. The node ends up at the wrong position.
//
// Fix: record the node's position when a title-zone press begins. If RF fires
// onNodeDragStop for a title-zone-tagged drag, Canvas.jsx snaps the node back.
export const TitleZoneActive     = new Set();              // nodeIds with active title-zone press
export const TitleZoneCorrection = new Map();              // Map<nodeId, {x, y}> original position

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
  const isResizingRef    = useRef(false);
  const resizeCenterRef  = useRef(null);  // { flowCx, flowCy }
  const resizeMoveCount  = useRef(0);     // pointermove count per session (0 = phantom RF drag)
  const titleZoneDownRef = useRef(false); // true while a title-zone press is in flight

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

  // While the title is being edited, make the node non-draggable so RF won't
  // drag it when the user clicks the input field. The input is positioned near
  // the circle's bottom rim (dist < EDGE_ZONE), so RF's capture-phase drag listener
  // would otherwise intercept the click and drag the node, causing onBlur on
  // the input and ending editing before the user can type anything.
  useEffect(() => {
    mainFlow.setNodes(nds => nds.map(n =>
      n.id === id ? { ...n, draggable: !isEditing } : n
    ));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

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

  // Angle (degrees) from circle center to pointer, in Math.atan2 convention:
  //   0° = right,  90° = bottom,  ±180° = left,  -90° = top.
  // Shared by isInTitleZone, getResizeCursor, and event logging.
  const getAngleFromCenter = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
  }, []);

  // Returns the circle center in screen (CSS pixel) coordinates.
  // Used by event logging so bug reports include both the raw click position
  // and the circle center — together they let you independently verify the
  // angle/dist math without trusting our geometry helpers.
  const getCircleCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { cx: 0, cy: 0 };
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  }, []);

  // Returns true when the pointer is in the "title zone" — the bottom arc of
  // the circle where the curved title text lives.
  //
  // The arc path `M 0,R A R,R 0 0,1 SIZE,R` spans the FULL bottom semicircle:
  // from the left equator (Math.atan2 angle ≈ 180°) through the bottom (90°)
  // to the right equator (0°). A user can click anywhere along that arc to edit,
  // so we guard the full 0°–180° range (positive-Y half-plane in screen coords).
  // Resize is only triggered from the top half (negative angles, -1° to -180°).
  const isInTitleZone = useCallback((clientX, clientY) => {
    const a = getAngleFromCenter(clientX, clientY);
    return a >= 0 && a <= 180;
  }, [getAngleFromCenter]);

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
      if (liveRef.current.data.locked) return;

      const dist = getDistToEdge(e.clientX, e.clientY);
      if (dist >= EDGE_ZONE) return; // pointer is not near the rim — ignore

      // ── Describe the click target for diagnostics ─────────────────────────
      // Identifies exactly which DOM element received the click.
      // - For DIVs, we append the first data-* key or first CSS class to
      //   disambiguate: e.g. "div[data-no-resize]", "div.absolute", "div".
      // - This reveals z-index/overflow issues and unexpected pointer-event routing.
      const tgt = e.target;
      const divDetail = (() => {
        const dataKeys = Object.keys(tgt.dataset || {});
        if (dataKeys.length) return `[${dataKeys[0]}]`;
        const cls = tgt.className && typeof tgt.className === 'string'
          ? tgt.className.trim().split(/\s+/)[0] : '';
        return cls ? `.${cls.slice(0, 18)}` : '';
      });
      const targetDesc = tgt === el                              ? 'container'
                       : tgt.dataset?.noResize                  ? `no-resize(${tgt.nodeName.toLowerCase()})`
                       : tgt.nodeName === 'svg' || tgt.nodeName === 'SVG' ? 'svg'
                       : tgt.nodeName === 'path' || tgt.nodeName === 'textPath'
                         || tgt.nodeName === 'text'             ? 'svg-text'
                       : tgt.nodeName === 'INPUT'               ? 'input'
                       : tgt.nodeName === 'DIV'                 ? `div${divDetail()}`
                       :                                          tgt.nodeName.toLowerCase();

      const angle = getAngleFromCenter(e.clientX, e.clientY);

      // ── Position info for log lines ───────────────────────────────────────
      // client=(x,y)  — raw screen coords of the click
      // circle=(cx,cy) — circle center in screen coords
      // Together these let you independently verify angle/dist math:
      //   angle = atan2(clientY - cy, clientX - cx)
      //   dist  = |sqrt((clientX-cx)² + (clientY-cy)²) - R|
      const { cx: circleCx, cy: circleCy } = getCircleCenter();
      const posStr = ` client=(${e.clientX},${e.clientY}) circle=(${circleCx.toFixed(0)},${circleCy.toFixed(0)})`;

      // ── Let data-no-resize children handle their own events ───────────────
      // (delete button, input overlay — NOT the title click zone, which has
      // no data-no-resize so the geometry path below can handle it correctly)
      if (tgt.closest('[data-no-resize]')) {
        // stopPropagation so bubble-phase handlers on ancestors don't also fire.
        // RF uses a capture-phase listener so this doesn't block drag initiation,
        // but the node will have draggable:false while editing (see useEffect above).
        e.stopPropagation();
        EventLogger.log(
          `canvas-node rim-click SKIPPED id=${id} target=${targetDesc}` +
          ` angle=${angle.toFixed(1)}° dist=${dist.toFixed(1)}${posStr}`
        );
        return;
      }

      // ── Always stopPropagation near the rim ───────────────────────────────
      // NOTE: RF uses a *capture-phase* listener on its wrapper, which fires
      // before our bubble-phase listener. So RF WILL still start a drag; we
      // compensate via ResizeCorrection in onNodeDragStop.
      e.stopPropagation();

      // ── Title zone: full bottom semicircle (0°–180°) ──────────────────────
      // The arc path spans the whole bottom half: right equator (0°) →
      // bottom (90°) → left equator (180°). Clicks anywhere on that arc
      // should open editing. We setPointerCapture so onUp fires reliably.
      //
      // RF's capture-phase drag listener fires before our bubble-phase handler,
      // so RF will start tracking a drag even here. We record the node's current
      // position so Canvas.jsx can snap it back if RF displaces it.
      if (isInTitleZone(e.clientX, e.clientY)) {
        el.setPointerCapture(e.pointerId);
        titleZoneDownRef.current = true;
        TitleZoneActive.add(id);
        const node = mainFlow.getNode(id);
        if (node) TitleZoneCorrection.set(id, { x: node.position.x, y: node.position.y });
        EventLogger.log(
          `canvas-node title-zone press id=${id}` +
          ` angle=${angle.toFixed(1)}° dist=${dist.toFixed(1)} target=${targetDesc}${posStr}`
        );
        return;
      }

      // ── Resize ────────────────────────────────────────────────────────────
      if (liveRef.current.isEditing) {
        mainFlow.updateNodeData(id, { title: liveRef.current.title.trim() });
        setIsEditing(false);
      }

      el.setPointerCapture(e.pointerId);

      // Read center from Zustand store — always synchronous and up-to-date.
      const node = mainFlow.getNode(id);
      if (!node) return;
      const liveSize = node.style?.width || node.measured?.width || node.width || DEFAULT_SIZE;
      const flowCx = node.position.x + liveSize / 2;
      const flowCy = node.position.y + liveSize / 2;
      resizeCenterRef.current = { flowCx, flowCy };

      // Register this session so Canvas.jsx can correct RF's wrong drag-stop position.
      ResizeCorrection.set(id, { flowCx, flowCy, size: liveSize });
      // Mark this node as actively resizing so Canvas.jsx onNodeDragStart can tag
      // the RF drag as resize-initiated. Only resize-tagged drags apply a correction.
      ResizeActive.add(id);

      isResizingRef.current = true;
      resizeMoveCount.current = 0;
      setIsResizing(true);
      // Log center + zoom — screenToFlowPosition is zoom-dependent, so these
      // are essential for verifying the center-anchor math in bug reports.
      const zoom = mainFlow.getViewport().zoom;
      EventLogger.log(
        `canvas-node resize start id=${id} size=${liveSize}` +
        ` center=(${flowCx.toFixed(0)},${flowCy.toFixed(0)})` +
        ` zoom=${zoom.toFixed(3)} angle=${angle.toFixed(1)}°` +
        ` dist=${dist.toFixed(1)} target=${targetDesc}${posStr}`
      );
    };

    const onMove = (e) => {
      // ── Title zone capture: swallow moves, don't resize ──────────────────
      if (titleZoneDownRef.current) return;

      if (isResizingRef.current && resizeCenterRef.current) {
        // ── NATIVE stopPropagation during resize ──────────────────────────
        // Prevents RF from accumulating more drag delta on pointermove.
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

        // Keep correction map up-to-date with the latest computed size.
        ResizeCorrection.set(id, { flowCx, flowCy, size: newSize });

        resizeMoveCount.current++;
        setCurrentSize(newSize);
        setEdgeCursorStyle(getResizeCursor(e.clientX, e.clientY));
        return;
      }

      // ── Hover: show edge cursor — but never in the title zone ─────────────
      const near    = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
      const inTitle = near && isInTitleZone(e.clientX, e.clientY);
      setEdgeCursorStyle(near && !inTitle ? getResizeCursor(e.clientX, e.clientY) : null);
    };

    const onUp = (e) => {
      // ── Title zone tap: activate title editing ────────────────────────────
      if (titleZoneDownRef.current) {
        titleZoneDownRef.current = false;
        TitleZoneActive.delete(id); // clear active marker; onNodeDragStart already tagged the RF drag if it started
        // Note: do NOT delete TitleZoneCorrection here — Canvas.jsx reads it in
        // onNodeDragStop to snap the node back if RF displaced it during the hold.
        el.releasePointerCapture(e.pointerId);
        if (!liveRef.current.isEditing) {
          EventLogger.log(`canvas-node title-zone tap → editing id=${id}`);
          setIsEditing(true);
        }
        return;
      }

      if (!isResizingRef.current) return;

      // ── Resize end ────────────────────────────────────────────────────────
      // Note: we do NOT stopPropagation here so that RF's pointerup handler
      // fires and calls onNodeDragStop — that's where Canvas.jsx applies the
      // ResizeCorrection to fix the position. (Stopping propagation would
      // suppress onNodeDragStop and leave nodes in a drag-active state.)
      el.releasePointerCapture(e.pointerId);
      isResizingRef.current = false;
      resizeCenterRef.current = null;
      ResizeActive.delete(id); // clear active marker; onNodeDragStart already tagged the RF drag if it started

      // If no pointermove events fired, RF never started a drag and will never
      // call onNodeDragStop — so our ResizeCorrection entry would sit stale in
      // the map forever. Delete it now for 0-moves phantom sessions.
      if (resizeMoveCount.current === 0) {
        ResizeCorrection.delete(id);
      }

      setIsResizing(false);
      EventLogger.log(`canvas-node resize end id=${id} moves=${resizeMoveCount.current}`);

      const near    = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
      const inTitle = near && isInTitleZone(e.clientX, e.clientY);
      setEdgeCursorStyle(near && !inTitle ? getResizeCursor(e.clientX, e.clientY) : null);
    };

    const onLeave = () => {
      if (!isResizingRef.current && !titleZoneDownRef.current) setEdgeCursorStyle(null);
    };

    const onCancel = (e) => {
      if (titleZoneDownRef.current) {
        titleZoneDownRef.current = false;
        TitleZoneActive.delete(id);
        TitleZoneCorrection.delete(id);
        el.releasePointerCapture(e.pointerId);
        return;
      }
      if (!isResizingRef.current) return;
      el.releasePointerCapture(e.pointerId);
      isResizingRef.current = false;
      resizeCenterRef.current = null;
      ResizeCorrection.delete(id);
      ResizeActive.delete(id);
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
  // All callbacks (getDistToEdge, getAngleFromCenter, getCircleCenter, getResizeCursor,
  // isInTitleZone, mainFlow) are stable across renders (useCallback with no deps or
  // stable deps). id is stable for the component's lifetime. State setters are stable.
  // liveRef gives fresh isEditing/title/data/SIZE without re-registering listeners.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mainFlow, getDistToEdge, getAngleFromCenter, getCircleCenter, getResizeCursor, isInTitleZone]);

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
        {/* Intentionally has NO data-no-resize — we want onDown's geometry     */}
        {/* check (isInTitleZone) to handle rim clicks consistently rather than  */}
        {/* the data-no-resize early-return which skips stopPropagation and lets */}
        {/* RF start a drag. This div is kept for two purposes:                  */}
        {/*   1. cursor: 'text' overlay so hovering the text shows a text cursor */}
        {/*   2. onClick fallback for clicks well inside the circle (dist ≥ EDGE_ZONE) */}
        {!isEditing && !data.locked && (() => {
          const titleText = title || 'Sub-Canvas';
          const estWidth  = Math.min(SIZE * 0.85, Math.max(SIZE * 0.45, titleText.length * fontSize * 0.65 + 24));
          const zoneTop   = SIZE - titleSpacing - fontSize - 6;
          return (
            <div
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
        {/* Positioned at the BOTTOM of the circle to match where the curved arc  */}
        {/* title text is rendered (bottom semicircle, ~90°). Uses the same        */}
        {/* zoneTop formula as the title click zone div so the caret appears       */}
        {/* directly over the arc text and in the title zone (0°–180°), not the   */}
        {/* resize zone (negative angles = top half).                              */}
        {isEditing && (
          <div
            data-no-resize="true"
            style={{
              position: 'absolute',
              top: SIZE - Math.max(fontSize, 14) - titleSpacing - 6,
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
