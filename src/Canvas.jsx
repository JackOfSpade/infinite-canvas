import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  useReactFlow
} from '@xyflow/react';

import { createTextNode } from './utils/nodeFactory';
import { Sidebar } from './components/Sidebar';
import { ContextMenu } from './components/ContextMenu';
import { CanvasToolbar } from './components/CanvasToolbar';
import { SearchBar } from './components/SearchBar';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { DrawingLayer } from './components/DrawingLayer';
import { EmptyCanvasHint } from './components/EmptyCanvasHint';
import { StatusBar } from './components/StatusBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { BreadcrumbBar } from './components/BreadcrumbBar';
import { SettingsPanel } from './components/SettingsPanel';
import { IssueReporterDialog } from './components/IssueReporterDialog';
import { KeyboardShortcutsPanel, useKeyboardShortcuts } from './components/KeyboardShortcutsPanel';
import { EventLogger } from './utils/EventLogger';
import { CanvasNavigationContext } from './contexts/CanvasNavigationContext';
import { nodeTypes, DEFAULT_EDGE_OPTIONS, MINIMAP_NODE_COLORS } from './utils/constants';
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
  const { settings, updateSetting, getAnimationDuration } = useSettings();
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
      message: "This will remove all nodes, edges, and drawings. This action can be undone with Ctrl+Z.",
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
  const [placementMode, setPlacementMode] = useState(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [bgVariant, setBgVariant] = useState('dots');
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [activeColor, setActiveColor] = useState('white');
  const { screenToFlowPosition, getIntersectingNodes } = useReactFlow();

  const handlePaneDoubleClick = useCallback((e) => {
    if (activeTool || placementMode) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
    EventLogger.log(`Double-clicked canvas to create new Text Node`);
  }, [activeTool, placementMode, screenToFlowPosition, takeSnapshot, setNodes]);

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
    setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, takeSnapshot, requestClearConfirm
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, activeTool, eraserType, currentStroke, setCurrentStroke, 
    setMousePos, setDrawings, setNodes, setEdges, takeSnapshot, activeColor,
    getIntersectingNodes
  });

  const interactiveDisabled = !!activeTool || !!placementMode || navigation.isAnimating;

  // ── Context Menu Logic ───────────────────────────────────────────────────
  const { menu, closeMenu, onPaneContextMenuBase, onNodeContextMenuBase, getContextMenuItems } = useCanvasContextMenu({
    isDrawingMode: activeTool === 'pen',
    placementMode,
    takeSnapshot,
    setNodes,
    setEdges,
    screenToFlowPosition,
    clearCanvas
  });

  // ── Keyboard Shortcuts Panel ─────────────────────────────────────────────
  const { isOpen: isShortcutsOpen, toggle: toggleShortcuts, close: closeShortcuts } = useKeyboardShortcuts();

  // ── Issue Reporter ───────────────────────────────────────────────────────
  const handleIssueSubmit = useCallback(async (description) => {
    if (!window.electronAPI) {
      addToast({ message: "Not running in Electron, can't save report.", type: "error" });
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
          bgVariant,
          showMiniMap,
          windowInnerWidth: window.innerWidth,
          windowInnerHeight: window.innerHeight,
        },
        eventLogs: EventLogger.getLogs(),
      };
      const res = await window.electronAPI.exportBugReport(payload);
      if (res.success) {
        addToast({ message: "Bug report saved successfully!", type: "success" });
      } else if (!res.canceled) {
        addToast({ message: "Failed to save bug report: " + res.error, type: "error" });
      }
    } catch (e) {
      addToast({ message: "Failed: " + e.message, type: "error" });
    }
  }, [nodes, edges, drawings, activeTool, placementMode, eraserType, settings, currentFile, hasUnsavedChanges, navigation.depth, snapToGrid, bgVariant, showMiniMap, addToast]);

  // ── Animation overlay style ──────────────────────────────────────────────
  const animDuration = getAnimationDuration();

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar nodes={nodes} />

      <div
        className="flex-1 h-full relative"
        data-drawing-mode={activeTool || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <SearchBar nodes={nodes} />

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
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            nodeTypes={nodeTypes}
            onDoubleClick={handlePaneDoubleClick}
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
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(96,165,250)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                  </svg>
                )}
              </div>
            )}

            <DrawingLayer drawings={drawings} currentStroke={currentStroke} activeColor={activeColor} />
            <EmptyCanvasHint nodeCount={nodes.length} drawingCount={drawings.length} />
            {bgVariant !== 'none' && (
              <Background variant={bgVariant} color="rgba(255,255,255,0.06)" gap={32} size={2} />
            )}

            <Controls
              className="border border-white/10 shadow-lg overflow-hidden flex flex-col"
              buttonClassName="!bg-[#1a1a1a] !border-b-white/10 hover:!bg-[#333] transition-colors"
              style={{ display: 'flex', flexDirection: 'column' }}
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
              <MiniMap
                style={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                nodeColor={(n) => MINIMAP_NODE_COLORS[n.type] || '#555'}
                maskColor="rgba(0, 0, 0, 0.6)"
                position="bottom-right"
                zoomable
                pannable
              />
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
              activeColor={activeColor}
              setActiveColor={setActiveColor}
              snapToGrid={snapToGrid}
              setSnapToGrid={setSnapToGrid}
              bgVariant={bgVariant}
              setBgVariant={setBgVariant}
              showMiniMap={showMiniMap}
              setShowMiniMap={setShowMiniMap}
              onDragStart={onDragStart}
              saveCanvas={saveCanvas}
              saveState={saveState}
              hasUnsavedChanges={hasUnsavedChanges}
              undo={undo}
              redo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
              clearCanvas={clearCanvas}
              clearDrawings={clearDrawings}
              exportCanvasToPNG={exportCanvasToPNG}
              loadCanvas={loadCanvas}
              onHelpClick={toggleShortcuts}
              onSettingsClick={() => setIsSettingsOpen(true)}
            />

            <StatusBar
              nodeCount={nodes.length}
              edgeCount={edges.length}
              onHelpClick={toggleShortcuts}
              onReportBugClick={() => setIsIssueReporterOpen(true)}
            />
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

        <KeyboardShortcutsPanel isOpen={isShortcutsOpen} onClose={closeShortcuts} />

        <SettingsPanel
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          updateSetting={updateSetting}
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
