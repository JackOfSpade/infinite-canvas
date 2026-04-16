import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  ControlButton,
  useReactFlow
} from '@xyflow/react';

import { createTextNode, NODE_FACTORIES } from './utils/nodeFactory';
import { Sidebar } from './components/Sidebar';
import { ContextMenu } from './components/ContextMenu';
import { CanvasToolbar, NestedCanvasIcon } from './components/CanvasToolbar';
import { CustomMiniMap } from './components/CustomMiniMap';
import { SearchBar } from './components/SearchBar';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { DrawingLayer } from './components/DrawingLayer';
import { EmptyCanvasHint } from './components/EmptyCanvasHint';
import { StatusBar } from './components/StatusBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { BreadcrumbBar } from './components/BreadcrumbBar';
import { AlignedBackground } from './components/AlignedBackground';
import { SettingsPanel } from './components/SettingsPanel';
import { IssueReporterDialog } from './components/IssueReporterDialog';
import { EventLogger } from './utils/EventLogger';
import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from './nodes/CanvasNode';
import { CanvasNavigationContext } from './contexts/CanvasNavigationContext';
import { nodeTypes, DEFAULT_EDGE_OPTIONS } from './utils/constants';
import { useUndoRedo } from './hooks/useUndoRedo';
import { useCustomFitView } from './hooks/useCustomFitView';
import { useCanvasPersistence } from './hooks/useCanvasPersistence';
import { useCanvasDragAndDrop } from './hooks/useCanvasDragAndDrop';
import { useDrawingMode } from './hooks/useDrawingMode';
import { useCanvasInitialization } from './hooks/useCanvasInitialization';
import { useCanvasActions } from './hooks/useCanvasActions';
import { useCanvasContextMenu } from './hooks/useCanvasContextMenu';
import { useCanvasNavigation } from './hooks/useCanvasNavigation';
import { useSettings } from './hooks/useSettings';
import { useToast } from './components/ToastProvider';
import { ArrowUpLeft } from 'lucide-react';

