import React, { useState, useEffect } from 'react';
import { Panel } from '@xyflow/react';
import { Type, BoxSelect, Trash2, Save, Link2, Check, MoreHorizontal, PenTool, Eraser, Undo2, Redo2, Download, Magnet, FolderOpen, HelpCircle, Grid3x3, Map, Settings } from 'lucide-react';

const COLORS = [
  { name: 'white', hex: 'white' },
  { name: 'red', hex: '#f87171' },
  { name: 'blue', hex: '#60a5fa' },
  { name: 'green', hex: '#4ade80' },
  { name: 'amber', hex: '#fbbf24' }
];

export const CanvasToolbar = React.memo(function CanvasToolbar({
  placementMode,
  setPlacementMode,
  activeTool,
  setActiveTool,
  eraserType,
  setEraserType,
  activeColor,
  setActiveColor,
  snapToGrid,
  setSnapToGrid,
  bgVariant,
  setBgVariant,
  showMiniMap,
  setShowMiniMap,
  onDragStart,
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
  onSettingsClick,
}) {
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showEraserMenu, setShowEraserMenu] = useState(false);

  // Close popovers if clicking outside or changing tool
  useEffect(() => {
    const handleClick = () => {
      setShowColorMenu(false);
      setShowEraserMenu(false);
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  return (
    <Panel position="bottom-center" className="mb-4 flex flex-col items-center gap-2">
      <div className="glass-card rounded-full p-2 flex gap-1 bg-black/60 border border-white/10 items-center">
        {/* ── Creation Tools ───────────────────────────────────────── */}
        <button 
          draggable
          onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'text'); }}
          onClick={() => { setActiveTool(null); setPlacementMode('text'); }} 
          className={`p-3 rounded-full transition ${placementMode === 'text' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Add Text (drag or click to place)"
        >
          <Type size={18} />
        </button>
        <button 
          draggable
          onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'link'); }}
          onClick={() => { setActiveTool(null); setPlacementMode('link'); }} 
          className={`p-3 rounded-full transition ${placementMode === 'link' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Add Link (drag or click to place)"
        >
          <Link2 size={18} />
        </button>

        <div className="relative" onClick={e => e.stopPropagation()}>
          <button 
            onClick={() => { setShowColorMenu(false); setShowEraserMenu(false); setActiveTool(activeTool === 'pen' ? null : 'pen'); setPlacementMode(null); }} 
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setShowColorMenu(!showColorMenu); setShowEraserMenu(false); }}
            className={`p-3 rounded-full transition ${activeTool === 'pen' ? 'text-white bg-blue-500/40 ring-2 ring-blue-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
            title="Pen Tool (Right-click for colors)"
          >
            <PenTool size={18} />
          </button>
          {showColorMenu && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-card p-2 rounded-xl border border-white/10 flex flex-col gap-2 w-[140px] animate-in zoom-in-95 origin-bottom text-xs">
              <div className="text-white/50 px-1">Pen Color</div>
              <div className="flex flex-wrap gap-1 px-1">
                {COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => { setActiveColor(c.hex); setShowColorMenu(false); setActiveTool('pen'); }}
                    className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${activeColor === c.hex ? 'ring-2 ring-white scale-110' : 'opacity-70'}`}
                    style={{ backgroundColor: c.hex }}
                    title={`Switch to ${c.name}`}
                  />
                ))}
              </div>
              <div className="w-full h-px bg-white/10"/>
              <input type="text" placeholder="#HEX" value={activeColor} onChange={(e) => setActiveColor(e.target.value)} className="w-full text-xs p-1.5 bg-black/50 text-white rounded outline-none border border-white/20 focus:border-blue-400" />
            </div>
          )}
        </div>

        <div className="relative" onClick={e => e.stopPropagation()}>
          <button 
            onClick={() => { setShowEraserMenu(false); setShowColorMenu(false); setActiveTool(activeTool === 'eraser' ? null : 'eraser'); setPlacementMode(null); }} 
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setShowEraserMenu(!showEraserMenu); setShowColorMenu(false); }}
            className={`p-3 rounded-full transition ${activeTool === 'eraser' ? 'text-white bg-red-500/40 ring-2 ring-red-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
            title="Eraser Tool (Right-click for options)"
          >
            <Eraser size={18} />
          </button>
          {showEraserMenu && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-card p-2 rounded-xl border border-white/10 flex flex-col gap-1 w-[160px] animate-in zoom-in-95 origin-bottom text-xs">
              <div className="text-white/50 px-1 mb-1">Eraser Mode</div>
              <button 
                onClick={() => { setEraserType('object'); setShowEraserMenu(false); setActiveTool('eraser'); }}
                className={`px-2 py-1.5 rounded text-left transition ${eraserType === 'object' ? 'bg-red-500/30 text-white' : 'text-white/70 hover:bg-white/10'}`}
              >
                Erase by Object
              </button>
              <button 
                onClick={() => { setEraserType('pixel'); setShowEraserMenu(false); setActiveTool('eraser'); }}
                className={`px-2 py-1.5 rounded text-left transition ${eraserType === 'pixel' ? 'bg-red-500/30 text-white' : 'text-white/70 hover:bg-white/10'}`}
              >
                Erase by Pixels
              </button>
              <div className="w-full h-px bg-white/10 my-1"/>
              <button 
                onClick={() => { clearDrawings(); setShowEraserMenu(false); }}
                className="px-2 py-1.5 rounded text-left text-red-400 hover:bg-red-500/20 transition flex items-center gap-2"
              >
                <Trash2 size={12}/> Clear All Drawings
              </button>
            </div>
          )}
        </div>

        <button 
          draggable
          onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'group'); }}
          onClick={() => { setActiveTool(null); setPlacementMode('group'); }}
          className={`p-3 rounded-full transition ${placementMode === 'group' ? 'bg-white/20 text-blue-400' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          title="Add Nested Canvas (drag or click to place)"
        >
          <BoxSelect size={18} />
        </button>
        
        <div className="w-px h-6 bg-white/10 mx-0.5" />
        
        {/* ── Toggle Tools ─────────────────────────────────────────── */}
        <button 
          onClick={() => {
            const next = { dots: 'lines', lines: 'cross', cross: 'none', 'none': 'dots' };
            setBgVariant(next[bgVariant] || 'dots');
          }} 
          className={`p-3 rounded-full transition ${bgVariant !== 'none' ? 'text-white bg-indigo-500/40 ring-2 ring-indigo-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Cycle Background Pattern"
        >
          <Grid3x3 size={18} />
        </button>
        <button 
          onClick={() => setShowMiniMap(!showMiniMap)} 
          className={`p-3 rounded-full transition ${showMiniMap ? 'text-white bg-indigo-500/40 ring-2 ring-indigo-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`} 
          title="Toggle MiniMap"
        >
          <Map size={18} />
        </button>
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

        {/* ── Destructive + Help + Settings ─────────────────────────── */}
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
        {onSettingsClick && (
          <button
            onClick={onSettingsClick}
            className="p-3 rounded-full transition text-white/30 hover:text-white/70 hover:bg-white/10"
            title="Settings"
          >
            <Settings size={18} />
          </button>
        )}
      </div>
    </Panel>
  );
});
