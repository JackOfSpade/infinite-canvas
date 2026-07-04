import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  ControlButton,
  useReactFlow,
  SelectionMode,
  ConnectionMode,
  ConnectionLineType
} from '@xyflow/react';

import { DocumentNode } from './nodes/DocumentNode';
import { TextNode } from './nodes/TextNode';
import { CanvasNode } from './nodes/CanvasNode';
import { ResizeCorrection } from './utils/canvasInteractions';
import { LinkNode } from './nodes/LinkNode';
import { JobCardNode } from './nodes/JobCardNode';
import { JobSearchNode } from './nodes/JobSearchNode';
import { JobBoardNode } from './nodes/JobBoardNode';
import {SellHubNode} from './nodes/SellHubNode';
import { MarketplaceCardNode } from './nodes/MarketplaceCardNode';
import { MarketplaceStatusNode } from './nodes/MarketplaceStatusNode';
import { CompSourceCardNode } from './nodes/CompSourceCardNode';
import { JobSourceCardNode } from './nodes/JobSourceCardNode';
import { JobGroupNode } from './nodes/JobGroupNode';
import { sanitizeEdgesForSave } from './utils/serializationUtils';
import {CustomizeDialog} from './components/CustomizeDialog';

import { createTextNode } from './utils/nodeFactory';
import { Sidebar } from './components/Sidebar';
import { getStats } from './utils/dashboardStats';
import { ContextMenu } from './components/ContextMenu';
import { CanvasToolbar } from './components/CanvasToolbar';
import { CanvasCursors } from './components/CanvasCursors';
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

import { CanvasNavigationContext } from './contexts/CanvasNavigationContext';
import { CANVAS_ZOOM_LIMITS, DEFAULT_EDGE_OPTIONS } from './utils/constants';
import { useModalStackCount } from './components/modalStack';

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
import { useCanvasWASD } from './hooks/useCanvasWASD';
import { useIssueReporter } from './hooks/useIssueReporter';
import { useDragCorrections } from './hooks/useDragCorrections';
import { useNestedCanvasDrag } from './hooks/useNestedCanvasDrag';
import { useCanvasKeyboardShortcuts } from './hooks/useCanvasKeyboardShortcuts';
import { useCanvasOSDeletion } from './hooks/useCanvasOSDeletion';
import { useConfirmDialog } from './hooks/useConfirmDialog';
import { ArrowUpLeft } from 'lucide-react';
import { viewportForZoomAtScreenPoint } from './utils/layoutGeometry';
import { buildCustomizationDialogData, filterNodeCustomizationUpdates } from './utils/nodeCustomization';

const wheelZoomDelta = (event) => {
  const platform = window.navigator?.platform || '';
  const factor = event.ctrlKey && /Mac/.test(platform) ? 10 : 1;
  return -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * factor;
};

const nodeTypes = {
  document: DocumentNode,
  text: TextNode,
  group: CanvasNode, // Keep 'group' key for backward compatibility of saved nodes, but map it to CanvasNode
  link: LinkNode,
  jobcard: JobCardNode,
  jobhub: JobSearchNode, // 'jobhub' is the legacy persisted type key for the Job Search Module (kept for saved-canvas compat, like 'group')
  jobboard: JobBoardNode,
  sellhub: SellHubNode,
  marketplacecard: MarketplaceCardNode,
  marketplacestatus: MarketplaceStatusNode,
  compsourcecard: CompSourceCardNode,
  jobsourcecard: JobSourceCardNode,
  jobgroup: JobGroupNode,
};

