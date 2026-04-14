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
import { KeyboardShortcutsPanel, useKeyboardShortcuts } from './components/KeyboardShortcutsPanel';
import { nodeTypes, DEFAULT_EDGE_OPTIONS, MINIMAP_NODE_COLORS } from './utils/constants';
import { useUndoRedo } from './hooks/useUndoRedo';
import { useCustomFitView } from './hooks/useCustomFitView';
import { useCanvasPersistence } from './hooks/useCanvasPersistence';
import { useCanvasDragAndDrop } from './hooks/useCanvasDragAndDrop';
import { useDrawingMode } from './hooks/useDrawingMode';
import { useCanvasInitialization } from './hooks/useCanvasInitialization';
import { useCanvasActions } from './hooks/useCanvasActions';
import { useCanvasContextMenu } from './hooks/useCanvasContextMenu';
import { useToast } from './components/ToastProvider';

// ── Canvas ───────────────────────────────────────────────────────────────────
export function Canvas() {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [drawings, setDrawings] = useState([]);
  const { addToast } = useToast();

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

  const { undo, redo, takeSnapshot, canUndo, canRedo } = useUndoRedo({
    nodes, edges, drawings, setNodes, setEdges, setDrawings,
  });
  useEffect(() => { takeSnapshotRef.current = takeSnapshot; }, [takeSnapshot]);

  const customFitView = useCustomFitView(reactFlowWrapper, nodes, drawings);

  const {
    saveCanvas, loadCanvas, exportCanvasToPNG,
    saveState, hasUnsavedChanges, setHasUnsavedChanges, currentFile, setCurrentFile,
  } = useCanvasPersistence({
    nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast,
  });

  useCanvasInitialization({
    nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, saveCanvas, loadCanvas
  });

  // ── Clear Canvas Confirmation ───────────────────────────────────────────
  const [clearConfirm, setClearConfirm] = useState(null);
  const requestClearConfirm = useCallback((onConfirm) => {
    setClearConfirm({ onConfirm });
  }, []);

  // ── Canvas interactions ──────────────────────────────────────────────────
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [currentStroke, setCurrentStroke] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [placementMode, setPlacementMode] = useState(null);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [activeColor, setActiveColor] = useState('white');
  const { screenToFlowPosition } = useReactFlow();

  const handlePaneDoubleClick = useCallback((e) => {
    if (isDrawingMode || placementMode) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = createTextNode({ x: pos.x - 100, y: pos.y - 20 });
    setNodes((nds) => nds.concat(newNode));
  }, [isDrawingMode, placementMode, screenToFlowPosition, takeSnapshot, setNodes]);

  const { handleDrop, handleDragOver, onNodeDragStop } = useCanvasDragAndDrop({
    nodes, setNodes, setEdges, setIsDrawingMode, takeSnapshot,
  });

  const clearDrawings = useCallback(() => {
    takeSnapshot();
    setDrawings([]);
  }, [takeSnapshot, setDrawings]);

  const { onConnect, onDragStart, addGroupNode, clearCanvas } = useCanvasActions({
    nodes, edges, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, takeSnapshot, requestClearConfirm
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, isDrawingMode, currentStroke, setCurrentStroke, setMousePos, setDrawings, setNodes, takeSnapshot, activeColor
  });

  const interactiveDisabled = isDrawingMode || !!placementMode;

  // ── Context Menu Logic ───────────────────────────────────────────────────
  const { menu, closeMenu, onPaneContextMenuBase, onNodeContextMenuBase, getContextMenuItems } = useCanvasContextMenu({
    isDrawingMode,
    placementMode,
    takeSnapshot,
    setNodes,
    setEdges,
    screenToFlowPosition,
    clearCanvas
  });

  // ── Keyboard Shortcuts Panel ─────────────────────────────────────────────
  const { isOpen: isShortcutsOpen, toggle: toggleShortcuts, close: closeShortcuts } = useKeyboardShortcuts();

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar nodes={nodes} />

      <div
        className="flex-1 h-full relative"
        data-drawing-mode={isDrawingMode || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <SearchBar nodes={nodes} />

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          nodeTypes={nodeTypes}
          onNodeDragStop={onNodeDragStop}
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
          <Background color="rgba(255,255,255,0.06)" gap={32} size={2} />
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
          </Controls>

          <MiniMap
            style={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
            nodeColor={(n) => MINIMAP_NODE_COLORS[n.type] || '#555'}
            maskColor="rgba(0, 0, 0, 0.6)"
            position="bottom-right"
            zoomable
            pannable
          />

          <CanvasToolbar
            placementMode={placementMode}
            setPlacementMode={setPlacementMode}
            isDrawingMode={isDrawingMode}
            setIsDrawingMode={setIsDrawingMode}
            activeColor={activeColor}
            setActiveColor={setActiveColor}
            snapToGrid={snapToGrid}
            setSnapToGrid={setSnapToGrid}
            onDragStart={onDragStart}
            addGroupNode={addGroupNode}
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
          />

          <StatusBar
            nodeCount={nodes.length}
            edgeCount={edges.length}
            onHelpClick={toggleShortcuts}
          />
        </ReactFlow>

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

        {clearConfirm && (
          <ConfirmDialog
            title="Clear Canvas"
            message="This will remove all nodes, edges, and drawings. This action can be undone with Ctrl+Z."
            confirmLabel="Clear Everything"
            cancelLabel="Keep Canvas"
            variant="danger"
            onConfirm={() => {
              clearConfirm.onConfirm();
              setClearConfirm(null);
            }}
            onCancel={() => setClearConfirm(null)}
          />
        )}
      </div>
    </div>
  );
}
