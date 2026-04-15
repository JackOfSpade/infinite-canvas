import React, { useState, useEffect } from 'react';
import { Panel } from '@xyflow/react';
import { Type, BoxSelect, Trash2, Link2, PenTool, Eraser, Undo2, Redo2, Magnet, Settings } from 'lucide-react';

const COLORS = [
  { name: 'white', hex: 'white' },
  { name: 'red', hex: '#f87171' },
  { name: 'blue', hex: '#60a5fa' },
  { name: 'green', hex: '#4ade80' },
  { name: 'amber', hex: '#fbbf24' }
];

/**
 * Tooltip that floats above a toolbar button on hover.
 * Uses CSS group-hover so no JS state is needed per-button.
 */
function ToolbarTooltip({ label, shortcut, children }) {
  return (
    <div className="relative group/tip">
      {children}
      <div
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 pointer-events-none z-50
                   opacity-0 group-hover/tip:opacity-100
                   transition-opacity duration-150 delay-300
                   flex flex-col items-center"
      >
        <div
          className="bg-[#1c1c1e] border border-white/[0.12] shadow-2xl rounded-lg
                     px-2.5 py-1.5 flex items-center gap-1.5 whitespace-nowrap"
        >
          <span className="text-white/90 text-[11px] font-medium">{label}</span>
          {shortcut && (
            <kbd
              className="bg-white/10 text-white/50 text-[10px] font-mono
                         rounded px-1.5 py-0.5 leading-none"
            >
              {shortcut}
            </kbd>
          )}
        </div>
        {/* Arrow */}
        <div
          className="w-2 h-2 bg-[#1c1c1e] border-r border-b border-white/[0.12]
                     rotate-45 -mt-[5px]"
        />
      </div>
    </div>
  );
}

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
  onDragStart,
  undo,
  redo,
  canUndo,
  canRedo,
  clearCanvas,
  clearDrawings,
  onSettingsClick,
}) {
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showEraserMenu, setShowEraserMenu] = useState(false);

  // Close popovers if clicking outside
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
        <ToolbarTooltip label="Add Text" shortcut="drag or T">
          <button
            draggable
            onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'text'); }}
            onClick={() => { setActiveTool(null); setPlacementMode('text'); }}
            className={`p-3 rounded-full transition ${placementMode === 'text' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          >
            <Type size={18} />
          </button>
        </ToolbarTooltip>

        <ToolbarTooltip label="Add Link" shortcut="drag or L">
          <button
            draggable
            onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'link'); }}
            onClick={() => { setActiveTool(null); setPlacementMode('link'); }}
            className={`p-3 rounded-full transition ${placementMode === 'link' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          >
            <Link2 size={18} />
          </button>
        </ToolbarTooltip>

        <div className="relative" onClick={e => e.stopPropagation()}>
          <ToolbarTooltip label="Pen Tool" shortcut="right-click for colors">
            <button
              onClick={() => { setShowColorMenu(false); setShowEraserMenu(false); setActiveTool(activeTool === 'pen' ? null : 'pen'); setPlacementMode(null); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setShowColorMenu(!showColorMenu); setShowEraserMenu(false); }}
              className={`p-3 rounded-full transition ${activeTool === 'pen' ? 'text-white bg-blue-500/40 ring-2 ring-blue-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              <PenTool size={18} />
            </button>
          </ToolbarTooltip>
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
          <ToolbarTooltip label="Eraser" shortcut="right-click for options">
            <button
              onClick={() => { setShowEraserMenu(false); setShowColorMenu(false); setActiveTool(activeTool === 'eraser' ? null : 'eraser'); setPlacementMode(null); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setShowEraserMenu(!showEraserMenu); setShowColorMenu(false); }}
              className={`p-3 rounded-full transition ${activeTool === 'eraser' ? 'text-white bg-red-500/40 ring-2 ring-red-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              <Eraser size={18} />
            </button>
          </ToolbarTooltip>
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

        <ToolbarTooltip label="Nested Canvas" shortcut="drag or click">
          <button
            draggable
            onDragStart={(e) => { setActiveTool(null); onDragStart(e, 'group'); }}
            onClick={() => { setActiveTool(null); setPlacementMode('group'); }}
            className={`p-3 rounded-full transition ${placementMode === 'group' ? 'bg-white/20 text-blue-400' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          >
            <BoxSelect size={18} />
          </button>
        </ToolbarTooltip>

        <div className="w-px h-6 bg-white/10 mx-0.5" />

        {/* ── Snap to Grid ─────────────────────────────────────────── */}
        <ToolbarTooltip label="Snap to Grid">
          <button
            onClick={() => setSnapToGrid(!snapToGrid)}
            className={`p-3 rounded-full transition ${snapToGrid ? 'text-white bg-indigo-500/40 ring-2 ring-indigo-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          >
            <Magnet size={18} />
          </button>
        </ToolbarTooltip>

        <div className="w-px h-6 bg-white/10 mx-0.5" />

        {/* ── Undo/Redo ────────────────────────────────────────────── */}
        <ToolbarTooltip label="Undo" shortcut="⌘Z">
          <button
            onClick={undo}
            className={`p-3 rounded-full transition ${canUndo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`}
            disabled={!canUndo}
          >
            <Undo2 size={18} />
          </button>
        </ToolbarTooltip>

        <ToolbarTooltip label="Redo" shortcut="⌘⇧Z">
          <button
            onClick={redo}
            className={`p-3 rounded-full transition ${canRedo ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-white/20 cursor-not-allowed'}`}
            disabled={!canRedo}
          >
            <Redo2 size={18} />
          </button>
        </ToolbarTooltip>

        <div className="w-px h-6 bg-white/10 mx-0.5" />

        {/* ── Destructive + Settings ───────────────────────────────── */}
        <ToolbarTooltip label="Clear Canvas">
          <button
            onClick={clearCanvas}
            className="p-3 text-red-400/70 hover:text-red-300 hover:bg-red-400/10 rounded-full transition"
          >
            <Trash2 size={18} />
          </button>
        </ToolbarTooltip>

        <ToolbarTooltip label="Settings" shortcut="?">
          <button
            onClick={onSettingsClick}
            className="p-3 rounded-full transition text-white/30 hover:text-white/70 hover:bg-white/10"
          >
            <Settings size={18} />
          </button>
        </ToolbarTooltip>

      </div>
    </Panel>
  );
});
