import React, { useState, useCallback, useRef } from 'react';
import { NodeResizer, useReactFlow, Handle, Position, ReactFlowProvider, ReactFlow, Background, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { BoxSelect, X, ArrowUpRight, Minus, Pen } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { DrawingLayer } from '../components/DrawingLayer';
import { nodeTypes } from '../utils/constants'; // safe to import here as it's evaluated later

// Sub-component that actually uses the nested canvas context
const InnerCanvasContent = ({ id, data, selected, mainFlow }) => {
  const [title, setTitle] = useState(data.title || '');
  const nestedFlow = useReactFlow();
  const contentRef = useRef(null);

  const collapsed = data.collapsed !== false; 
  const isEmptyPredicate = () => !title.trim() && (data.nodes || []).length === 0;
  const titleInputRef = useRef(null);
  const { handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, titleInputRef);

  const handleTitleChange = useCallback((e) => {
    setTitle(e.target.value);
    mainFlow.updateNodeData(id, { title: e.target.value });
  }, [id, mainFlow]);

  const handleTitleBlur = useCallback(() => {
    handleBlur({ title: title.trim() });
  }, [title, handleBlur]);

  // ── Push / Pull Logic ──────────────────────────────────────────────────
  const expandWidth = 400;
  const expandHeight = 300;
  const iconSize = 72;

  const expandCanvas = useCallback(() => {
    const currentPos = mainFlow.getNode(id)?.position || { x: 0, y: 0 };
    const pushDeltaX = expandWidth - iconSize + 40;
    const pushDeltaY = expandHeight - iconSize + 40;

    mainFlow.setNodes(nds => {
      const pushedNodes = {};
      const updatedNds = nds.map(n => {
        if (n.id === id) {
          return {
            ...n,
            dragHandle: '.drag-handle',
            style: { ...(n.style || {}), width: expandWidth, height: expandHeight },
            data: { ...n.data, collapsed: false },
          };
        }
        
        let dx = 0;
        let dy = 0;
        // If node is horizontally to the right
        if (n.position.x >= currentPos.x + iconSize / 2) {
          dx = pushDeltaX;
        }
        // If node is vertically below
        if (n.position.y >= currentPos.y + iconSize / 2) {
          dy = pushDeltaY;
        }

        if (dx > 0 || dy > 0) {
          pushedNodes[n.id] = { dx, dy };
          return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
        }
        
        return n;
      });

      // Save the pushed mapping in data
      const selfNode = updatedNds.find(n => n.id === id);
      if (selfNode) selfNode.data.pushedNodes = pushedNodes;

      return updatedNds;
    });
  }, [id, mainFlow]);

  const collapseCanvas = useCallback(() => {
    mainFlow.setNodes(nds => {
      const selfNode = nds.find(n => n.id === id);
      const pushedNodes = selfNode?.data?.pushedNodes || {};

      return nds.map(n => {
        if (n.id === id) {
          const restStyle = { ...n.style };
          delete restStyle.width;
          delete restStyle.height;
          delete restStyle.minHeight;
          return {
            ...n,
            dragHandle: undefined,
            style: Object.keys(restStyle).length ? restStyle : undefined,
            data: { ...n.data, collapsed: true, pushedNodes: null },
          };
        }

        if (pushedNodes[n.id]) {
          const { dx, dy } = pushedNodes[n.id];
          return { ...n, position: { x: n.position.x - dx, y: n.position.y - dy } };
        }
        return n;
      });
    });
  }, [id, mainFlow]);

  const removeCanvas = useCallback(() => {
    mainFlow.setNodes(nds => nds.filter(n => n.id !== id));
    mainFlow.setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
  }, [id, mainFlow]);

  const detachAll = useCallback(() => {
    const pos = mainFlow.getNode(id)?.position || { x: 0, y: 0 };
    mainFlow.setNodes(nds => {
      let freshNodes = [...nds];
      const selfNode = freshNodes.find(n => n.id === id);
      const innerNodes = selfNode?.data?.nodes || [];
      
      // Map inner nodes to main canvas coordinate space
      innerNodes.forEach(inner => {
        freshNodes.push({
          ...inner,
          position: { 
            x: pos.x + inner.position.x + 20, 
            y: pos.y + inner.position.y + 40 
          }
        });
      });

      // Clear inner nodes
      return freshNodes.map(n => n.id === id ? { ...n, data: { ...n.data, nodes: [], edges: [] } } : n);
    });
  }, [id, mainFlow]);

  // We must track inner state explicitly
  const { nodes: innerNodes = [], edges: innerEdges = [], drawings = [] } = data;

  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [currentStroke, setCurrentStroke] = useState(null);

  const handlePointerDown = useCallback((e) => {
    if (!isDrawingMode) return;
    e.stopPropagation();
    setCurrentStroke([nestedFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
  }, [isDrawingMode, nestedFlow]);

  const handlePointerMove = useCallback((e) => {
    if (!isDrawingMode || !currentStroke) return;
    e.stopPropagation();
    setCurrentStroke(prev => [...prev, nestedFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
  }, [isDrawingMode, currentStroke, nestedFlow]);

  const handlePointerUp = useCallback(() => {
    if (!isDrawingMode || !currentStroke) return;
    if (currentStroke.length > 1) {
      mainFlow.setNodes(nds => nds.map(n => {
        if (n.id === id) {
          return { ...n, data: { ...n.data, drawings: [...(n.data.drawings || []), currentStroke] } };
        }
        return n;
      }));
    }
    setCurrentStroke(null);
  }, [isDrawingMode, currentStroke, id, mainFlow]);

  const handleInnerNodesChange = useCallback((changes) => {
    mainFlow.setNodes(nds => nds.map(n => {
      if (n.id === id) {
        return {
          ...n,
          data: { ...n.data, nodes: applyNodeChanges(changes, n.data.nodes || []) }
        };
      }
      return n;
    }));
  }, [id, mainFlow]);

  const handleInnerEdgesChange = useCallback((changes) => {
    mainFlow.setNodes(nds => nds.map(n => {
      if (n.id === id) {
        return {
          ...n,
          data: { ...n.data, edges: applyEdgeChanges(changes, n.data.edges || []) }
        };
      }
      return n;
    }));
  }, [id, mainFlow]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Use nestedFlow for coordinates.
    const position = nestedFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const nodeType = e.dataTransfer.getData('app/node-type');

    if (nodeType) {
      position.x -= 12;
      position.y -= 20;
      let newNode;
      if (nodeType === 'text') {
        newNode = { id: uuidv4(), type: 'text', position, data: { text: '', isNew: true } };
      } else if (nodeType === 'link') {
        newNode = { id: uuidv4(), type: 'link', position, data: { url: '', label: '', isNew: true } };
      } else if (nodeType === 'group') {
        newNode = { id: uuidv4(), type: 'group', dragHandle: '.drag-handle', style: { width: 320 }, position, data: { title: '', nodes: [], edges: [], collapsed: false, isNew: true } };
      }
      
      if (newNode) {
        mainFlow.setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, nodes: [...(n.data.nodes || []), newNode] } } : n));
      }
      return;
    }

    if (e.dataTransfer.files?.length > 0 && window.electronAPI) {
      const newItems = [];
      let currentPos = { ...position };
      for (const file of e.dataTransfer.files) {
        try {
          const result = await window.electronAPI.scanDirectory(file.path);
          if (result.isFile) {
            newItems.push({ id: result.file.id, type: 'document', position: { ...currentPos }, data: { filename: result.file.filename, filePath: result.file.filePath } });
          } else {
            newItems.push({ id: result.id, type: 'group', position: { ...currentPos }, data: { title: result.title, nodes: [], edges: [], collapsed: true } });
          }
          currentPos = { x: currentPos.x + 40, y: currentPos.y + 40 };
        } catch (err) { console.error('Drop failed:', err); }
      }
      if (newItems.length > 0) {
        mainFlow.setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, nodes: [...(n.data.nodes || []), ...newItems] } } : n));
      }
    }
  }, [id, mainFlow, nestedFlow]);

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLAPSED — icon on main canvas
  // ═══════════════════════════════════════════════════════════════════════════
  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center cursor-pointer group w-16 h-[72px]"
        onDoubleClick={expandCanvas}
      >
        <div className="relative">
          <BoxSelect size={48} className="text-blue-400 drop-shadow-lg group-hover:scale-110 transition-transform" />
          {innerNodes.length > 0 && (
            <span className="absolute -top-1 -right-2 bg-blue-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center shadow">
              {innerNodes.length}
            </span>
          )}
        </div>
        <span className="text-xs text-white/90 mt-1 max-w-[80px] truncate text-center select-none font-medium">
          {title || 'Canvas'}
        </span>

        <Handle type="target" position={Position.Left} id="canvas-target" className="opacity-0" />
        <Handle type="source" position={Position.Right} id="canvas-source" className="opacity-0" />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPANDED — resizable nested canvas
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <>
      <NodeResizer
        minWidth={250}
        minHeight={200}
        isVisible={selected}
        lineClassName="border-white/30"
        handleClassName="h-3 w-3 bg-white rounded-sm"
      />

      <div
        className="w-full h-full bg-[#111111]/95 backdrop-blur-md rounded-xl flex flex-col shadow-2xl transition-colors border-2"
        style={{ borderColor: selected ? '#60a5fa' : 'rgba(255,255,255,0.2)', minWidth: 250, minHeight: 200 }}
      >
        {/* ── Title Bar (Breaking the border visual) ────────────────────── */}
        <div className="absolute top-[-14px] left-4 bg-[#111111] px-2 flex items-center gap-1.5 drag-handle cursor-move rounded-md border border-white/10 group/header z-50">
          <button
            className="w-3.5 h-3.5 bg-amber-400 hover:bg-amber-500 rounded-full shrink-0 transition-colors flex items-center justify-center"
            onClick={(e) => { e.stopPropagation(); collapseCanvas(); }}
            title="Minimize to icon"
          >
            <Minus size={8} className="text-amber-900" />
          </button>
          
          <BoxSelect size={14} className="text-blue-400 shrink-0" />

          <div className="relative flex-1 min-w-[100px] w-auto max-w-[200px]">
             <input
              ref={titleInputRef}
              type="text"
              className="bg-transparent text-white/90 text-xs font-semibold focus:outline-none focus:text-white w-full"
              value={title}
              onChange={handleTitleChange}
              onBlur={handleTitleBlur}
              placeholder="Nested Canvas"
              onPointerDown={(e) => e.stopPropagation()}
            />
          </div>

          <button
            className={`p-0.5 transition-colors ${isDrawingMode ? 'text-blue-400' : 'text-white/20 hover:text-white/80'}`}
            onClick={(e) => { e.stopPropagation(); setIsDrawingMode(prev => !prev); }}
            title="Toggle Drawing Mode"
          >
            <Pen size={12} />
          </button>

          <button
            className="p-0.5 text-white/20 hover:text-blue-400 transition-colors ml-1"
            onClick={(e) => { e.stopPropagation(); detachAll(); }}
            title="Detach all contents to main canvas"
          >
            <ArrowUpRight size={12} />
          </button>
          <button
            className="p-0.5 text-white/20 hover:text-red-400 transition-colors"
            onClick={(e) => { e.stopPropagation(); removeCanvas(); }}
            title="Delete canvas"
          >
            <X size={12} />
          </button>
        </div>

        {/* ── Canvas Content Area ───────────────────────────────────────── */}
        <div
          ref={contentRef}
          className="flex-1 w-full relative rounded-b-xl overflow-hidden mt-1"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          data-drawing-mode={isDrawingMode || undefined}
        >
          <ReactFlow
            nodes={innerNodes}
            edges={innerEdges}
            onNodesChange={handleInnerNodesChange}
            onEdgesChange={handleInnerEdgesChange}
            panOnDrag={!isDrawingMode}
            selectionOnDrag={!isDrawingMode}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            panOnScroll={false}
            nodeTypes={nodeTypes}
            proOptions={{ hideAttribution: true }}
            className={`touch-none ${isDrawingMode ? 'cursor-crosshair' : ''}`}
            nodesDraggable={!isDrawingMode}
            nodesConnectable={!isDrawingMode}
            elementsSelectable={!isDrawingMode}
          >
            <Background color="#555" gap={20} size={2} />
            <DrawingLayer drawings={drawings} currentStroke={currentStroke} />
          </ReactFlow>
          {innerNodes.length === 0 && drawings.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-white/20 text-sm pointer-events-none">
              Drag tools or items here
            </div>
          )}
        </div>
      </div>

      <Handle type="target" position={Position.Left} id="canvas-target" className="opacity-0 w-full h-full" />
      <Handle type="source" position={Position.Right} id="canvas-source" className="opacity-0 w-full h-full" />
    </>
  );
};

// Top-level exported node maps the main flow to the inner content
export function CanvasNode(props) {
  const mainFlow = useReactFlow();
  
  return (
    <ReactFlowProvider>
      <InnerCanvasContent {...props} mainFlow={mainFlow} />
    </ReactFlowProvider>
  );
}
