import React, { useContext, useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react';
import { Layers, X, Lock } from 'lucide-react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';

/**
 * CanvasNode — a nested canvas displayed as a thumbnail card on the parent canvas.
 *
 * Double-click to dive in (full-screen sub-canvas).
 * The thumbnail shows a live SVG minimap of the sub-canvas contents.
 *
 * Replaces the old inline-expand CanvasNode that embedded a nested ReactFlow.
 */
export const CanvasNode = React.memo(function CanvasNode({ id, data, selected }) {
  const nav = useContext(CanvasNavigationContext);
  const mainFlow = useReactFlow();
  const [title, setTitle] = useState(data.title || '');
  const titleInputRef = useRef(null);

  // Sync local title when data changes externally (e.g. undo/redo)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(data.title || '');
  }, [data.title]);

  // Resolve canvas data (supports old and new data shape)
  const canvasData = data.canvasData || {
    nodes: data.nodes || [],
    edges: data.edges || [],
    drawings: data.drawings || [],
  };

  const nodeCount = (canvasData.nodes?.length || 0);

  // Auto-edit: new node auto-focuses the title input
  // Canvas nodes are never considered "empty" — they always persist even without a title
  const isEmptyPredicate = () => false;
  const { handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, titleInputRef);

  const handleTitleChange = useCallback((e) => {
    setTitle(e.target.value);
    mainFlow.updateNodeData(id, { title: e.target.value });
  }, [id, mainFlow]);

  const handleTitleBlur = useCallback(() => {
    handleBlur({ title: title.trim() });
  }, [title, handleBlur]);

  const handleDoubleClick = useCallback((e) => {
    // Don't dive in if clicking on the title input
    if (e.target.tagName === 'INPUT') return;
    e.stopPropagation();
    nav?.diveIn(id);
  }, [id, nav]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    mainFlow.deleteElements({ nodes: [{ id }] });
  }, [id, mainFlow]);

  return (
    <>
      <NodeResizer
        minWidth={140}
        minHeight={100}
        isVisible={selected}
        lineClassName="border-white/20"
        handleClassName="h-2.5 w-2.5 bg-white/80 rounded-sm"
      />

      <div
        className="nested-canvas-card group relative"
        onDoubleClick={handleDoubleClick}
        style={{
          borderColor: selected ? 'rgba(96, 165, 250, 0.6)' : 'rgba(255, 255, 255, 0.08)',
          backgroundColor: data.backgroundColor || 'rgba(18, 18, 22, 0.95)'
        }}
      >
        {data.locked && (
          <div className="absolute -top-2 -right-2 bg-black/80 rounded-full p-1 text-white/70 backdrop-blur-sm pointer-events-none z-20">
            <Lock size={12} />
          </div>
        )}
        {/* Thumbnail preview area */}
        <div className="flex-1 min-h-0 relative overflow-hidden rounded-t-lg">
          <CanvasThumbnail
            canvasData={canvasData}
            width="100%"
            height="100%"
          />

          {/* Node count badge */}
          {nodeCount > 0 && (
            <span className="absolute top-1.5 right-1.5 bg-blue-500/90 text-white text-[9px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center shadow-md badge-bounce">
              {nodeCount}
            </span>
          )}

          {/* Double-click hint on hover */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
            <span className="text-[10px] text-white/80 bg-black/50 rounded-full px-2.5 py-1 backdrop-blur-sm font-medium">
              Double-click to open
            </span>
          </div>

          {/* Delete button */}
          {!data.locked && (
            <button
              onClick={handleDelete}
              className="absolute top-1 left-1 p-1 rounded-md bg-black/40 text-white/0 group-hover:text-white/60 hover:!text-red-400 hover:!bg-red-400/20 transition-all backdrop-blur-sm"
              title="Delete canvas"
            >
              <X size={10} />
            </button>
          )}
        </div>

        {/* Title bar */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-white/[0.06] bg-white/[0.02]">
          <Layers size={12} className="text-blue-400 shrink-0" />
          <input
            ref={titleInputRef}
            type="text"
            className="flex-1 min-w-0 bg-transparent text-white/80 text-[11px] font-medium focus:outline-none focus:text-white placeholder-white/25 truncate"
            value={title}
            onChange={handleTitleChange}
            onBlur={handleTitleBlur}
            placeholder="Sub-Canvas"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>

      <Handle type="target" position={Position.Left} id="canvas-target" className="opacity-0" />
      <Handle type="source" position={Position.Right} id="canvas-source" className="opacity-0" />
    </>
  );
});
