import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Lock, X, ArrowDown } from 'lucide-react';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { CustomizeDialog } from '../components/CustomizeDialog';
import { EventLogger } from '../utils/EventLogger';
import { getNodeDims } from '../utils/constants';
import { ResizeCorrection, ResizeActive, TitleZoneActive, TitleZoneCorrection } from '../utils/canvasInteractions';

const MIN_SIZE    = 80;
const MAX_SIZE    = 600;
const DEFAULT_SIZE = 160;
const EDGE_ZONE   = 12; // screen-px from circle edge that activates resize cursor

export const CanvasNode = React.memo(function CanvasNode({ id, data, selected, width }) {
  // currentSize is updated both from the width prop (via useEffect) AND synchronously
  // during active resize so SIZE is always fresh without waiting for ResizeObserver.
  const [currentSize, setCurrentSize] = useState(() => Math.round(width || DEFAULT_SIZE));
  useEffect(() => { setCurrentSize(Math.round(width || DEFAULT_SIZE)); }, [width]);
  const SIZE = currentSize;
  const R    = SIZE / 2;
  const mainFlow = useReactFlow();

  const [title, setTitle]                   = useState(data.title || '');
  const [isEditing, setIsEditing]           = useState(false);
  const [showCustomizeDialog, setShowCustomizeDialog] = useState(false);
  const [edgeCursorStyle, setEdgeCursorStyle] = useState(null);
  const [isResizing, setIsResizing]         = useState(false);

  // Synchronous refs — read inside native pointer handlers without re-render lag
  const isResizingRef    = useRef(false);
  const resizeCenterRef  = useRef(null);  // { flowCx, flowCy }
  const resizeMoveCount  = useRef(0);     // pointermove count per session (0 = phantom RF drag)
  const titleZoneDownRef = useRef(false); // true while a title-zone press is in flight

  const inputRef     = useRef(null);
  const containerRef = useRef(null);
  const textRef      = useRef(null); // ref to the SVG <text> element for getComputedTextLength()
  const pathId = `tcp-${id}`;

  // liveRef gives the stable native-listener useEffect access to values that
  // change between renders (isEditing, title, data, SIZE) without needing to
  // re-register the listeners every render.
  const liveRef = useRef(null);
  // measuredTextLen: exact SVG advance width of the title text in local units.
  // Stored in liveRef so the native pointer handlers (isInTitleArc) can use it
  // without being re-registered every time the title changes.
  // textRef.current is always populated because <text> renders unconditionally.
  liveRef.current = {
    isEditing, title, data, SIZE,
    measuredTextLen: textRef.current?.getComputedTextLength?.() ?? 0,
  };

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
  }, [id]);

  useEffect(() => { setTitle(data.title || ''); }, [data.title]);

  // While the title is being edited, make the node non-draggable so RF won't
  // drag it when the user clicks the input field. The input is positioned near
  // the circle's top rim (dist < EDGE_ZONE), so RF's capture-phase drag listener
  // would otherwise intercept the click and drag the node, causing onBlur on
  // the input and ending editing before the user can type anything.
  useEffect(() => {
    // updateNode targets a single node directly (O(1)) rather than mapping
    // over all nodes (O(n)), avoiding unnecessary re-renders of peers.
    mainFlow.updateNode(id, { draggable: !isEditing && !data.locked });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mainFlow and id are stable; only isEditing and data.locked drive the update
  }, [isEditing, data.locked]);

  useEffect(() => {
    if (data.isNew) {
      setIsEditing(true);
      mainFlow.updateNodeData(id, { isNew: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isEditing) {
      // Immediate focus so keystrokes land in the off-screen input.
      inputRef.current?.focus();
      const len = inputRef.current?.value?.length ?? 0;
      inputRef.current?.setSelectionRange(len, len);
      // Deferred re-focus: ReactFlow's selection-focus management sometimes fires
      // synchronously after a node is created/selected and steals focus back.
      // A zero-timeout re-grab wins that race without fighting RF's event loop.
      const t = setTimeout(() => {
        inputRef.current?.focus();
        const l = inputRef.current?.value?.length ?? 0;
        inputRef.current?.setSelectionRange(l, l);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [isEditing]);

  // ── Click-outside-to-commit ────────────────────────────────────────────────
  // The input is off-screen (position:fixed; top:-9999px) so the browser never
  // reassigns focus to the canvas pane on a click — onBlur never fires. We
  // listen for pointerdown on the document (capture phase, so nothing can swallow
  // it) and commit + exit editing whenever the tap lands outside our container.
  useEffect(() => {
    if (!isEditing) return;
    const onDocPointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        // Read the live input value so any pending keystrokes are captured.
        const v = (inputRef.current?.value ?? liveRef.current.title).trim();
        setTitle(v);
        mainFlow.updateNodeData(id, { title: v });
        setIsEditing(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onDocPointerDown, { capture: true });
  // id and mainFlow are stable; isEditing is the trigger; liveRef/inputRef/containerRef are refs.
  }, [isEditing, id, mainFlow]);

  // Font & Size dialog trigger (from context menu)
  useEffect(() => {
    const handleOpenFont = () => { if (!data.locked) setShowCustomizeDialog(true); };
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
  // Used by isInTitleZone, getResizeCursor, and event logging.
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

  // Returns true when the pointer is in the "title zone" — the top arc of the
  // circle where the curved title text lives.
  //
  // The arc path `M 0,R A R,R 0 0,1 SIZE,R` with sweep=1 (clockwise in SVG
  // screen coords) traces the TOP semicircle: left equator → top (R, 0) → right
  // equator. In Math.atan2 convention (y increases downward):
  //   • right equator = 0°,  top = -90°,  left equator ≈ ±180°
  // The title text lives at negative angles (top half-plane, clientY < center).
  // Resize is triggered from the bottom half (positive angles, 0° to 180°).
  const isInTitleZone = useCallback((clientX, clientY) => {
    const a = getAngleFromCenter(clientX, clientY);
    return a <= 0;   // top half-plane: right equator (0°) → top (-90°) → left equator (-180°)
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

    // ── Text-arc zone helper ─────────────────────────────────────────────────
    // Returns true when (clientX, clientY) falls within the angular band of the
    // top arc where the title text is actually rendered.
    //
    // Uses liveRef.measuredTextLen (= textRef.getComputedTextLength()) so the
    // zone matches the exact rendered text width — no hardcoded padding.
    // Falls back to the char-count estimate when the DOM measurement isn't ready.
    const isInTitleArc = (clientX, clientY) => {
      const { title: t, data: d, SIZE: s, measuredTextLen: ml } = liveRef.current;
      const fSize    = d.fontSize || 11;
      const arcPad   = fSize * 0.60; // 1 space-width (~0.30×fontSize) on each side = 2 spaces total
      const totalArc = Math.PI * (s / 2);
      const textArc  = ml > 0
        ? Math.min(totalArc * 0.95, ml + arcPad)
        : Math.min(totalArc * 0.90, (t || 'Sub-Canvas').length * fSize * 0.62 + 16 + arcPad);
      const halfDeg  = (textArc / totalArc) * 90;
      const a        = getAngleFromCenter(clientX, clientY);
      return a >= (-90 - halfDeg) && a <= (-90 + halfDeg);
    };

    const onDown = (e) => {
      if (liveRef.current.data.locked) return;

      const dist = getDistToEdge(e.clientX, e.clientY);

      // ── SVG title-text click (inside circle, not near rim) ────────────────
      // The <text> element has pointerEvents:'all' so clicks on the glyphs
      // bubble to containerRef. When dist >= EDGE_ZONE the pointer is well
      // inside the circle — not near the rim — so normally we'd return early.
      // BUT if the click landed on the SVG text/textPath/tspan itself (or any
      // element whose nearest SVG text ancestor is within the title zone), we
      // should open editing rather than ignoring the click.
      if (dist >= EDGE_ZONE) {
        const tgt = e.target;
        const isSvgText = tgt.nodeName === 'text' || tgt.nodeName === 'textPath' ||
                          tgt.nodeName === 'tspan' || !!tgt.closest('text');
        if (isSvgText && !liveRef.current.isEditing && isInTitleZone(e.clientX, e.clientY)) {
          // RF's capture-phase drag listener already fired. Mirror the normal title-zone
          // path: capture the pointer so onUp fires reliably, record position for
          // snap-back, and let onUp start editing (so TitleZoneActive is always cleaned up).
          e.stopPropagation();
          el.setPointerCapture(e.pointerId);
          titleZoneDownRef.current = true;
          TitleZoneActive.add(id);
          const node = mainFlow.getNode(id);
          if (node) TitleZoneCorrection.set(id, { x: node.position.x, y: node.position.y });
        }
        return; // pointer is not near the rim — ignore (onUp handles editing start)
      }

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
      })();
      const targetDesc = tgt === el                              ? 'container'
                       : tgt.dataset?.noResize                  ? `no-resize(${tgt.nodeName.toLowerCase()})`
                       : tgt.nodeName === 'svg' || tgt.nodeName === 'SVG' ? 'svg'
                       : tgt.nodeName === 'path' || tgt.nodeName === 'textPath'
                         || tgt.nodeName === 'text'             ? 'svg-text'
                       : tgt.nodeName === 'INPUT'               ? 'input'
                       : tgt.nodeName === 'DIV'                 ? `div${divDetail}`
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
        // We MUST let native events bubble for React Flow Handles so that their
        // Synthetic onPointerDown listeners fire at the #root level to initiate edge dragging.
        if (!tgt.closest('.react-flow__handle')) {
          e.stopPropagation();
        }
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

      // ── Title arc: the angular band where the text is rendered ──────────────
      // Computed from the same formula as the SVG highlight arc so the zone the
      // cursor changes in exactly matches the zone that triggers editing.
      // RF's capture-phase listener fires before ours; we record position so
      // Canvas.jsx can snap back if RF displaces the node during the hold.
      if (isInTitleArc(e.clientX, e.clientY)) {
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
      const { w: liveSize } = getNodeDims(node);
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

      // ── Hover cursor on the rim ──────────────────────────────────────────────
      // near rim + title arc  → 'text'   (no hand gap between edit and resize)
      // near rim + elsewhere  → resize cursor
      // not near rim          → null (default pointer outside the edge zone)
      const near    = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
      const inTitle = near && isInTitleArc(e.clientX, e.clientY);
      setEdgeCursorStyle(!near ? null : inTitle ? 'text' : getResizeCursor(e.clientX, e.clientY));
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
          // focus handled by the isEditing useEffect after next render
        } else {
          // Already editing (e.g. auto-started by data.isNew) but user tapped
          // the title zone — re-focus the off-screen input so keystrokes land.
          // RF may have stolen focus after node creation; this reclaims it.
          EventLogger.log(`canvas-node title-zone tap (already editing) → refocus id=${id}`);
          inputRef.current?.focus();
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
      const inTitle = near && isInTitleArc(e.clientX, e.clientY);
      setEdgeCursorStyle(!near ? null : inTitle ? 'text' : getResizeCursor(e.clientX, e.clientY));
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
      // Purge stale entries if the node is deleted mid-drag/mid-resize.
      // Without this, module-level maps accumulate entries for deleted IDs,
      // and if a new node is created with the same ID (e.g. via undo), it
      // would inherit corrupted position/size corrections.
      ResizeCorrection.delete(id);
      ResizeActive.delete(id);
      TitleZoneCorrection.delete(id);
      TitleZoneActive.delete(id);
    };
  // All callbacks (getDistToEdge, getAngleFromCenter, getCircleCenter, getResizeCursor,
  // isInTitleZone, mainFlow) are stable across renders (useCallback with no deps or
  // stable deps). id is stable for the component's lifetime. State setters are stable.
  // liveRef gives fresh isEditing/title/data/SIZE without re-registering listeners.
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
    const v = (val ?? liveRef.current.title).trim();
    setTitle(v);
    mainFlow.updateNodeData(id, { title: v });
    setIsEditing(false);
  }, [id, mainFlow]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    mainFlow.deleteElements({ nodes: [{ id }] });
  }, [id, mainFlow]);

  const handleInputKeyDown = useCallback((e) => {
    if (e.key === 'Enter')  commitTitle(e.target.value);
    if (e.key === 'Escape') { setTitle(liveRef.current.data.title || ''); setIsEditing(false); }
  }, [commitTitle]);

  // sweep-flag=1 (clockwise in SVG screen coords) traces the TOP semicircle:
  // left equator → top (R, 0) → right equator. This places the title text at
  // the top of the circle (angle ≈ -90°), consistent with:
  //   • isInTitleZone (a <= 0 = negative-Y half-plane = top)
  //   • the input overlay (top: -(fontSize + spacing) — above the container)
  //   • the title click zone div (top: 0 — at the container's top edge)
  // sweep=0 (counterclockwise) would trace the BOTTOM arc instead.
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
          {data.isDropTarget && (
            <div className="absolute inset-0 rounded-full pointer-events-none z-50 flex items-center justify-center overflow-hidden transition-all duration-300 backdrop-blur-[6px]"
                 style={{ 
                   border: '3px solid rgba(59,130,246,0.9)', 
                   boxShadow: '0 0 30px rgba(59,130,246,0.3), inset 0 0 30px rgba(59,130,246,0.4)',
                   background: 'radial-gradient(circle, rgba(30,58,138,0.3) 0%, rgba(15,23,42,0.6) 100%)',
                 }}>
               <div className="flex flex-col items-center justify-center animate-bounce text-blue-400">
                  <ArrowDown size={36} strokeWidth={2.5} className="drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
               </div>
            </div>
          )}
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
        {/* The SVG has pointerEvents:'none' so it doesn't block clicks on the    */}
        {/* circle body or container. But the <text> element opts back IN with     */}
        {/* pointerEvents:'all' so clicks directly on the glyph shapes are         */}
        {/* captured — even if the glyphs extend below the container rect due to   */}
        {/* SVG overflow:visible. Those clicks bubble to our container's native    */}
        {/* onDown, which routes them to the title-zone tap → editing flow.        */}
        <svg width={SIZE} height={SIZE} style={{
          position: 'absolute', inset: 0, overflow: 'visible',
          pointerEvents: 'none', zIndex: 10,
        }}>
          <defs><path id={pathId} d={arcPath} /></defs>

          {/* ── Curved editing highlight ──────────────────────────────────────── */}
          {/* A blue stroke arc centered on the top of the circle, sized to the   */}
          {/* estimated text width. Replaces the flat browser selection rectangle. */}
          {isEditing && (() => {
            const totalArcLen = Math.PI * R;
            const sw          = fontSize + 10;   // strokeWidth of the glow band
            const arcPad      = fontSize * 0.60; // 1 space-width (~0.30×fs) on each side
            // getComputedTextLength() gives the exact advance width of the title
            // text in SVG user units — same coordinate space as the arc path.
            // With strokeLinecap="round" each endpoint gets a sw/2 semicircle cap, so:
            //   visual half-width = textArcLen/2 + sw/2
            // We want visual extent = measured + arcPad (1 space each side), so:
            //   textArcLen = measured + arcPad - sw
            // which gives  (measured+arcPad-sw)/2 + sw/2 = (measured+arcPad)/2  ✓
            const measured   = textRef.current?.getComputedTextLength?.() ?? 0;
            const textArcLen = measured > 0
              ? Math.min(totalArcLen * 0.95, Math.max(0, measured + arcPad - sw))
              : Math.min(totalArcLen * 0.90,
                  (title || 'Sub-Canvas').length * fontSize * 0.62 + 16 + arcPad);
            // Negative dashoffset shifts the start of the dash backwards by half
            // the gap, centering the highlighted segment at the arc's midpoint (top).
            const dashOffset  = -((totalArcLen - textArcLen) / 2);
            return (
              <path
                d={arcPath}
                fill="none"
                stroke="rgba(96,165,250,0.20)"
                strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={`${textArcLen.toFixed(1)} ${(totalArcLen * 2).toFixed(1)}`}
                strokeDashoffset={dashOffset.toFixed(1)}
                style={{ pointerEvents: 'none' }}
              />
            );
          })()}

          <text
            ref={textRef}
            fontSize={fontSize}
            fontFamily={fontFamily}
            fontWeight="500"
            letterSpacing="0.5"
            dy={-titleSpacing}
            fill={titleFill}
            style={{
              // Allow clicks on the text glyphs themselves (including glyphs that
              // overflow below the container boundary). Disabled when locked (no
              // interactions) or while editing (input overlay handles events at zIndex 20).
              pointerEvents: data.locked || isEditing ? 'none' : 'all',
              cursor: 'text',
            }}
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
          const measured  = textRef.current?.getComputedTextLength?.() ?? 0;
          const estWidth  = measured > 0
            ? Math.min(SIZE * 0.85, measured + fontSize * 1.2)
            : Math.min(SIZE * 0.85, titleText.length * fontSize * 0.65 + 24);
          return (
            <div
              style={{
                position: 'absolute',
                top:    0,
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

        {/* ── Off-screen keyboard capture input ───────────────────────────────── */}
        {/* Positioned off-screen so no browser chrome (focus ring, selection     */}
        {/* rectangle, autofill overlay) is ever visible. The SVG arc highlight   */}
        {/* and blue arc text provide all visual editing feedback instead.         */}
        {isEditing && (
          <input
            ref={inputRef}
            data-no-resize="true"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={e  => commitTitle(e.target.value)}
            onKeyDown={handleInputKeyDown}
            style={{
              position: 'fixed',
              top:      '-9999px',
              left:     '-9999px',
              opacity:  0,
              width:    1,
              height:   1,
              padding:  0,
              border:   'none',
              outline:  'none',
            }}
          />
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
        <Handle type="target" position={Position.Top}    id="top" data-no-resize="true" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
        <Handle type="target" position={Position.Left}   id="left" data-no-resize="true" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
        <Handle type="source" position={Position.Right}  id="right" data-no-resize="true" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
        <Handle type="source" position={Position.Bottom} id="bottom" data-no-resize="true" className="w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
      </div>

      {showCustomizeDialog && (
        <CustomizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={data.textColor || '#ffffff'}
          backgroundColor={data.backgroundColor}
          titleSpacing={titleSpacing}
          onApply={(updates) => mainFlow.updateNodeData(id, updates)}
          onClose={() => setShowCustomizeDialog(false)}
        />
      )}
    </>
  );
});
