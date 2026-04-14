import React from 'react';
import { Panel } from '@xyflow/react';
import { Type, BoxSelect, Trash2, Save, Link2, Check, MoreHorizontal, PenTool, Undo2, Redo2, Download, Magnet, FolderOpen, HelpCircle } from 'lucide-react';

const COLORS = [
  { name: 'white', hex: 'white' },
  { name: 'red', hex: '#f87171' },
  { name: 'blue', hex: '#60a5fa' },
  { name: 'green', hex: '#4ade80' },
  { name: 'amber', hex: '#fbbf24' }
];

/**
 * Bottom toolbar for the canvas.
 * Contains buttons for adding nodes, drawing, save/load, undo/redo, clear, and help.
 */
export const CanvasToolbar = React.memo(function CanvasToolbar({
  placementMode,
  setPlacementMode,
  isDrawingMode,
  setIsDrawingMode,
  activeColor,
  setActiveColor,
  snapToGrid,
  setSnapToGrid,
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
  clearDrawings,
  exportCanvasToPNG,
  loadCanvas,
  onHelpClick,
}) {
  return (
    <Panel position="bottom-center" className="mb-4 flex flex-col items-center gap-2">
      {/* Color Palette (Visible only in drawing mode) */}
      {isDrawingMode && (
        <div className="glass-card rounded-full p-1.5 flex gap-1.5 bg-black/60 border border-white/10 items-center animate-in fade-in slide-in-from-bottom-2">
          {COLORS.map((c) => (
            <button
              key={c.name}
              onClick={() => setActiveColor(c.hex)}
              className={`w-6 h-6 rounded-full transition-transform hover:scale-110 ${activeColor === c.hex ? 'ring-2 ring-white scale-110' : 'opacity-70'}`}
              style={{ backgroundColor: c.hex }}
              title={`Switch to ${c.name}`}
            />
          ))}
          <div className="w-px h-4 bg-white/20 mx-1" />
          <button
            onClick={clearDrawings}
            className="w-6 h-6 rounded-full flex items-center text-red-400 hover:text-white transition-colors hover:bg-red-500/80 justify-center"
            title="Erase All Drawings"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {/* Main Toolbar */}
      <div className="glass-card rounded-full p-2 flex gap-1 bg-black/60 border border-white/10 items-center">
        {/* ── Creation Tools ───────────────────────────────────────── */}
        <button 
          draggable
          onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'text'); }}
          onClick={() => { setIsDrawingMode(false); setPlacementMode('text'); }} 
          className={`p-3 rounded-full transition ${placementMode === 'text' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Add Text (drag or click to place)"
        >
          <Type size={18} />
        </button>
        <button 
          draggable
          onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'link'); }}
          onClick={() => { setIsDrawingMode(false); setPlacementMode('link'); }} 
          className={`p-3 rounded-full transition ${placementMode === 'link' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Add Link (drag or click to place)"
        >
          <Link2 size={18} />
        </button>
        <button 
          onClick={() => setIsDrawingMode(!isDrawingMode)} 
          className={`p-3 rounded-full transition ${isDrawingMode ? 'text-white bg-blue-500/40 ring-2 ring-blue-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Toggle Drawing Mode"
        >
          <PenTool size={18} />
        </button>
        <button 
          draggable
          onDragStart={(e) => { setIsDrawingMode(false); onDragStart(e, 'group'); }}
          onClick={() => { setIsDrawingMode(false); addGroupNode(); setPlacementMode('group'); }}
          className={`p-3 rounded-full transition ${placementMode === 'group' ? 'bg-white/20 text-blue-400' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          title="Add Nested Canvas (drag or click to place)"
        >
          <BoxSelect size={18} />
        </button>
        
        <div className="w-px h-6 bg-white/10 mx-0.5" />
        
        {/* ── Toggle Tools ─────────────────────────────────────────── */}
        <button 
          onClick={() => setSnapToGrid(!snapToGrid)} 
          className={`p-3 rounded-full transition ${snapToGrid ? 'text-white bg-indigo-500/40 ring-2 ring-indigo-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Toggle Snap to Grid"
        >
          <Magnet size={18} />
        </button>

        <div className="w-px h-6 bg-white/10 mx-0.5" />
        
        {/* ── File Operations ──────────────────────────────────────── */}
        <button 
           onClick={saveCanvas} 
           disabled={saveState !== 'idle'}
           className={`p-3 rounded-full transition relative flex items-center justify-center w-[42px] h-[42px] ${saveState === 'idle' ? 'text-white/70 hover:text-emerald-400 hover:bg-emerald-400/10 cursor-pointer' : saveState === 'saved' ? 'text-emerald-400 bg-emerald-400/10 cursor-default' : 'text-white/50 cursor-default'}`} 
           title="Save Canvas (⌘S)"
        >
          {saveState === 'idle' && <Save size={18} />}
          {saveState === 'saving' && <MoreHorizontal size={18} className="animate-pulse" />}
          {saveState === 'saved' && <Check size={18} />}
          {(hasUnsavedChanges && saveState === 'idle') && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-amber-400 rounded-full" />}
        </button>
        {loadCanvas && (
          <button 
            onClick={loadCanvas}
            className="p-3 rounded-full transition text-white/70 hover:text-white hover:bg-white/10"
            title="Open Canvas (⌘O)"
          >
            <FolderOpen size={18} />
          </button>
        )}
        <button 
          onClick={exportCanvasToPNG}
          className="p-3 rounded-full transition text-white/70 hover:text-white hover:bg-white/10"
          title="Export to PNG"
        >
          <Download size={18} />
        </button>

        <div className="w-px h-6 bg-white/10 mx-0.5" />
        
        {/* ── Undo/Redo ────────────────────────────────────────────── */}
        <button 
          onClick={undo} 
          className={`p-3 rounded-full transition ${canUndo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`} 
          title="Undo (⌘Z)"
          disabled={!canUndo}
        >
          <Undo2 size={18} />
        </button>
        <button 
          onClick={redo} 
          className={`p-3 rounded-full transition ${canRedo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`} 
          title="Redo (⌘⇧Z)"
          disabled={!canRedo}
        >
          <Redo2 size={18} />
        </button>

        <div className="w-px h-6 bg-white/10 mx-0.5" />

        {/* ── Destructive + Help ────────────────────────────────────── */}
        <button onClick={clearCanvas} className="p-3 text-red-400/70 hover:text-red-300 hover:bg-red-400/10 rounded-full transition" title="Clear Canvas">
          <Trash2 size={18} />
        </button>
        {onHelpClick && (
          <button
            onClick={onHelpClick}
            className="p-3 rounded-full transition text-white/30 hover:text-white/70 hover:bg-white/10"
            title="Keyboard Shortcuts (?)"
          >
            <HelpCircle size={18} />
          </button>
        )}
      </div>
    </Panel>
  );
});
