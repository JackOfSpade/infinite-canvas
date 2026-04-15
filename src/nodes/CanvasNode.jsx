import React, { useContext, useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow, NodeResizer } from '@xyflow/react';
import { Lock, X } from 'lucide-react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { FontSizeDialog } from '../components/FontSizeDialog';

/** Minimum and maximum diameter for resizing */
const MIN_SIZE = 80;
const MAX_SIZE = 400;
const DEFAULT_SIZE = 160;

/**
 * CanvasNode — circular portal node.
 *
 * Title positioning math:
 *   - SVG is SIZE×SIZE, overlaid at inset:0 with overflow:visible
 *   - Arc path = upper semicircle: M(0,R) A(R,R,0,0,0,SIZE,R)
 *   - At startOffset=50% the text baseline lands at (R, R-R) = (80,0) in SVG coords
 *   - y=0 in SVG = the very top edge of the circle  ✓
 *   - Characters extend upward (negative y) → "hugging" the circle from outside
 *
 * titleSpacing (dy on <text>): positive = text moves into circle; negative = further outside.
 */
export const CanvasNode = React.memo(function CanvasNode({ id, data, selected, width, height }) {
  // SIZE comes from ReactFlow's measured/explicit node dimensions.
  // Falls back to DEFAULT_SIZE for the first render before measurement.
  const SIZE = Math.round(width || DEFAULT_SIZE);
  const R    = SIZE / 2;
  const nav      = useContext(CanvasNavigationContext);
  const mainFlow = useReactFlow();
  const [title, setTitle]         = useState(data.title || '');
  const [isEditing, setIsEditing] = useState(false);
  const [showFontDialog, setShowFontDialog] = useState(false);
  const inputRef = useRef(null);
  const pathId   = `tcp-${id}`;

  useEffect(() => { setTitle(data.title || ''); }, [data.title]);

  useEffect(() => {
    if (data.isNew) {
      setIsEditing(true);
      mainFlow.updateNodeData(id, { isNew: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isEditing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [isEditing]);

  // Listen for Font & Size context-menu trigger
  useEffect(() => {
    const handleOpenFont = () => {
      if (data.locked) return;
      setShowFontDialog(true);
    };
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id, data.locked]);

  const canvasData = data.canvasData || {
    nodes: data.nodes || [], edges: data.edges || [], drawings: data.drawings || [],
  };
  const nodeCount = canvasData.nodes?.length || 0;

  // Font settings (with sensible defaults)
  const fontSize     = data.fontSize     || 11;
  const fontFamily   = data.fontFamily   || 'Inter, ui-sans-serif, system-ui, sans-serif';
  const textColor    = data.textColor    || null;  // null = auto based on title presence
  const titleSpacing = data.titleSpacing ?? 0;     // dy offset: positive = into circle

  const commitTitle = useCallback((val) => {
    const v = (val ?? title).trim();
    setTitle(v);
    mainFlow.updateNodeData(id, { title: v });
    setIsEditing(false);
  }, [id, mainFlow, title]);

  const handleDoubleClick = useCallback((e) => {
    // Allow diving in even without a title — canvas is functional without one
    if (isEditing || data.locked) return;
    e.stopPropagation();
    nav?.diveIn(id);
  }, [id, nav, data.locked, isEditing]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    mainFlow.deleteElements({ nodes: [{ id }] });
  }, [id, mainFlow]);

  // sweep-flag=1 → clockwise in SVG screen space (Y-down) → traces the UPPER semicircle.
  // At startOffset=50% the baseline is at (R, 0) = circle's top edge. ✓
  const arcPath = `M 0,${R} A ${R},${R} 0 0,1 ${SIZE},${R}`;

  // Derived fill colour for the arc text
  const titleFill = textColor
    ? textColor
    : (title ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.22)');

  return (
    <>
      {/* Resize handles — corner+edge dots, locked to square aspect ratio.
          lineStyle is transparent so the resize selection box is invisible;
          the circle body's border provides the circular selection indicator. */}
      <NodeResizer
        minWidth={MIN_SIZE}
        minHeight={MIN_SIZE}
        maxWidth={MAX_SIZE}
        maxHeight={MAX_SIZE}
        keepAspectRatio
        isVisible={selected}
        handleStyle={{
          width: 10,
          height: 10,
          background: 'rgba(96,165,250,0.9)',
          border: '1px solid rgba(255,255,255,0.6)',
          borderRadius: '50%',
        }}
        lineStyle={{ borderColor: 'transparent' }}
      />
      <div
        className="group"
        style={{ width: SIZE, height: SIZE, position: 'relative' }}
      >
        {/* ── Circle body ──────────────────────────────────────────────────────── */}
        <div
          onDoubleClick={handleDoubleClick}
          style={{
            position:        'absolute',
            inset:           0,
            borderRadius:    '50%',
            overflow:        'hidden',
            border:          selected
              ? '2px solid rgba(96,165,250,0.85)'
              : '2px solid rgba(255,255,255,0.10)',
            backgroundColor: data.backgroundColor || 'rgba(12,12,18,0.97)',
            boxShadow:       selected
              ? '0 0 0 4px rgba(96,165,250,0.15), 0 8px 40px rgba(0,0,0,0.65)'
              : '0 4px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)',
            cursor: 'pointer',
          }}
        >
          <CanvasThumbnail canvasData={canvasData} width="100%" height="100%" />

          {/* Vignette */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.35) 100%)',
          }} />

          {/* Hover "open" hint */}
          {!data.locked && (
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-all
                            bg-black/0 group-hover:bg-black/45 flex items-center justify-center
                            pointer-events-none">
              <span className="text-[9px] text-white/90 bg-black/60 rounded-full px-2 py-0.5
                               backdrop-blur-sm font-medium tracking-wide">
                Double-click to open
              </span>
            </div>
          )}

          {nodeCount > 0 && (
            <span className="absolute top-3 right-3 bg-blue-500/90 text-white text-[9px] font-bold
                             rounded-full min-w-[16px] h-[16px] px-1 flex items-center justify-center shadow-md">
              {nodeCount}
            </span>
          )}
          {data.locked && (
            <div className="absolute top-3 right-3 bg-black/70 rounded-full p-1 text-white/60 backdrop-blur-sm">
              <Lock size={9} />
            </div>
          )}
        </div>

        {/* ── Curved title (SVG overlay) ────────────────────────────────────────
            overflow:visible lets the text poke above y=0 (the circle's top edge).
            The path top sits at (R,0), characters extend upward → hugs the edge.
            dy (titleSpacing) shifts text perpendicular to path: + = into circle. */}
        {!isEditing && (
          <svg
            width={SIZE}
            height={SIZE}
            style={{
              position:      'absolute',
              inset:         0,
              overflow:      'visible',
              pointerEvents: 'none',
              zIndex:        10,
            }}
          >
            <defs>
              <path id={pathId} d={arcPath} />
            </defs>
            <text
              fontSize={fontSize}
              fontFamily={fontFamily}
              fontWeight="500"
              letterSpacing="0.5"
              dy={titleSpacing}
              fill={titleFill}
            >
              <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                {title || 'Sub-Canvas'}
              </textPath>
            </text>
          </svg>
        )}

        {/* ── Invisible click zone above circle for title editing ─────────────── */}
        {!isEditing && !data.locked && (
          <div
            style={{
              position:      'absolute',
              top:           -20,
              left:          '15%',
              width:         '70%',
              height:        20,
              cursor:        'text',
              zIndex:        15,
            }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setIsEditing(true); }}
          />
        )}

        {/* ── Edit input (appears above circle when editing) ────────────────── */}
        {isEditing && (
          <div
            style={{ position: 'absolute', top: -26, left: 0, width: SIZE, zIndex: 20 }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={e  => commitTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter')  commitTitle(e.target.value);
                // Escape restores original title (may be empty — that's fine)
                if (e.key === 'Escape') { setTitle(data.title || ''); setIsEditing(false); }
              }}
              placeholder="Sub-Canvas"
              className="w-full text-center text-[11px] font-medium bg-black/75 text-white/90
                         placeholder-white/25 border border-blue-400/50 rounded-full px-2.5 py-0.5
                         focus:outline-none backdrop-blur-sm"
            />
          </div>
        )}

        {/* ── Delete button ────────────────────────────────────────────────────── */}
        {!data.locked && (
          <button
            onClick={handleDelete}
            onPointerDown={e => e.stopPropagation()}
            title="Delete canvas"
            style={{ position: 'absolute', top: -6, left: -6, zIndex: 10 }}
            className="w-5 h-5 rounded-full flex items-center justify-center
                       bg-black/60 text-white/0 group-hover:text-white/60
                       hover:!text-red-400 hover:!bg-red-900/70
                       opacity-0 group-hover:opacity-100
                       transition-all backdrop-blur-sm border border-white/10"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {/* Font & Size dialog — triggered by context menu */}
      {showFontDialog && (
        <FontSizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={data.textColor || '#ffffff'}
          titleSpacing={titleSpacing}
          onApply={({ fontSize: fs, fontFamily: ff, textColor: tc, titleSpacing: ts }) =>
            mainFlow.updateNodeData(id, { fontSize: fs, fontFamily: ff, textColor: tc, titleSpacing: ts })
          }
          onClose={() => setShowFontDialog(false)}
        />
      )}

      <Handle type="target" position={Position.Left}  id="canvas-target" className="opacity-0" />
      <Handle type="source" position={Position.Right} id="canvas-source" className="opacity-0" />
    </>
  );
});
