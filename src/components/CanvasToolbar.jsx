import React from 'react';
import { Panel } from '@xyflow/react';
import { Type, BoxSelect, Trash2, Save, Link2, Check, MoreHorizontal, PenTool, Undo2, Redo2, Folder, Download } from 'lucide-react';

/**
 * Bottom toolbar for the canvas.
 * Contains buttons for adding nodes, drawing, save/load, undo/redo, and clear.
 *
 * All behavior is driven by stable callbacks passed from Canvas.
 */
export const CanvasToolbar = React.memo(function CanvasToolbar({
  placementMode,
  setPlacementMode,
  isDrawingMode,
  setIsDrawingMode,
  onDragStart,
  addGroupNode,
  saveCanvas,
  saveState,
  hasUnsavedChanges,
  undo,
  redo,
  canUndo,
  canRedo,
  clearCanvas,
  exportCanvasToPNG,
}) {
  return (
    <Panel position="bottom-center" className="glass-card mb-4 rounded-full p-2 flex gap-2 bg-black/60 border border-white/10 items-center">
      <button 
        draggable
        onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'text'); }}
        onClick={() => { setIsDrawingMode(false); setPlacementMode('text'); }} 
        className={`p-3 rounded-full transition ${placementMode === 'text' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
        title="Add Text (Drag or Click to place)"
      >
        <Type size={20} />
      </button>
      <button 
        draggable
        onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'link'); }}
        onClick={() => { setIsDrawingMode(false); setPlacementMode('link'); }} 
        className={`p-3 rounded-full transition ${placementMode === 'link' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
        title="Add Link (Drag or Click to place)"
      >
        <Link2 size={20} />
      </button>
      <button 
        onClick={() => setIsDrawingMode(!isDrawingMode)} 
        className={`p-3 rounded-full transition ${isDrawingMode ? 'text-white bg-blue-500/40 ring-2 ring-blue-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
        title="Toggle Drawing Mode"
      >
        <PenTool size={20} />
      </button>
      <button 
        draggable
        onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'group'); }}
        onClick={() => { setIsDrawingMode(false); addGroupNode(); setPlacementMode('group'); }}
        className={`p-3 rounded-full transition ${placementMode === 'group' ? 'bg-white/20 text-blue-400' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
        title="Add Canvas (Drag or Click to place)"
      >
        <BoxSelect size={20} />
      </button>
      <div className="w-px h-6 bg-white/10 mx-1" />
      <button 
         onClick={saveCanvas} 
         disabled={saveState !== 'idle'}
         className={`p-3 rounded-full transition relative flex items-center justify-center w-[44px] h-[44px] ${saveState === 'idle' ? 'text-white/70 hover:text-emerald-400 hover:bg-emerald-400/10 cursor-pointer' : saveState === 'saved' ? 'text-emerald-400 bg-emerald-400/10 cursor-default' : 'text-white/50 cursor-default'}`} 
         title="Save Canvas"
      >
        {saveState === 'idle' && <Save size={20} />}
        {saveState === 'saving' && <MoreHorizontal size={20} className="animate-pulse" />}
        {saveState === 'saved' && <Check size={20} />}
        {(hasUnsavedChanges && saveState === 'idle') && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-amber-400 rounded-full" />}
      </button>
      <button 
        onClick={exportCanvasToPNG}
        className="p-3 rounded-full transition text-white/70 hover:text-white hover:bg-white/10"
        title="Export to PNG"
      >
        <Download size={20} />
      </button>
      <div className="w-px h-6 bg-white/10 mx-1" />
      <button 
        onClick={undo} 
        className={`p-3 rounded-full transition ${canUndo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`} 
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
      >
        <Undo2 size={20} />
      </button>
      <button 
        onClick={redo} 
        className={`p-3 rounded-full transition ${canRedo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`} 
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
      >
        <Redo2 size={20} />
      </button>
      <div className="w-px h-6 bg-white/10 mx-1" />
      <button onClick={clearCanvas} className="p-3 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-full transition" title="Clear Canvas">
        <Trash2 size={20} />
      </button>
    </Panel>
  );
});