// ── Canvas ───────────────────────────────────────────────────────────────────
export function Canvas() {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [drawings, setDrawings] = useState([]);
  const { addToast } = useToast();

  // ── Settings ────────────────────────────────────────────────────────────
  const { settings, updateSetting, updateShortcut, resetShortcuts, getAnimationDuration } = useSettings();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isIssueReporterOpen, setIsIssueReporterOpen] = useState(false);

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  const snapshotTakenForDeleteRef = useRef(false);
  const takeSnapshotRef = useRef(null);

  const snapshotOnDelete = useCallback((changes) => {
    if (changes.some(c => c.type === 'remove') && !snapshotTakenForDeleteRef.current) {
      snapshotTakenForDeleteRef.current = true;
      takeSnapshotRef.current?.();
      requestAnimationFrame(() => { snapshotTakenForDeleteRef.current = false; });
    }
  }, []);

  const onNodesChange = useCallback((changes) => {
    snapshotOnDelete(changes);
    // Log notable changes for bug reports
    changes.forEach(ch => {
      if (ch.type === 'remove')   EventLogger.log(`node removed id=${ch.id}`);
      if (ch.type === 'add')      EventLogger.log(`node added type=${ch.item?.type} id=${ch.item?.id}`);
      if (ch.type === 'position' && ch.dragging === false) {
        // Log final resting position after a drag (not every intermediate move)
        EventLogger.log(`node moved id=${ch.id} x=${ch.position?.x?.toFixed(1)} y=${ch.position?.y?.toFixed(1)}`);
      }
      if (ch.type === 'dimensions') {
        // During a CanvasNode resize session, RF's ResizeObserver echoes back every
        // pixel we set via setNodes — one "node resized" line per frame. That was
        // 50% of the entire log buffer and pure noise (the signal is canvas-node
        // resize start/end + moves count). Only log outside of active resize sessions.
        if (ResizeCorrection.size === 0) {
          EventLogger.log(`node resized id=${ch.id} w=${ch.dimensions?.width} h=${ch.dimensions?.height}`);
        }
      }
    });
    onNodesChangeBase(changes);
  }, [onNodesChangeBase, snapshotOnDelete]);

  // ── ReactFlow drag event logging + resize-drag tagging ───────────────────
  // These fire from ReactFlow's own drag system, independently of our pointer
  // handlers. We use ResizeActive to detect if the drag was initiated during a
  // CanvasNode resize session — only resize-tagged drags apply a ResizeCorrection.
  //
  // Without this gating, stale ResizeCorrection entries (left by 0-moves phantom
  // resizes where RF never fires onNodeDragStop) would wrongly snap the node
  // whenever the user later does any drag (normal move, input click, etc.).
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());

  const onNodeDragStart = useCallback((e, node) => {
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);
    // Tag this RF drag as resize-initiated if a resize is currently active.
    // ResizeActive is set in CanvasNode onDown (resize path) and cleared in onUp.
    // Tagging happens here (onNodeDragStart) because that's after our onDown runs.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    // RF's capture-phase listener fires before our onDown bubble handler, so by the
    // time onNodeDragStart fires, our onDown has already set TitleZoneActive.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, []);

  const onNodeDragStop = useCallback((e, node) => {
    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    const wasResizeDrag    = resizeDragActiveRef.current.has(node.id);
    const wasTitleZoneDrag = titleZoneDragActiveRef.current.has(node.id);
    resizeDragActiveRef.current.delete(node.id);
    titleZoneDragActiveRef.current.delete(node.id);

    const correction   = ResizeCorrection.get(node.id);
    const tzCorrection = TitleZoneCorrection.get(node.id);
    ResizeCorrection.delete(node.id);   // always clear, regardless of whether we apply it
    TitleZoneCorrection.delete(node.id);

    if (correction && wasResizeDrag) {
      // ── ResizeCorrection ───────────────────────────────────────────────────
      // This drag-stop was caused by a CanvasNode resize session. RF finalized
      // the node at a wrong drag-offset position. Apply the center-anchored
      // correction. React 18 batches this with RF's own position update so both
      // land in a single render with no visible jump.
      const { flowCx, flowCy, size } = correction;
      const correctX = flowCx - size / 2;
      const correctY = flowCy - size / 2;
      EventLogger.log(`resize-correction id=${node.id} pos=(${correctX.toFixed(1)},${correctY.toFixed(1)}) size=${size}`);
      setNodes(nds => nds.map(n =>
        n.id === node.id ? {
          ...n,
          position: { x: correctX, y: correctY },
          width:  size,
          height: size,
          style:  { ...(n.style || {}), width: size, height: size },
        } : n
      ));
    } else if (correction) {
      // Stale correction from a phantom resize (0 moves, RF never started a drag
      // for that session). Discard it — this drag was unrelated to any resize.
      EventLogger.log(`resize-correction DISCARDED (stale) id=${node.id}`);
    }

    if (tzCorrection && wasTitleZoneDrag) {
      // ── TitleZoneCorrection ────────────────────────────────────────────────
      // RF's capture-phase drag listener fires before our bubble-phase onDown,
      // so RF starts tracking a drag even during a title-zone press. If the user
      // holds and moves slightly, RF displaces the node before our onUp fires to
      // start editing. Snap the node back to where it was before the press.
      EventLogger.log(`title-zone-correction id=${node.id} pos=(${tzCorrection.x.toFixed(1)},${tzCorrection.y.toFixed(1)})`);
      setNodes(nds => nds.map(n =>
        n.id === node.id ? { ...n, position: { x: tzCorrection.x, y: tzCorrection.y } } : n
      ));
    }
  }, [setNodes]);

  const onEdgesChange = useCallback((changes) => {
    snapshotOnDelete(changes);
    changes.forEach(ch => {
      if (ch.type === 'remove') EventLogger.log(`edge removed id=${ch.id}`);
      if (ch.type === 'add')    EventLogger.log(`edge added id=${ch.item?.id}`);
    });
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase, snapshotOnDelete]);

  const isNavigationAnimatingRef = useRef(false);

  const { undo, redo, takeSnapshot, clearHistory, canUndo, canRedo } = useUndoRedo({
    nodes, edges, drawings, setNodes, setEdges, setDrawings,
    shortcuts: settings.shortcuts,
    isAnimatingRef: isNavigationAnimatingRef,
  });
  useEffect(() => { takeSnapshotRef.current = takeSnapshot; }, [takeSnapshot]);

  const customFitView = useCustomFitView(reactFlowWrapper, nodes, drawings);

  // ── Canvas Navigation (nested canvases) ─────────────────────────────────
  const navigation = useCanvasNavigation({
    nodes, edges, drawings,
    setNodes, setEdges, setDrawings,
    clearHistory,
    getAnimationDuration,
  });
  useEffect(() => {
    isNavigationAnimatingRef.current = navigation.isAnimating;
  }, [navigation.isAnimating]);

  const {
    saveCanvas, loadCanvas, exportCanvasToPNG,
    saveState, hasUnsavedChanges, setHasUnsavedChanges, currentFile, setCurrentFile,
  } = useCanvasPersistence({
    nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast,
    flushStack: navigation.flushStack,
    resetStack: navigation.resetStack,
    clearHistory,
  });

  useCanvasInitialization({
    nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, saveCanvas, loadCanvas,
    flushStack: navigation.flushStack,
  });

  // ── Generic Confirmation Dialog ───────────────────────────────────────────
  const [confirmDialogData, setConfirmDialogData] = useState(null);
  const requestConfirm = useCallback((data) => {
    setConfirmDialogData(data);
  }, []);
  const requestClearConfirm = useCallback((onConfirm) => {
    setConfirmDialogData({
      title: "Clear Canvas",
      message: `This will remove all nodes, edges, and drawings. This action can be undone with ${navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+'}Z.`,
      confirmLabel: "Clear Everything",
      cancelLabel: "Keep Canvas",
      variant: "danger",
      onConfirm
    });
  }, []);

  // ── Canvas interactions ──────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState(null); // 'pen' | 'eraser' | null
  const [eraserType, setEraserType] = useState('object'); // 'object' | 'pixel'
  const [currentStroke, setCurrentStroke] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  // Raw screen position for the eraser cursor overlay (updated on every pointermove)
  const [eraserScreenPos, setEraserScreenPos] = useState({ x: -999, y: -999 });
  const [placementMode, setPlacementMode] = useState(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  // bgVariant, showMiniMap, penSize and eraserSize are persisted in settings
  const bgVariant   = settings.bgVariant  ?? 'dots';
  const showMiniMap = settings.showMiniMap ?? true;
  const penSize     = settings.penSize    ?? 3;
  const eraserSize  = settings.eraserSize ?? 15;
  const setPenSize    = useCallback((v) => updateSetting('penSize', v),    [updateSetting]);
  const setEraserSize = useCallback((v) => updateSetting('eraserSize', v), [updateSetting]);
  const handleSettingsClick = useCallback(() => setIsSettingsOpen(true), []);
  const [activeColor, setActiveColor] = useState('white');
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  // Custom pointer-drag for Nested Canvas button (bypasses HTML5 drag so ghost matches click-place ghost)
  const [nestedDragPos, setNestedDragPos] = useState(null); // {x,y} screen coords while dragging
  const nestedDragRef = useRef(null); // { dragging: bool, startX, startY }
  const { screenToFlowPosition, getIntersectingNodes, getNode, setViewport, getViewport } = useReactFlow();

  const handlePaneDoubleClick = useCallback((e) => {
    if (activeTool || placementMode || navigation.isAnimating) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
    EventLogger.log(`Double-clicked canvas to create new Text Node`);
  }, [activeTool, placementMode, navigation.isAnimating, screenToFlowPosition, takeSnapshot, setNodes]);

  // ── Custom pointer-drag for Nested Canvas button ─────────────────────────
  const onNestedCanvasDragStart = useCallback((startX, startY) => {
    nestedDragRef.current = { dragging: false, startX, startY };

    const onMove = (e) => {
      const ref = nestedDragRef.current;
      if (!ref) return;
      if (!ref.dragging) {
        const dx = e.clientX - ref.startX;
        const dy = e.clientY - ref.startY;
        if (dx * dx + dy * dy < 25) return; // < 5px threshold
        ref.dragging = true;
      }
      setNestedDragPos({ x: e.clientX, y: e.clientY });
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const ref = nestedDragRef.current;
      nestedDragRef.current = null;
      setNestedDragPos(null);

      if (ref?.dragging) {
        // Place node at drop position — same offset as handleDrop uses for node-type drops
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const factory = NODE_FACTORIES['group'];
        if (factory) {
          takeSnapshot();
          setNodes(nds => nds.concat(factory({ x: pos.x - 12, y: pos.y - 20 })));
        }
      }
      // If not dragging, onClick on the button fires naturally → setPlacementMode('group')
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [screenToFlowPosition, takeSnapshot, setNodes]);

  // Prevent drawing edges TO sticky notes — sticky notes are output-only anchors
  const isValidConnection = useCallback((connection) => {
    const target = getNode(connection.target);
    if (target?.data?.isSticky) return false;
    return true;
  }, [getNode]);

  const { handleDrop: handleDropBase, handleDragOver } = useCanvasDragAndDrop({
    setNodes, setIsDrawingMode: (v) => setActiveTool(v ? 'pen' : null), takeSnapshot,
  });
  // Guard drops during navigation animations — a drop during the ~300ms fade would
  // append a node to the old canvas state and then the animation's setNodes would
  // overwrite everything, silently losing the dropped node.
  const handleDrop = useCallback((e) => {
    if (navigation.isAnimating) return;
    handleDropBase(e);
  }, [navigation.isAnimating, handleDropBase]);

  const clearDrawings = useCallback(() => {
    takeSnapshot();
    setDrawings([]);
  }, [takeSnapshot, setDrawings]);

  const onNodesDelete = useCallback((deletedNodes) => {
    const documentNodes = deletedNodes.filter(n => n.type === 'document' && n.data?.filePath);
    if (documentNodes.length > 0 && window.electronAPI) {
      requestConfirm({
        title: 'Delete from OS?',
        message: 'Do you also want to move the actual linked file(s) to trash?',
        confirmLabel: 'Move to Trash',
        cancelLabel: 'Keep OS File',
        variant: 'warning',
        onConfirm: async () => {
          for (const node of documentNodes) {
            try {
              await window.electronAPI.deleteOSFile(node.data.filePath);
            } catch (err) {
              console.error('Failed to trash file:', err);
            }
          }
        }
      });
    }
  }, [requestConfirm]);

  const { onConnect, onDragStart, clearCanvas } = useCanvasActions({
    setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, takeSnapshot, requestClearConfirm,
    resetStack: navigation.resetStack,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, activeTool, eraserType, eraserSize, currentStroke, setCurrentStroke,
    setMousePos, setEraserScreenPos, setDrawings, setNodes, setEdges, takeSnapshot, activeColor,
    penSize, getIntersectingNodes
  });

  const interactiveDisabled = !!activeTool || !!placementMode || navigation.isAnimating;

  // ── Context Menu Logic ───────────────────────────────────────────────────
  const { menu, closeMenu, onPaneContextMenuBase, onNodeContextMenuBase, getContextMenuItems } = useCanvasContextMenu({
    placementMode,
    takeSnapshot,
    setNodes,
    screenToFlowPosition,
    clearCanvas,
    extractToParent: navigation.extractToParent,
    depth: navigation.depth
  });

  // Guard context menu during navigation animations — opening a menu during the ~300ms
  // fade and then executing an action (Add Text, Delete, etc.) would mutate state that
  // is immediately overwritten by the animation's own setNodes/setEdges call.
  const onPaneContextMenu = useCallback((e) => {
    if (navigation.isAnimating) return;
    onPaneContextMenuBase(e);
  }, [navigation.isAnimating, onPaneContextMenuBase]);

  const onNodeContextMenu = useCallback((e, node) => {
    if (navigation.isAnimating) return;
    onNodeContextMenuBase(e, node);
  }, [navigation.isAnimating, onNodeContextMenuBase]);

  // ── Keyboard Shortcuts Panel + Escape to cancel placement/tool ──────────
  useEffect(() => {
    const handleKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === 'Escape') {
        if (placementMode) { setPlacementMode(null); return; }
        if (activeTool)    { setActiveTool(null);    return; }
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, activeTool]);

  // ── WASD canvas navigation ───────────────────────────────────────────────
  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    let rafId = null;
    const BASE_SPEED = 6; // pixels per frame at zoom=1

    const step = () => {
      const { w, a, s, d, shift } = keys;
      if (!w && !a && !s && !d) { rafId = null; return; }
      
      // Suspend WASD viewport updates during dive-in/dive-out animations
      if (!isNavigationAnimatingRef.current) {
        const speed = shift ? BASE_SPEED * 5 : BASE_SPEED;
        const vp = getViewport();
        setViewport({
          x: vp.x + (a ? speed : d ? -speed : 0),
          y: vp.y + (w ? speed : s ? -speed : 0),
          zoom: vp.zoom,
        });
      }
      rafId = requestAnimationFrame(step);
    };

    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        keys[k] = true;
        keys.shift = e.shiftKey;
        if (!rafId) rafId = requestAnimationFrame(step);
      }
      if (k === 'shift') keys.shift = true;
    };
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = false;
      if (k === 'shift') keys.shift = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [getViewport, setViewport]);

  // ── Export PNG via File menu (⌘⇧E) ───────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI?.onMenuExportPng) return;
    const remove = window.electronAPI.onMenuExportPng(() => exportCanvasToPNG());
    return remove;
  }, [exportCanvasToPNG]);

  // ── Issue Reporter ───────────────────────────────────────────────────────
  const handleIssueSubmit = useCallback(async (description, mode = 'file') => {
    if (!window.electronAPI) {
      addToast({ title: 'Bug Report', description: "Not running in Electron, can't generate report.", type: "error" });
      return;
    }
    try {
      // Snapshot the viewport so resize/position math can be verified in reports.
      const viewport = getViewport();

      // For group nodes (CanvasNode), capture all three size fields separately.
      // Discrepancies between style.width / measured.width / width reveal the
      // ReactFlow ResizeObserver race that caused the "size grows between sessions" bug.
      const nodeInternals = nodes.map(n => {
        const base = { id: n.id, type: n.type };
        if (n.type === 'group') {
          return {
            ...base,
            position:       n.position,
            width_prop:     n.width,
            height_prop:    n.height,
            style_width:    n.style?.width,
            style_height:   n.style?.height,
            measured_width:  n.measured?.width,
            measured_height: n.measured?.height,
          };
        }
        return base;
      });

      const payload = {
        description,
        nodes,
        edges,
        drawings,
        frontEndState: {
          activeTool,
          placementMode,
          eraserType,
          settings,
          currentFile,
          hasUnsavedChanges,
          navigationDepth: navigation.depth,
          snapToGrid,
          bgVariant: settings.bgVariant,
          showMiniMap: settings.showMiniMap,
          windowInnerWidth: window.innerWidth,
          windowInnerHeight: window.innerHeight,
          // Viewport transform — zoom level is critical for diagnosing
          // screenToFlowPosition math in resize/placement bugs.
          viewport: {
            x:    parseFloat(viewport.x.toFixed(2)),
            y:    parseFloat(viewport.y.toFixed(2)),
            zoom: parseFloat(viewport.zoom.toFixed(4)),
          },
        },
        // Separate diagnostic table — shows all three RF size fields per group node
        // so the report immediately exposes any style/measured/prop mismatches.
        nodeInternals,
        // Live React component state per CanvasNode (isEditing, isResizing, etc.)
        // — things not visible in the Zustand node JSON.
        nodeComponentStates: EventLogger.getNodeStates(),
        eventLogs: EventLogger.getLogs(),
      };
      if (mode === 'clipboard') {
        // Generate the markdown in the main process (needs system info / os module),
        // then copy the returned string to the clipboard in the renderer.
        const res = await window.electronAPI.generateBugReportMarkdown(payload);
        if (res.success) {
          await navigator.clipboard.writeText(res.markdown);
          addToast({ title: 'Bug Report Copied', description: 'Report copied to clipboard.', type: "success" });
        } else {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not generate the report.', type: "error" });
        }
      } else {
        // Save to file via native save dialog.
        const res = await window.electronAPI.exportBugReport(payload);
        if (res.success) {
          addToast({ title: 'Bug Report Saved', description: 'Your report has been exported successfully.', type: "success" });
        } else if (!res.canceled) {
          addToast({ title: 'Bug Report Failed', description: res.error || 'Could not save the report.', type: "error" });
        }
      }
    } catch (e) {
      addToast({ title: 'Bug Report Error', description: e.message || 'An unexpected error occurred.', type: "error" });
    }
  }, [nodes, edges, drawings, activeTool, placementMode, eraserType, settings, currentFile, hasUnsavedChanges, navigation.depth, snapToGrid, addToast, getViewport]);

  // ── Animation overlay style ──────────────────────────────────────────────
  const animDuration = getAnimationDuration();

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar nodes={nodes} onReportBugClick={() => setIsIssueReporterOpen(true)} />

      <div
        className="flex-1 h-full relative"
        data-drawing-mode={activeTool || undefined}
        onPointerDown={(e) => {
          // Only block drawing while a popup/context-menu is open or animation is running
          if (toolMenuOpen || menu || navigation.isAnimating) return;
          handlePointerDown(e);
        }}
        onPointerMove={(e) => {
          handlePointerMove(e);
          if (activeTool === 'eraser') {
            setEraserScreenPos({ x: e.clientX, y: e.clientY });
          }
        }}
        onPointerUp={handlePointerUp}
        onPointerLeave={(e) => {
          handlePointerUp(e);
          setEraserScreenPos({ x: -999, y: -999 });
        }}
      >
        <SearchBar nodes={nodes} />

        {/* Eraser cursor — pixel-perfect circle showing the erase radius.
            eraserSize is used directly as screen pixels — "good enough" because the user
            sets the size they see on screen; the drawing hook converts to flow coords. */}
        {activeTool === 'eraser' && eraserScreenPos.x > 0 && (
          <div
            className="fixed pointer-events-none z-[9998]"
            style={{
              left:   eraserScreenPos.x - eraserSize,
              top:    eraserScreenPos.y - eraserSize,
              width:  eraserSize * 2,
              height: eraserSize * 2,
              borderRadius: '50%',
              border: '1.5px solid rgba(255,255,255,0.7)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
              background: 'rgba(255,255,255,0.04)',
            }}
          />
        )}

        {/* Nested canvas drag ghost — identical to the click-place ghost */}
        {nestedDragPos && (
          <div
            className="fixed pointer-events-none z-50 flex flex-col items-center"
            style={{ left: nestedDragPos.x, top: nestedDragPos.y, transform: 'translate(-50%, -100%)' }}
          >
            <span className="text-blue-400 opacity-90 drop-shadow-lg">
              <NestedCanvasIcon size={28} />
            </span>
          </div>
        )}

        {/* Canvas transition overlay */}
        {navigation.animPhase && (
          <div
            className="canvas-transition-overlay"
            style={{
              opacity: navigation.animPhase === 'fade-out' ? 1 : 0,
              transition: `opacity ${animDuration / 2}ms ease-in-out`,
            }}
          />
        )}

        <CanvasNavigationContext.Provider value={navigation}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodesDelete={onNodesDelete}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            nodeTypes={nodeTypes}
            onDoubleClick={handlePaneDoubleClick}
            onNodeDoubleClick={(e, node) => {
                if (node.type === 'group' && !node.data?.locked && !navigation.isAnimating) {
                  navigation.diveIn(node.id);
                }
              }}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            snapToGrid={snapToGrid}
            snapGrid={[40, 40]}
            panOnDrag={!interactiveDisabled}
            selectionOnDrag={!interactiveDisabled}
            nodesDraggable={!interactiveDisabled}
            autoPanOnNodeFocus={false}
            zoomOnDoubleClick={false}

            className="touch-none"
            deleteKeyCode={['Backspace', 'Delete']}
            selectionKeyCode={['Shift']}
            multiSelectionKeyCode={['Control', 'Meta']}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          >
            {placementMode && (
              <div
                className="fixed pointer-events-none z-50 flex flex-col items-center"
                style={{ left: mousePos.x, top: mousePos.y, transform: 'translate(-50%, -100%)' }}
              >
                {placementMode === 'text' && <span className="text-sm font-medium text-white/90">text</span>}
                {placementMode === 'link' && <span className="text-sm font-medium text-blue-400">link</span>}
                {placementMode === 'group' && (
                  <span className="text-blue-400 opacity-90 drop-shadow-lg">
                    <NestedCanvasIcon size={28} />
                  </span>
                )}
              </div>
            )}

            <DrawingLayer drawings={drawings} currentStroke={currentStroke} activeColor={activeColor} penSize={penSize} />
            <EmptyCanvasHint nodeCount={nodes.length} drawingCount={drawings.length} />
            {bgVariant !== 'none' && <AlignedBackground variant={bgVariant} />}

            <Controls
              className="border border-white/10 shadow-lg overflow-hidden flex flex-col"
              buttonClassName="!bg-[#1a1a1a] !border-b-white/10 hover:!bg-[#333] transition-colors"
              style={{ display: 'flex', flexDirection: 'column', zIndex: 200 }}
              showInteractive={false}
              showFitView={false}
            >
              <ControlButton onClick={customFitView} title="fit view">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              </ControlButton>

              {/* Zoom-out / Back button — only when inside a nested canvas */}
              {navigation.depth > 0 && (
                <ControlButton
                  onClick={navigation.diveOut}
                  title="Back to parent canvas"
                  className="!border-t !border-t-blue-500/30"
                >
                  <ArrowUpLeft size={16} className="text-blue-400" />
                </ControlButton>
              )}
            </Controls>

            {showMiniMap && (
              <CustomMiniMap nodes={nodes} edges={edges} drawings={drawings} />
            )}

            {/* Breadcrumb bar — shown when inside nested canvas */}
            <BreadcrumbBar />

            <CanvasToolbar
              placementMode={placementMode}
              setPlacementMode={setPlacementMode}
              activeTool={activeTool}
              setActiveTool={setActiveTool}
              eraserType={eraserType}
              setEraserType={setEraserType}
              eraserSize={eraserSize}
              setEraserSize={setEraserSize}
              penSize={penSize}
              setPenSize={setPenSize}
              activeColor={activeColor}
              setActiveColor={setActiveColor}
              snapToGrid={snapToGrid}
              setSnapToGrid={setSnapToGrid}
              onDragStart={onDragStart}
              onNestedCanvasDragStart={onNestedCanvasDragStart}
              undo={undo}
              redo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
              clearCanvas={clearCanvas}
              clearDrawings={clearDrawings}
              onSettingsClick={handleSettingsClick}
              onToolMenuChange={setToolMenuOpen}
            />

            <StatusBar />
          </ReactFlow>
        </CanvasNavigationContext.Provider>

        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={getContextMenuItems()}
            onClose={closeMenu}
          />
        )}

        <OnboardingOverlay />

        <SettingsPanel
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          updateSetting={updateSetting}
          updateShortcut={updateShortcut}
          resetShortcuts={resetShortcuts}
        />

        <IssueReporterDialog
          isOpen={isIssueReporterOpen}
          onClose={() => setIsIssueReporterOpen(false)}
          onSubmit={handleIssueSubmit}
        />

        {confirmDialogData && (
          <ConfirmDialog
            title={confirmDialogData.title}
            message={confirmDialogData.message}
            confirmLabel={confirmDialogData.confirmLabel}
            cancelLabel={confirmDialogData.cancelLabel}
            variant={confirmDialogData.variant}
            onConfirm={() => {
              confirmDialogData.onConfirm();
              setConfirmDialogData(null);
            }}
            onCancel={() => setConfirmDialogData(null)}
          />
        )}
      </div>
    </div>
  );
}