// ── Canvas ───────────────────────────────────────────────────────────────────
export function Canvas() {
  const reactFlowWrapper = useRef(null);
  const cursorsRef = useRef(null);
  const drawingLayerRef = useRef(null);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [drawings, setDrawings] = useState([]);
  const confirmDialogDataRef = useRef(null);

  // Self-healing orphan-edge prune: whenever the node set changes, drop any
  // edge whose source/target isn't a live node. Belt-and-suspenders for the
  // save-time and load-time strips in serializationUtils — covers any code
  // path that re-introduces orphans (older code paths, undo of a delete,
  // pre-fix saved files reloaded over an open session, etc.). Prevents the
  // minimap from rendering ghost connections to deleted-hub positions.
  // No-op when the edge set is already clean (returns the same array
  // reference so React doesn't re-render).
  useEffect(() => {
    setEdges(prev => {
      const clean = sanitizeEdgesForSave(prev, nodes);
      return clean.length === prev.length ? prev : clean;
    });
  }, [nodes, setEdges]);

  const { addToast } = useToast();

  // ── Settings ────────────────────────────────────────────────────────────
  const { settings, updateSetting, updateShortcut, resetShortcuts, animationDuration } = useSettings();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isIssueReporterOpen, setIsIssueReporterOpen] = useState(false);
  const [customizeTargetIds, setCustomizeTargetIds] = useState([]);

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  const snapshotTakenForDeleteRef = useRef(false);
  const takeSnapshotRef = useRef(null);

  const {
    screenToFlowPosition,
    getIntersectingNodes,
    getNode,
    getNodes,
    getEdges,
    updateNodeData,
    getViewport,
    setViewport,
  } = useReactFlow();

  const snapshotOnDelete = useCallback((changes) => {
    if (changes.some(c => c.type === 'remove') && !snapshotTakenForDeleteRef.current) {
      snapshotTakenForDeleteRef.current = true;
      takeSnapshotRef.current?.();
      requestAnimationFrame(() => { snapshotTakenForDeleteRef.current = false; });
    }
  }, []);

  const onNodesChange = useCallback((changes) => {
    // Prevent removal of locked nodes
    const filteredChanges = changes.filter(ch => {
      if (ch.type === 'remove') {
        const node = getNode(ch.id);
        if (node?.data?.locked) {
          EventLogger.log(`Node removal BLOCKED (locked) id=${ch.id}`);
          return false;
        }
      }
      return true;
    });

    if (filteredChanges.length === 0) return;

    snapshotOnDelete(filteredChanges);
    // Log notable changes for bug reports
    filteredChanges.forEach(ch => {
      if (ch.type === 'remove') EventLogger.log(`node removed id=${ch.id}`);
      if (ch.type === 'add') EventLogger.log(`node added type=${ch.item?.type} id=${ch.item?.id}`);
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
    onNodesChangeBase(filteredChanges);
  }, [onNodesChangeBase, snapshotOnDelete, getNode]);

  const isInteractionRef = useRef(false);

  const onEdgesChange = useCallback((changes) => {
    snapshotOnDelete(changes);
    changes.forEach(ch => {
      if (ch.type === 'remove') EventLogger.log(`edge removed id=${ch.id}`);
      if (ch.type === 'add') EventLogger.log(`edge added id=${ch.item?.id}`);
    });
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase, snapshotOnDelete]);

  const isNavigationAnimatingRef = useRef(false);

  const { undo, redo, takeSnapshot, clearHistory, canUndo, canRedo } = useUndoRedo({
    nodes, edges, drawings, setNodes, setEdges, setDrawings,
    shortcuts: settings.shortcuts,
    isAnimatingRef: isNavigationAnimatingRef,
    isInteractionRef,
  });

  // ── Dev-Only HMR Wrapper for ReactFlow Nodes ───────────────────────────────
  // Forces React Flow to instantly bypass Memoization and update node visuals
  // when component files are hot-swapped by Vite.
  useEffect(() => {
    if (import.meta.env.DEV && import.meta.hot) {
      const handleHMR = (payload) => {
        if (payload?.updates?.some(u => u.path.includes('/src/nodes/'))) {
          // Delay briefly to allow Vite to evaluate the new module, then force node prop updates
          setTimeout(() => {
            setNodes(nds => nds.map(n => ({ ...n, data: { ...n.data, _hmr: Date.now() } })));
          }, 150);
        }
      };
      
      // Hook into the global Vite event stream
      // Using 'vite:afterUpdate' works best to ensure modules are re-evaluated, 
      // but 'vite:beforeUpdate' with a timeout is more universally supported in Older Vites.
      import.meta.hot.on('vite:beforeUpdate', handleHMR);

      return () => {
        if (import.meta.hot.off) { 
          import.meta.hot.off('vite:beforeUpdate', handleHMR);
        }
      };
    }
  }, [setNodes]);

  useEffect(() => { takeSnapshotRef.current = takeSnapshot; }, [takeSnapshot]);

  // ── Canvas Navigation (nested canvases) ─────────────────────────────────
  // Must be declared before useDragCorrections, which references navigation.addElementsGlobally.
  const navigation = useCanvasNavigation({
    nodes, edges, drawings,
    setNodes, setEdges, setDrawings,
    clearHistory,
    animationDuration,
  });
  // Sync isNavigationAnimatingRef synchronously via useLayoutEffect (to catch frames as early as possible)
  // to close the 1-frame race window where isAnimating is true but the ref hasn't
  // been updated yet, allowing event handlers to bypass the animation guard.
  React.useLayoutEffect(() => {
    isNavigationAnimatingRef.current = navigation.isAnimating;
  }, [navigation.isAnimating]);

  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useDragCorrections({
    setNodes,
    setEdges,
    getNodes,
    getEdges,
    getIntersectingNodes,
    getNode,
    takeSnapshot,
    updateNodeData,
    addElementsGlobally: navigation.addElementsGlobally,
    extractToLevel: navigation.extractToParent,
    isAnimatingRef: isNavigationAnimatingRef,
    isInteractionRef,
  });

  const customFitView = useCustomFitView(reactFlowWrapper, nodes, drawings, isNavigationAnimatingRef);

  const {
    saveCanvas, loadCanvas, exportCanvasToPNG,
    hasUnsavedChanges, setHasUnsavedChanges, currentFile, setCurrentFile,
    saveStateRef, loadState,
  } = useCanvasPersistence({
    nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast,
    flushStack: navigation.flushStack,
    resetStack: navigation.resetStack,
    clearHistory,
    isAnimatingRef: isNavigationAnimatingRef,
    updateSetting,
  });

  useCanvasInitialization({
    nodes, edges, drawings, currentFile, setCurrentFile, hasUnsavedChanges, setHasUnsavedChanges,
    flushStack: navigation.flushStack,
    isAnimatingRef: isNavigationAnimatingRef,
    navigationStateSwapRef: navigation.stateSwapRef,
    saveStateRef,
  });

  // Exposes currentFile to descendants (e.g. JobSearchNode) alongside the
  // navigation helpers via the same context, avoiding a second provider.
  const navContextValue = React.useMemo(
    () => ({ ...navigation, currentFile }),
    [navigation, currentFile]
  );

  // ── Initial canvas population on mount ──────────────────────────────────
  // Each window is told what to show via the loaded URL's `init` query param,
  // set by the main process when it creates the window:
  //   • 'blank' → a New Canvas (or relaunch); stay empty.
  //   • 'file'  → Open Canvas opened a specific file in this fresh window.
  //   • 'auto'/absent → first launch / dock re-activation; restore last session.
  const hasAttemptedAutoLoad = useRef(false);
  useEffect(() => {
    if (hasAttemptedAutoLoad.current) return;
    hasAttemptedAutoLoad.current = true;

    const params = new URLSearchParams(window.location.search);
    const initMode = params.get('init');
    const initFile = params.get('file');

    if (initMode === 'blank') return;            // fresh, intentionally empty
    if (initMode === 'file' && initFile) {
      loadCanvas(initFile, true);
      return;
    }
    if (settings.lastOpenedWorkspace) {
      loadCanvas(settings.lastOpenedWorkspace, true);
    }
  }, [settings.lastOpenedWorkspace, loadCanvas]);

  // ── Report the open file to the main process ────────────────────────────
  // Lets main avoid opening the same canvas in two windows (it focuses the
  // existing one instead).
  useEffect(() => {
    window.electronAPI?.setWindowFile?.(currentFile || null);
  }, [currentFile]);

  // ── Follow on-disk renames ───────────────────────────────────────────────
  // If the user renames the canvas file in Finder while it's open, the main
  // process detects it (by inode) and pushes the new path here. Adopting it
  // keeps currentFile — and every job sidecar derived from it — pointing at the
  // right file immediately, without waiting for the next save.
  useEffect(() => {
    if (!window.electronAPI?.onCanvasFileRenamed) return;
    return window.electronAPI.onCanvasFileRenamed((newPath) => {
      if (!newPath) return;
      setCurrentFile(newPath);
      updateSetting?.('lastOpenedWorkspace', newPath);
      const name = newPath.split(/[/\\]/).pop();
      addToast({ title: 'Canvas file renamed', description: `Now saving to “${name}”.`, type: 'info' });
    });
  }, [setCurrentFile, updateSetting, addToast]);

  // ── Document Title Manager ───────────────────────────────────────────────
  useEffect(() => {
    let title = 'Infinite Canvas';
    if (currentFile) {
      let basename = currentFile.split(/[/\\]/).pop();
      if (basename.endsWith('.json')) {
        basename = basename.slice(0, -5);
      }
      title = `${basename}${hasUnsavedChanges ? '*' : ''}`;
    } else if (hasUnsavedChanges) {
      title = 'Untitled*';
    }
    document.title = title;
  }, [currentFile, hasUnsavedChanges]);

  // ── Native Menu Wiring ───────────────────────────────────────────────────
  // Binds the native macOS/Windows application menu items (File -> Save, Export)
  // to the React-managed canvas state inside this window. New Canvas and Open
  // Canvas are handled entirely in the main process (each opens its own window),
  // so they aren't wired here.
  useEffect(() => {
    const unlistenSave = window.electronAPI?.onMenuSave?.(() => {
      if (!isNavigationAnimatingRef.current) saveCanvas();
    });
    const unlistenExport = window.electronAPI?.onMenuExportPng?.(() => {
      if (!isNavigationAnimatingRef.current) exportCanvasToPNG();
    });

    return () => {
      unlistenSave?.();
      unlistenExport?.();
    };
  }, [saveCanvas, exportCanvasToPNG]);

  // ── Generic Confirmation Dialog ───────────────────────────────────────────
  const {
    confirmDialogData,
    setConfirmDialogData,
    requestConfirm,
    requestClearConfirm
  } = useConfirmDialog();

  React.useLayoutEffect(() => {
    confirmDialogDataRef.current = confirmDialogData;
  }, [confirmDialogData]);

  const handleConfirmDialogConfirm = useCallback(() => {
    EventLogger.log('ConfirmDialog CONFIRMED');
    confirmDialogDataRef.current?.onConfirm();
    setConfirmDialogData(null);
  }, [setConfirmDialogData]);

  const handleConfirmDialogCancel = useCallback(() => {
    EventLogger.log('ConfirmDialog CANCELLED');
    setConfirmDialogData(null);
  }, [setConfirmDialogData]);

  // X button — caller-provided "undo everything this dialog was about to act
  // on" callback. Used by the delete-from-disk dialog to roll back the canvas
  // deletion that triggered it. No-op if the caller didn't provide one.
  const handleConfirmDialogAbort = useCallback(() => {
    EventLogger.log('ConfirmDialog ABORTED/UNDONE');
    confirmDialogDataRef.current?.onAbort?.();
    setConfirmDialogData(null);
  }, [setConfirmDialogData]);

  // ── Canvas interactions ──────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState(null); // 'pen' | 'eraser' | null
  const [eraserType, setEraserType] = useState('object'); // 'object' | 'pixel'
  const [placementMode, setPlacementMode] = useState(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  // bgVariant, showMiniMap, penSize and eraserSize are persisted in settings
  const bgVariant = settings.bgVariant ?? 'dots';
  const showMiniMap = settings.showMiniMap ?? true;
  const penSize = settings.penSize ?? 3;
  const eraserSize = settings.eraserSize ?? 15;
  const setPenSize = useCallback((v) => updateSetting('penSize', v), [updateSetting]);
  const setEraserSize = useCallback((v) => updateSetting('eraserSize', v), [updateSetting]);
  const handleSettingsClick = useCallback(() => setIsSettingsOpen(true), []);
  const [activeColor, setActiveColor] = useState('white');
  const [toolMenuOpen, setToolMenuOpen] = useState(false);

  // Custom pointer-drag for Nested Canvas button (bypasses HTML5 drag so ghost matches click-place ghost)
  const { onNestedCanvasDragStart } = useNestedCanvasDrag({
    isAnimatingRef: isNavigationAnimatingRef,
    screenToFlowPosition,
    takeSnapshot,
    setNodes,
    cursorsRef,
  });

  const handlePaneDoubleClick = useCallback((e) => {
    // onDoubleClick is NOT pane-scoped in @xyflow/react v12 — it lands on the outer
    // rf__wrapper (an ancestor of every node), so a node/document/group double-click
    // bubbles here and would spawn a stray empty text node (baked into a group's
    // saved canvas). Only act on a direct hit to the empty pane (mirrors the
    // handlePaneMouseDown deselect guard).
    if (!e.target?.classList?.contains('react-flow__pane')) return;
    if (activeTool || placementMode || navigation.isAnimating) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
    EventLogger.log(`Double-clicked canvas to create new Text Node`);
  }, [activeTool, placementMode, navigation.isAnimating, screenToFlowPosition, takeSnapshot, setNodes]);

  const onNodeDoubleClick = useCallback((e, node) => {
    if (node.type === 'group' && !navigation.isAnimating) {
      navigation.diveIn(node.id);
    }
  }, [navigation]);

  const { handleDrop: handleDropBase, handleDragOver, handleDragLeave } = useCanvasDragAndDrop({
    setNodes, setIsDrawingMode: (v) => setActiveTool(v ? 'pen' : null), takeSnapshot, depth: navigation.depth,
    addElementsGlobally: navigation.addElementsGlobally,
  });
  // Guard drops during navigation animations — a drop during the ~300ms fade would
  // append a node to the old canvas state and then the animation's setNodes would
  // overwrite everything, silently losing the dropped node.
  const handleDrop = useCallback((e) => {
    if (navigation.isAnimating) return;
    handleDropBase(e);
  }, [navigation.isAnimating, handleDropBase]);

  const clearDrawings = useCallback(() => {
    if (navigation.isAnimating) return;
    takeSnapshot();
    setDrawings([]);
  }, [takeSnapshot, setDrawings, navigation.isAnimating]);

  const { onNodesDelete } = useCanvasOSDeletion({ requestConfirm, undo });

  const { onConnect, onDragStart, clearCanvas, duplicateNodes, copyNodes, pasteNodes } = useCanvasActions({
    takeSnapshot,
    setNodes,
    setEdges,
    setDrawings,
    drawings,
    setCurrentFile,
    setHasUnsavedChanges,
    requestClearConfirm,
    resetStack: navigation.resetStack,
    depth: navigation.depth,
    isAnimatingRef: isNavigationAnimatingRef,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, activeTool, eraserType, eraserSize,
    setNodes, setDrawings, takeSnapshot, activeColor,
    penSize, getIntersectingNodes, isAnimatingRef: isNavigationAnimatingRef,
    cursorsRef, drawingLayerRef, isInteractionRef,
  });

  // Drawing/placement tools fully disable node interaction; the select tool does not.
  const isDrawingTool = activeTool === 'pen' || activeTool === 'eraser';
  const isSelectTool  = activeTool === 'select';
  const modalCount = useModalStackCount();
  // A dialog/menu/lightbox is open — canvas delete-key/pan/zoom/selection must
  // not leak through to the content underneath it (see modalStack.js).
  const interactiveDisabled = isDrawingTool || !!placementMode || navigation.isAnimating || modalCount > 0;

  const handleWheelZoom = useCallback((e) => {
    if (interactiveDisabled || e.target?.closest?.('.nowheel')) return;

    const delta = wheelZoomDelta(e);
    if (!Number.isFinite(delta) || delta === 0) return;

    const bounds = e.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    e.preventDefault();
    e.stopPropagation();

    const viewport = getViewport();
    const nextZoom = Math.min(
      CANVAS_ZOOM_LIMITS.max,
      Math.max(CANVAS_ZOOM_LIMITS.min, viewport.zoom * Math.pow(2, delta))
    );

    if (nextZoom === viewport.zoom) return;

    setViewport(viewportForZoomAtScreenPoint(
      viewport,
      { x: bounds.width / 2, y: bounds.height / 2 },
      nextZoom
    ));
  }, [getViewport, interactiveDisabled, setViewport]);

  const handleViewportMoveEnd = useCallback((event, viewport) => {
    if (!viewport) return;
    EventLogger.log(
      `viewport changed source=${event ? 'interaction' : 'programmatic'} zoom=${viewport.zoom.toFixed(4)} x=${viewport.x.toFixed(2)} y=${viewport.y.toFixed(2)}`
    );
  }, []);

  // Deselect nodes whenever the user starts an interaction on empty canvas.
  // ReactFlow's built-in onPaneClick already deselects on a plain click, but a
  // click-and-drag (pan) doesn't fire onClick, so the prior selection visually
  // lingers as a "selected" outline that reads as an edit highlight. We attach a
  // mousedown listener directly to .react-flow__pane and filter to direct hits
  // on the pane (events from nodes/edges bubble up but have a different target).
  // Skip when a multi-select key is held so additive box-select still works.
  useEffect(() => {
    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;
    const pane = wrapper.querySelector('.react-flow__pane');
    if (!pane) return;
    const handlePaneMouseDown = (e) => {
      if (e.target !== pane) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      setNodes((nds) =>
        nds.some((n) => n.selected)
          ? nds.map((n) => (n.selected ? { ...n, selected: false } : n))
          : nds,
      );
    };
    pane.addEventListener('mousedown', handlePaneMouseDown);
    return () => pane.removeEventListener('mousedown', handlePaneMouseDown);
  }, [setNodes]);

  // ── Context Menu Logic ───────────────────────────────────────────────────
  const { menu, closeMenu, onPaneContextMenuBase, onNodeContextMenuBase, contextMenuItems } = useCanvasContextMenu({
    placementMode,
    takeSnapshot,
    setNodes,
    screenToFlowPosition,
    clearCanvas,
    duplicateNodes,
    extractToParent: navigation.extractToParent,
    depth: navigation.depth, updateGlobal: navigation.updateNodeDataGlobally,
    isAnimatingRef: isNavigationAnimatingRef
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
  useCanvasKeyboardShortcuts({
    placementMode, setPlacementMode, activeTool, setActiveTool, setIsSettingsOpen,
    isAnimatingRef: isNavigationAnimatingRef,
    duplicateNodes, copyNodes, pasteNodes,
    shortcuts: settings.shortcuts
  });

  // ── WASD canvas navigation ───────────────────────────────────────────────
  useCanvasWASD({ isAnimatingRef: isNavigationAnimatingRef });

  // ── Issue Reporter ───────────────────────────────────────────────────────
  const { handleIssueSubmit } = useIssueReporter({
    nodes, edges, drawings, activeTool, placementMode, eraserType,
    settings, currentFile, hasUnsavedChanges, navigationDepth: navigation.depth,
    snapToGrid, addToast
  });

  // ── Animation overlay style ──────────────────────────────────────────────
  // animationDuration is a memoized value from useSettings (updates when animationSpeed changes)

  const handleReportBugClick = useCallback(() => setIsIssueReporterOpen(true), []);
  const handleCloseSettings = useCallback(() => setIsSettingsOpen(false), []);
  const handleCloseIssueReporter = useCallback(() => setIsIssueReporterOpen(false), []);

  const onNodesDeleteGuarded = useCallback((deleted) => {
    if (navigation.isAnimating) return;
    // Ensure locked nodes are NEVER deleted even if RF logic is bypassed
    const onlyDeletable = deleted.filter(n => !n.data?.locked);
    onNodesDelete(onlyDeletable);
  }, [navigation.isAnimating, onNodesDelete]);

  // ── Main canvas pointer guards ───────────────────────────────────────────
  // These wrap the drawing-mode handlers with animation/menu guards so that
  // drawing input is cleanly blocked during navigation transitions and while
  // tool-configuration popovers (color picker, eraser menu) are open.
  const onCanvasPointerDown = useCallback((e) => {
    if (toolMenuOpen || menu || navigation.isAnimating) return;
    handlePointerDown(e);
  }, [toolMenuOpen, menu, navigation.isAnimating, handlePointerDown]);

  const onCanvasPointerMove = useCallback((e) => {
    handlePointerMove(e);
    if (activeTool === 'eraser') {
      cursorsRef.current?.updateMouse({ x: e.clientX, y: e.clientY });
    }
  }, [handlePointerMove, activeTool, cursorsRef]);

  const onCanvasPointerLeave = useCallback((e) => {
    handlePointerUp(e);
    cursorsRef.current?.updateMouse({ x: -999, y: -999 });
  }, [handlePointerUp, cursorsRef]);

  // ── Render ───────────────────────────────────────────────────────────────
  // ── Multi-node customization ──────────────────────────────────────────
  useEffect(() => {
    const handleOpenMulti = (e) => {
      if (e.detail?.ids) {
        setCustomizeTargetIds(e.detail.ids);
      }
    };
    const handleOpenSettings = () => {
      setIsSettingsOpen(true);
    };
    document.addEventListener('open-multi-customize', handleOpenMulti);
    document.addEventListener('open-settings', handleOpenSettings);
    return () => {
      document.removeEventListener('open-multi-customize', handleOpenMulti);
      document.removeEventListener('open-settings', handleOpenSettings);
    };
  }, []);

  const handleCustomizeApply = useCallback((updates) => {
    if (customizeTargetIds.length === 0) return;
    const targetIds = new Set(customizeTargetIds);

    setNodes(nds => nds.map(n => {
      if (!targetIds.has(n.id)) return n;
      const filteredUpdates = filterNodeCustomizationUpdates(n, updates);
      if (Object.keys(filteredUpdates).length === 0) return n;
      return {
        ...n,
        data: { ...n.data, ...filteredUpdates }
      };
    }));

    // Remember the most recent text/link customization so newly-created text/link
    // nodes inherit it (read by `readLastTextStyle` in nodeFactory). We only
    // persist style when the user customized at least one text/link node, since
    // pure document-node updates (e.g. backgroundColor only) shouldn't override
    // the remembered text style.
    const targetTypes = customizeTargetIds
      .map(id => nodes.find(n => n.id === id)?.type)
      .filter(Boolean);
    if (targetTypes.some(t => t === 'text' || t === 'link')) {
      const styleFields = {};
      for (const k of ['fontSize', 'fontFamily', 'textColor', 'backgroundColor']) {
        if (updates[k] !== undefined) styleFields[k] = updates[k];
      }
      if (Object.keys(styleFields).length > 0) {
        const prev = settings.lastTextStyle || {};
        updateSetting('lastTextStyle', { ...prev, ...styleFields });
      }
    }
  }, [customizeTargetIds, setNodes, nodes, settings.lastTextStyle, updateSetting]);

  const customizeInitialData = useMemo(() => {
    if (customizeTargetIds.length === 0) return null;
    const targetIds = new Set(customizeTargetIds);
    return buildCustomizationDialogData(nodes.filter(n => targetIds.has(n.id)));
  }, [customizeTargetIds, nodes]);

  // Dashboard stats: computed once per node change here so <Sidebar> can be a
  // plain shallow-memo on primitive counts (no per-frame rescans in a comparator).
  const sidebarStats = useMemo(() => getStats(nodes), [nodes]);

  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar
        jobCardsCount={sidebarStats.jobCardsCount}
        sellHubsCount={sidebarStats.sellHubsCount}
        totalValue={sidebarStats.totalValue}
        onReportBugClick={handleReportBugClick}
      />

      <div
        className="flex-1 h-full relative"
        data-drawing-mode={activeTool || undefined}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={onCanvasPointerLeave}
      >
        <SearchBar />

        {loadState.active && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-neutral-950/80 backdrop-blur-sm">
            <div className="w-[min(360px,80vw)] rounded-lg border border-white/10 bg-neutral-900/95 p-4 shadow-2xl">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-white/85">Loading workspace</div>
                <div className="font-mono text-[10px] text-white/45">
                  {Math.round(Math.max(0, Math.min(1, loadState.progress || 0)) * 100)}%
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.round(Math.max(0, Math.min(1, loadState.progress || 0)) * 100)}%` }}
                />
              </div>
              <div className="mt-2 text-[10px] text-white/45">
                {loadState.label || 'Preparing canvas...'}
              </div>
            </div>
          </div>
        )}

        <CanvasCursors
          ref={cursorsRef}
          eraserSize={eraserSize}
          activeTool={activeTool}
          placementMode={placementMode}
        />

        {/* Canvas transition overlay */}
        {navigation.animPhase && (
          <div
            className="canvas-transition-overlay"
            style={{
              opacity: navigation.animPhase === 'fade-out' ? 1 : 0,
              transition: `opacity ${animationDuration / 2}ms ease-in-out`,
            }}
          />
        )}

        <CanvasNavigationContext.Provider value={navContextValue}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodesDelete={onNodesDeleteGuarded}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            nodeTypes={nodeTypes}
            onDoubleClick={handlePaneDoubleClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            snapToGrid={snapToGrid}
            snapGrid={[40, 40]}
            panOnDrag={interactiveDisabled ? false : (isSelectTool ? [1, 2] : [0, 1, 2])}
            selectionOnDrag={!interactiveDisabled && isSelectTool}
            selectionMode={SelectionMode.Partial}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            nodesDraggable={!interactiveDisabled}
            elementsSelectable={!interactiveDisabled}
            zoomOnScroll={false}
            zoomOnPinch={!interactiveDisabled}
            onWheelCapture={handleWheelZoom}
            onMoveEnd={handleViewportMoveEnd}
            minZoom={CANVAS_ZOOM_LIMITS.min}
            maxZoom={CANVAS_ZOOM_LIMITS.max}
            panOnScroll={false}
            autoPanOnNodeFocus={false}
            zoomOnDoubleClick={false}

            className="touch-none"
            deleteKeyCode={interactiveDisabled ? null : ['Backspace', 'Delete']}
            selectionKeyCode={interactiveDisabled ? null : ['Shift']}
            multiSelectionKeyCode={interactiveDisabled ? null : ['Control', 'Meta']}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          >
            <DrawingLayer ref={drawingLayerRef} drawings={drawings} activeColor={activeColor} penSize={penSize} />
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
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
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
              <CustomMiniMap nodes={nodes} edges={edges} drawings={drawings} isAnimating={navigation.isAnimating} />
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
            items={contextMenuItems}
            onClose={closeMenu}
          />
        )}

        <OnboardingOverlay />

        <SettingsPanel
          isOpen={isSettingsOpen}
          onClose={handleCloseSettings}
          settings={settings}
          updateSetting={updateSetting}
          updateShortcut={updateShortcut}
          resetShortcuts={resetShortcuts}
        />

        <IssueReporterDialog
          isOpen={isIssueReporterOpen}
          onClose={handleCloseIssueReporter}
          onSubmit={handleIssueSubmit}
        />

        {confirmDialogData && (
          <ConfirmDialog
            title={confirmDialogData.title}
            message={confirmDialogData.message}
            confirmLabel={confirmDialogData.confirmLabel}
            cancelLabel={confirmDialogData.cancelLabel}
            variant={confirmDialogData.variant}
            onConfirm={handleConfirmDialogConfirm}
            onCancel={handleConfirmDialogCancel}
            // Only render the X-to-abort affordance for dialogs whose caller
            // supplied an abort handler. Other dialogs (Clear Canvas, etc.)
            // don't need it because Cancel already preserves prior state.
            onAbort={confirmDialogData.onAbort ? handleConfirmDialogAbort : undefined}
          />
        )}

        {customizeTargetIds.length > 0 && customizeInitialData && (
          <CustomizeDialog
            {...customizeInitialData}
            onApply={handleCustomizeApply}
            onClose={() => setCustomizeTargetIds([])}
          />
        )}
      </div>
    </div>
  );
}
