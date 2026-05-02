import React, { useState, useEffect, useRef } from 'react';
import { Panel } from '@xyflow/react';
import { Type, Trash2, Link2, PenTool, Eraser, Undo2, Redo2, Magnet, Settings, MousePointer2 } from 'lucide-react';

/** Nested canvas icon — plain circle with inner glow along the inside edge */
export function NestedCanvasIcon({ size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ filter: 'drop-shadow(0 0 2px currentColor)' }}
    >
      {/* Outer soft halo */}
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="5" opacity="0.10" />
      {/* Inner glow ring — thicker, inside the main circle edge */}
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="4" opacity="0.15" />
      {/* Crisp main edge */}
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const COLORS = [
  { name: 'white', hex: 'white' },
  { name: 'red', hex: '#f87171' },
  { name: 'blue', hex: '#60a5fa' },
  { name: 'green', hex: '#4ade80' },
  { name: 'amber', hex: '#fbbf24' }
];

const PEN_SIZES   = [2, 4, 8, 14, 22];
const ERASER_SIZES = [10, 20, 40, 70, 110];

/**
 * Tooltip that shows on hover.
 * Pass `hidden={true}` to instantly suppress it — the inline style overrides
 * the CSS group-hover opacity in the same render tick, no polling needed.
 */
function ToolbarTooltip({ label, shortcut, hidden = false, children }) {
  return (
    <div className="relative group/tip">
      {children}
      <div
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 pointer-events-none z-50
                   opacity-0 group-hover/tip:opacity-100
                   transition-opacity duration-150 delay-300
                   flex flex-col items-center"
        style={hidden ? { opacity: 0, transitionDelay: '0ms', transition: 'none' } : undefined}
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
  eraserSize,
  setEraserSize,
  penSize,
  setPenSize,
  activeColor,
  setActiveColor,
  snapToGrid,
  setSnapToGrid,
  onDragStart,
  onNestedCanvasDragStart,
  undo,
  redo,
  canUndo,
  canRedo,
  clearCanvas,
  clearDrawings,
  onSettingsClick,
  /** Called with true/false whenever a tool popup (color/eraser menu) opens or closes */
  onToolMenuChange,
}) {
  const [showColorMenu,  setShowColorMenu]  = useState(false);
  const [showEraserMenu, setShowEraserMenu] = useState(false);

  // Refs used to suppress tooltips while context menus are open (no re-render needed)
  const penSuppressRef    = useRef(false);
  const eraserSuppressRef = useRef(false);

  // Notify parent whenever a tool popup opens/closes so Canvas can block drawing through it
  useEffect(() => {
    onToolMenuChange?.(showColorMenu || showEraserMenu);
  }, [showColorMenu, showEraserMenu, onToolMenuChange]);

  // Close popovers if clicking outside
  useEffect(() => {
    const handleClick = () => {
      setShowColorMenu(false);
      setShowEraserMenu(false);
      penSuppressRef.current    = false;
      eraserSuppressRef.current = false;
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const handlePenClick = () => {
    setShowColorMenu(false);
    setShowEraserMenu(false);
    setActiveTool(activeTool === 'pen' ? null : 'pen');
    setPlacementMode(null);
    penSuppressRef.current = false;
    eraserSuppressRef.current = false;
  };

  const handleEraserClick = () => {
    setShowEraserMenu(false);
    setShowColorMenu(false);
    setActiveTool(activeTool === 'eraser' ? null : 'eraser');
    setPlacementMode(null);
    penSuppressRef.current = false;
    eraserSuppressRef.current = false;
  };

  const handlePenContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    penSuppressRef.current = true;
    setShowColorMenu(v => !v);
    setShowEraserMenu(false);
    eraserSuppressRef.current = false;
  };

  const handleEraserContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    eraserSuppressRef.current = true;
    setShowEraserMenu(v => !v);
    setShowColorMenu(false);
    penSuppressRef.current = false;
  };

  return (
    <Panel position="bottom-center" className="mb-4 flex flex-col items-center gap-2" style={{ zIndex: 200 }}>
      {/* onPointerDown stop-propagation prevents toolbar clicks from bleeding through to the canvas drawing layer */}
      <div
        className="glass-card rounded-full p-2 flex gap-1 bg-black/60 border border-white/10 items-center"
        onPointerDown={e => e.stopPropagation()}
      >

        {/* ── Select Tool (box selection) ────────────────────────── */}
        <ToolbarTooltip label="Select / Marquee" shortcut="V">
          <button
            onClick={() => {
              setActiveTool(activeTool === 'select' ? null : 'select');
              setPlacementMode(null);
            }}
            className={`p-3 rounded-full transition ${
              activeTool === 'select'
                ? 'text-white bg-amber-500/40 ring-2 ring-amber-400'
                : 'text-white/70 hover:text-white hover:bg-white/10'
            }`}
          >
            <MousePointer2 size={18} />
          </button>
        </ToolbarTooltip>

        <div className="w-px h-6 bg-white/10 mx-0.5" />

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

        {/* ── Pen Tool ─────────────────────────────────────────────── */}
        <div className="relative" onClick={e => e.stopPropagation()}>
          <ToolbarTooltip label="Pen Tool" shortcut="right-click for options" hidden={showColorMenu}>
            <button
              onClick={handlePenClick}
              onContextMenu={handlePenContextMenu}
              className={`p-3 rounded-full transition ${activeTool === 'pen' ? 'text-white bg-blue-500/40 ring-2 ring-blue-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              <PenTool size={18} />
            </button>
          </ToolbarTooltip>

          {showColorMenu && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-card p-3 rounded-xl border border-white/10 flex flex-col gap-2.5 w-[160px] animate-in zoom-in-95 origin-bottom text-xs">
              {/* Color */}
              <div>
                <div className="text-white/40 uppercase tracking-wider text-[10px] font-semibold mb-1.5">Color</div>
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {COLORS.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => { setActiveColor(c.hex); setActiveTool('pen'); }}
                      className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${activeColor === c.hex ? 'ring-2 ring-white scale-110' : 'opacity-70'}`}
                      style={{ backgroundColor: c.hex }}
                      title={`Switch to ${c.name}`}
                    />
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="#HEX"
                  value={activeColor}
                  onChange={(e) => setActiveColor(e.target.value)}
                  className="w-full text-xs p-1.5 bg-black/50 text-white rounded outline-none border border-white/20 focus:border-blue-400"
                />
              </div>

              <div className="w-full h-px bg-white/10" />

              {/* Pen Size */}
              <div>
                <div className="text-white/40 uppercase tracking-wider text-[10px] font-semibold mb-1.5">
                  Size <span className="text-white/60 normal-case font-normal">({penSize ?? 3}px)</span>
                </div>
                <div className="flex items-center gap-1">
                  {PEN_SIZES.map(s => (
                    <button
                      key={s}
                      onClick={() => { setPenSize(s); setActiveTool('pen'); }}
                      title={`${s}px`}
                      className={`flex-1 flex items-center justify-center rounded transition hover:bg-white/10 py-1 ${(penSize ?? 3) === s ? 'bg-blue-500/20 ring-1 ring-blue-500/50' : ''}`}
                    >
                      <div
                        className="rounded-full bg-white mx-auto"
                        style={{ width: Math.min(s, 18), height: Math.min(s, 18), opacity: (penSize ?? 3) === s ? 1 : 0.45 }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Eraser Tool ──────────────────────────────────────────── */}
        <div className="relative" onClick={e => e.stopPropagation()}>
          <ToolbarTooltip label="Eraser" shortcut="right-click for options" hidden={showEraserMenu}>
            <button
              onClick={handleEraserClick}
              onContextMenu={handleEraserContextMenu}
              className={`p-3 rounded-full transition ${activeTool === 'eraser' ? 'text-white bg-red-500/40 ring-2 ring-red-500' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              <Eraser size={18} />
            </button>
          </ToolbarTooltip>

          {showEraserMenu && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-card p-3 rounded-xl border border-white/10 flex flex-col gap-2.5 w-[160px] animate-in zoom-in-95 origin-bottom text-xs">
              {/* Mode */}
              <div>
                <div className="text-white/40 uppercase tracking-wider text-[10px] font-semibold mb-1.5">Mode</div>
                <button
                  onClick={() => { setEraserType('object'); setActiveTool('eraser'); }}
                  className={`w-full px-2 py-1.5 rounded text-left transition mb-0.5 ${eraserType === 'object' ? 'bg-red-500/30 text-white' : 'text-white/70 hover:bg-white/10'}`}
                >
                  Erase by Object
                </button>
                <button
                  onClick={() => { setEraserType('pixel'); setActiveTool('eraser'); }}
                  className={`w-full px-2 py-1.5 rounded text-left transition ${eraserType === 'pixel' ? 'bg-red-500/30 text-white' : 'text-white/70 hover:bg-white/10'}`}
                >
                  Erase by Pixels
                </button>
              </div>

              <div className="w-full h-px bg-white/10" />

              {/* Eraser Size */}
              <div>
                <div className="text-white/40 uppercase tracking-wider text-[10px] font-semibold mb-1.5">
                  Size <span className="text-white/60 normal-case font-normal">({eraserSize ?? 15}px)</span>
                </div>
                <div className="flex items-center gap-1">
                  {ERASER_SIZES.map(s => (
                    <button
                      key={s}
                      onClick={() => { setEraserSize(s); setActiveTool('eraser'); }}
                      title={`${s}px`}
                      className={`flex-1 flex items-center justify-center rounded transition hover:bg-white/10 py-1 ${(eraserSize ?? 15) === s ? 'bg-red-500/20 ring-1 ring-red-500/50' : ''}`}
                    >
                      <div
                        className="rounded-full border border-white/50 mx-auto"
                        style={{
                          width:  Math.max(4, Math.min(s * 0.22, 18)),
                          height: Math.max(4, Math.min(s * 0.22, 18)),
                          opacity: (eraserSize ?? 15) === s ? 1 : 0.45
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div className="w-full h-px bg-white/10" />

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
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onNestedCanvasDragStart?.(e.clientX, e.clientY);
            }}
            onClick={() => { setActiveTool(null); setPlacementMode('group'); }}
            className={`p-3 rounded-full transition ${placementMode === 'group' ? 'bg-white/20 text-blue-400' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
          >
            <NestedCanvasIcon size={18} />
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
