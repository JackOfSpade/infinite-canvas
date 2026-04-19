import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  ControlButton,
  useReactFlow
} from '@xyflow/react';

import { DocumentNode } from './nodes/DocumentNode';
import { TextNode } from './nodes/TextNode';
import { CanvasNode, ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from './nodes/CanvasNode';
import { LinkNode } from './nodes/LinkNode';
import { ListingNode } from './nodes/ListingNode';
import { JobCardNode } from './nodes/JobCardNode';
import { JobHubNode } from './nodes/JobHubNode';
import { SellHubNode } from './nodes/SellHubNode';

import { createTextNode, NODE_FACTORIES } from './utils/nodeFactory';
import { Sidebar } from './components/Sidebar';
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
import { DEFAULT_EDGE_OPTIONS } from './utils/constants';

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

const nodeTypes = {
  document: DocumentNode,
  text: TextNode,
  group: CanvasNode, // Keep 'group' key for backward compatibility of saved nodes, but map it to CanvasNode
  link: LinkNode,
  listing: ListingNode,
  jobcard: JobCardNode,
  jobhub: JobHubNode,
  sellhub: SellHubNode,
};

// ── Canvas ───────────────────────────────────────────────────────────────────
export function Canvas() {
  const reactFlowWrapper = useRef(null);
  const cursorsRef = useRef(null);
  const drawingLayerRef = useRef(null);
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
  const { screenToFlowPosition, getIntersectingNodes, getNode } = useReactFlow();
  const isInteractionRef = useRef(false);

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
    isInteractionRef,
  });
  useEffect(() => { takeSnapshotRef.current = takeSnapshot; }, [takeSnapshot]);

  const { onNodeDragStart, onNodeDragStop } = useDragCorrections({ 
    setNodes, 
    setEdges,
    getIntersectingNodes,
    takeSnapshot
  });

  const customFitView = useCustomFitView(reactFlowWrapper, nodes, drawings, isNavigationAnimatingRef);

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
    hasUnsavedChanges, setHasUnsavedChanges, currentFile, setCurrentFile,
  } = useCanvasPersistence({
    nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast,
    flushStack: navigation.flushStack,
    resetStack: navigation.resetStack,
    clearHistory,
    isAnimatingRef: isNavigationAnimatingRef,
  });

  useCanvasInitialization({
    nodes, edges, drawings, currentFile, setCurrentFile, hasUnsavedChanges, setHasUnsavedChanges,
    flushStack: navigation.flushStack,
    isAnimatingRef: isNavigationAnimatingRef,
  });

  // ── Native Menu Wiring ───────────────────────────────────────────────────
  // Binds the native macOS/Windows application menu items (File -> Save, Open, etc.)
  // to the React-managed canvas state inside this window.
  useEffect(() => {
    const unlistenSave = window.electronAPI?.onMenuSave?.(() => {
      if (!isNavigationAnimatingRef.current) saveCanvas();
    });
    const unlistenOpen = window.electronAPI?.onMenuOpen?.(() => {
      if (!isNavigationAnimatingRef.current) loadCanvas();
    });
    const unlistenExport = window.electronAPI?.onMenuExportPng?.(() => {
      if (!isNavigationAnimatingRef.current) exportCanvasToPNG();
    });
    
    return () => {
      unlistenSave?.();
      unlistenOpen?.();
      unlistenExport?.();
    };
  }, [saveCanvas, loadCanvas, exportCanvasToPNG]);

  // ── Generic Confirmation Dialog ───────────────────────────────────────────
  const {
    confirmDialogData,
    setConfirmDialogData,
    requestConfirm,
    requestClearConfirm
  } = useConfirmDialog();

  // ── Canvas interactions ──────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState(null); // 'pen' | 'eraser' | null
  const [eraserType, setEraserType] = useState('object'); // 'object' | 'pixel'
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
  const { onNestedCanvasDragStart } = useNestedCanvasDrag({
    isAnimatingRef: isNavigationAnimatingRef,
    screenToFlowPosition,
    takeSnapshot,
    setNodes,
    cursorsRef,
  });

  const handlePaneDoubleClick = useCallback((e) => {
    if (activeTool || placementMode || navigation.isAnimating) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
    EventLogger.log(`Double-clicked canvas to create new Text Node`);
  }, [activeTool, placementMode, navigation.isAnimating, screenToFlowPosition, takeSnapshot, setNodes]);

  const onNodeDoubleClick = useCallback((e, node) => {
    if (node.type === 'group' && !node.data?.locked && !navigation.isAnimating) {
      navigation.diveIn(node.id);
    }
  }, [navigation]);

  // Prevent drawing edges TO sticky notes — sticky notes are output-only anchors
  const isValidConnection = useCallback((connection) => {
    const target = getNode(connection.target);
    if (target?.data?.isSticky) return false;
    return true;
  }, [getNode]);

  const { handleDrop: handleDropBase, handleDragOver } = useCanvasDragAndDrop({
    setNodes, setIsDrawingMode: (v) => setActiveTool(v ? 'pen' : null), takeSnapshot, depth: navigation.depth, updateGlobal: navigation.updateNodeDataGlobally
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

  const { onNodesDelete } = useCanvasOSDeletion({ requestConfirm });

  const { onConnect, onDragStart, clearCanvas } = useCanvasActions({
    setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, takeSnapshot, requestClearConfirm,
    resetStack: navigation.resetStack,
    depth: navigation.depth, updateGlobal: navigation.updateNodeDataGlobally,
    isAnimatingRef: isNavigationAnimatingRef,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, activeTool, eraserType, eraserSize,
    setDrawings, setNodes, setEdges, takeSnapshot, activeColor,
    penSize, getIntersectingNodes, isAnimatingRef: isNavigationAnimatingRef,
    cursorsRef, drawingLayerRef, isInteractionRef
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
    depth: navigation.depth, updateGlobal: navigation.updateNodeDataGlobally
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
    isAnimatingRef: isNavigationAnimatingRef 
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
  const animDuration = getAnimationDuration();

  const handleReportBugClick = useCallback(() => setIsIssueReporterOpen(true), []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar nodes={nodes} onReportBugClick={handleReportBugClick} />

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
            cursorsRef.current?.updateMouse({ x: e.clientX, y: e.clientY });
          }
        }}
        onPointerUp={handlePointerUp}
        onPointerLeave={(e) => {
          handlePointerUp(e);
          cursorsRef.current?.updateMouse({ x: -999, y: -999 });
        }}
      >
        <SearchBar />

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
            onNodesDelete={(deleted) => {
              if (navigation.isAnimating) return;
              // Ensure locked nodes are NEVER deleted even if RF logic is bypassed
              const onlyDeletable = deleted.filter(n => !n.data?.locked);
              onNodesDelete(onlyDeletable);
            }}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            nodeTypes={nodeTypes}
            onDoubleClick={handlePaneDoubleClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            snapToGrid={snapToGrid}
            snapGrid={[40, 40]}
            panOnDrag={interactiveDisabled ? false : [1, 2]}
            selectionOnDrag={!interactiveDisabled}
            nodesDraggable={!interactiveDisabled}
            elementsSelectable={!interactiveDisabled}
            zoomOnScroll={!interactiveDisabled}
            zoomOnPinch={!interactiveDisabled}
            panOnScroll={!interactiveDisabled}
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
