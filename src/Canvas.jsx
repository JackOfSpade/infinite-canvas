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

// Node types
import { DocumentNode } from './nodes/DocumentNode';
import { TextNode } from './nodes/TextNode';
import { CanvasNode } from './nodes/CanvasNode';
import { LinkNode } from './nodes/LinkNode';
import { ListingNode } from './nodes/ListingNode';
import { createTextNode } from './utils/nodeFactory';

// Components
import { Sidebar } from './components/Sidebar';
import { Dialog } from './components/Dialog';
import { CanvasToolbar } from './components/CanvasToolbar';
import { SearchBar } from './components/SearchBar';
import { StartupWarning } from './components/StartupWarning';
import { useUndoRedo } from './hooks/useUndoRedo';
import { toPng } from 'html-to-image';

import { nodeTypes, DEFAULT_EDGE_OPTIONS } from './utils/constants';
import { DrawingLayer } from './components/DrawingLayer';
import { useCustomFitView } from './hooks/useCustomFitView';
import { useCanvasDragAndDrop } from './hooks/useCanvasDragAndDrop';
import { useDrawingMode } from './hooks/useDrawingMode';
import { useCanvasInitialization } from './hooks/useCanvasInitialization';
import { useMarketplaceListings } from './hooks/useMarketplaceListings';
import { useCanvasActions } from './hooks/useCanvasActions';

// ── Canvas ───────────────────────────────────────────────────────────────────
export function Canvas() {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  const [drawings, setDrawings] = useState([]);

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  const snapshotTakenForDeleteRef = useRef(false);
  const takeSnapshotRef = useRef(null);

  const onNodesChange = useCallback((changes) => {
    if (changes.some(c => c.type === 'remove') && !snapshotTakenForDeleteRef.current) {
      snapshotTakenForDeleteRef.current = true;
      takeSnapshotRef.current?.();
      requestAnimationFrame(() => { snapshotTakenForDeleteRef.current = false; });
    }
    onNodesChangeBase(changes);
  }, [onNodesChangeBase]);

  const onEdgesChange = useCallback((changes) => {
    if (changes.some(c => c.type === 'remove') && !snapshotTakenForDeleteRef.current) {
      snapshotTakenForDeleteRef.current = true;
      takeSnapshotRef.current?.();
      requestAnimationFrame(() => { snapshotTakenForDeleteRef.current = false; });
    }
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase]);

  const { undo, redo, takeSnapshot, canUndo, canRedo } = useUndoRedo({
    nodes, edges, drawings, setNodes, setEdges, setDrawings,
  });
  useEffect(() => { takeSnapshotRef.current = takeSnapshot; }, [takeSnapshot]);

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [saveState, setSaveState] = useState('idle');

  const customFitView = useCustomFitView(reactFlowWrapper, nodes, drawings);

  const saveCanvas = useCallback(async () => {
    if (!window.electronAPI || saveState !== 'idle') return;
    setSaveState('saving');
    try {
      const res = await window.electronAPI.saveWorkspace({ data: { nodes, edges, drawings }, filePath: currentFile });
      if (res?.success && res.filePath) {
        setCurrentFile(res.filePath);
        setHasUnsavedChanges(false);
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 1500);
      } else {
        setSaveState('idle');
      }
    } catch (err) {
      console.error('Failed to save canvas:', err);
      setSaveState('idle');
    }
  }, [nodes, edges, drawings, currentFile, saveState]);

  const loadCanvas = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const res = await window.electronAPI.loadWorkspace();
      if (res?.success && res.data) {
        setNodes(res.data.nodes || []);
        setEdges(res.data.edges || []);
        setDrawings(res.data.drawings || []);
        setCurrentFile(res.filePath);
        setHasUnsavedChanges(false);
        setTimeout(() => customFitView(), 50);
      } else if (!res?.canceled) {
        alert('Failed to load canvas or invalid file format.');
      }
    } catch (err) {
      console.error('Failed to load canvas:', err);
    }
  }, [setNodes, setEdges, customFitView]);

  useCanvasInitialization({
    nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, saveCanvas, loadCanvas
  });

  const exportCanvasToPNG = useCallback(() => {
    const viewportNode = document.querySelector('.react-flow__viewport');
    if (!viewportNode) return;
    toPng(viewportNode, { backgroundColor: '#0a0a0a' })
      .then((dataUrl) => {
        const link = document.createElement('a');
        link.download = 'canvas-export.png';
        link.href = dataUrl;
        link.click();
      })
      .catch((err) => {
        console.error('Failed to export image', err);
      });
  }, []);

  const { onListingDragStart, triggerPendingListing, listingDialog } = useMarketplaceListings(setNodes, takeSnapshot);

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
    nodes, setNodes, setEdges, setIsDrawingMode, setPendingListing: triggerPendingListing, takeSnapshot
  });

  const { onConnect, onDragStart, addGroupNode, clearCanvas } = useCanvasActions({
    nodes, edges, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, takeSnapshot
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = useDrawingMode({
    placementMode, setPlacementMode, isDrawingMode, currentStroke, setCurrentStroke, setMousePos, setDrawings, setNodes, takeSnapshot, activeColor
  });

  const interactiveDisabled = isDrawingMode || !!placementMode;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-screen h-screen bg-neutral-950 flex" ref={reactFlowWrapper}>
      <Sidebar onDragStart={onListingDragStart} />

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
          onPaneDoubleClick={handlePaneDoubleClick}
          snapToGrid={snapToGrid}
          snapGrid={[40, 40]}
          panOnDrag={!interactiveDisabled}
          selectionOnDrag={!interactiveDisabled}
          nodesDraggable={!interactiveDisabled}
          autoPanOnNodeFocus={false}

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

          <DrawingLayer drawings={drawings} currentStroke={currentStroke} />
          <Background color="#555" gap={40} size={3} />
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
            nodeColor={(n) => {
              if (n.type === 'group') return '#3b82f6';
              if (n.type === 'document') return '#8b5cf6';
              if (n.type === 'text') return '#10b981';
              if (n.type === 'listing') return '#f59e0b';
              return '#555';
            }}
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
            exportCanvasToPNG={exportCanvasToPNG}
          />
        </ReactFlow>

        {listingDialog}

        <StartupWarning />
      </div>
    </div>
  );
}
