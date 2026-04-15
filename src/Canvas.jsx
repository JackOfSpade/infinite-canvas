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
import { KeyboardShortcutsPanel, useKeyboardShortcuts } from './components/KeyboardShortcutsPanel';
import { EventLogger } from './utils/EventLogger';
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
    onNodesChangeBase(changes);
  }, [onNodesChangeBase, snapshotOnDelete]);

  const onEdgesChange = useCallback((changes) => {
    snapshotOnDelete(changes);
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase, snapshotOnDelete]);

  const { undo, redo, takeSnapshot, clearHistory, canUndo, canRedo } = useUndoRedo({
    nodes, edges, drawings, setNodes, setEdges, setDrawings,
    shortcuts: settings.shortcuts,
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
    if (activeTool || placementMode) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
    EventLogger.log(`Double-clicked canvas to create new Text Node`);
  }, [activeTool, placementMode, screenToFlowPosition, takeSnapshot, setNodes]);

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

  const { handleDrop, handleDragOver } = useCanvasDragAndDrop({
    setNodes, setIsDrawingMode: (v) => setActiveTool(v ? 'pen' : null), takeSnapshot,
  });

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
    isDrawingMode: activeTool === 'pen',
    placementMode,
    takeSnapshot,
    setNodes,
    screenToFlowPosition,
    clearCanvas,
    extractToParent: navigation.extractToParent,
    depth: navigation.depth
  });

  // ── Keyboard Shortcuts Panel ─────────────────────────────────────────────
  // Pressing '?' now opens the Settings panel (shortcuts live there)
  useEffect(() => {
    const handleKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // ── WASD canvas navigation ───────────────────────────────────────────────
  useEffect(() => {
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    let rafId = null;
    const BASE_SPEED = 6; // pixels per frame at zoom=1

    const step = () => {
      const { w, a, s, d, shift } = keys;
      if (!w && !a && !s && !d) { rafId = null; return; }
      const speed = shift ? BASE_SPEED * 5 : BASE_SPEED;
      const vp = getViewport();
      setViewport({
        x: vp.x + (a ? speed : d ? -speed : 0),
        y: vp.y + (w ? speed : s ? -speed : 0),
        zoom: vp.zoom,
      });
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
  const handleIssueSubmit = useCallback(async (description) => {
    if (!window.electronAPI) {
      addToast({ title: 'Bug Report', description: "Not running in Electron, can't save report.", type: "error" });
      return;
    }
    try {
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
        },
        eventLogs: EventLogger.getLogs(),
      };
      const res = await window.electronAPI.exportBugReport(payload);
      if (res.success) {
        addToast({ title: 'Bug Report Saved', description: 'Your report has been exported successfully.', type: "success" });
      } else if (!res.canceled) {
        addToast({ title: 'Bug Report Failed', description: res.error || 'Could not save the report.', type: "error" });
      }
    } catch (e) {
      addToast({ title: 'Bug Report Error', description: e.message || 'An unexpected error occurred.', type: "error" });
    }
  }, [nodes, edges, drawings, activeTool, placementMode, eraserType, settings, currentFile, hasUnsavedChanges, navigation.depth, snapToGrid, addToast]);

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
          // Only block drawing while a popup/context-menu is open
          if (toolMenuOpen || menu) return;
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
            onPaneContextMenu={onPaneContextMenuBase}
            onNodeContextMenu={onNodeContextMenuBase}
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
