import React, { useContext, useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Lock, X } from 'lucide-react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { CanvasThumbnail } from '../components/CanvasThumbnail';
import { FontSizeDialog } from '../components/FontSizeDialog';

const MIN_SIZE = 80;
const MAX_SIZE = 600;
const DEFAULT_SIZE = 160;
const EDGE_ZONE = 12; // screen-px from circle edge that activates resize cursor

export const CanvasNode = React.memo(function CanvasNode({ id, data, selected, width, height }) {
  const SIZE = Math.round(width || DEFAULT_SIZE);
  const R    = SIZE / 2;
  const nav      = useContext(CanvasNavigationContext);
  const mainFlow = useReactFlow();
  const [title, setTitle]         = useState(data.title || '');
  const [isEditing, setIsEditing] = useState(false);
  const [showFontDialog, setShowFontDialog] = useState(false);
  const [nearEdge, setNearEdge]   = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const inputRef       = useRef(null);
  const containerRef   = useRef(null);
  const resizeCenterRef = useRef(null); // { flowCx, flowCy }
  const pathId = `tcp-${id}`;

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

  // Font & Size dialog trigger
  useEffect(() => {
    const handleOpenFont = () => { if (!data.locked) setShowFontDialog(true); };
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id, data.locked]);

  // ── Custom edge resize via window listeners ────────────────────────────────
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e) => {
      if (!resizeCenterRef.current) return;
      const { flowCx, flowCy } = resizeCenterRef.current;
      const fp = mainFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const flowDist = Math.sqrt((fp.x - flowCx) ** 2 + (fp.y - flowCy) ** 2);
      const newSize = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, flowDist * 2)));
      mainFlow.setNodes(nds => nds.map(n =>
        n.id === id ? {
          ...n,
          position: { x: flowCx - newSize / 2, y: flowCy - newSize / 2 },
          width: newSize,
          height: newSize,
          style: { ...(n.style || {}), width: newSize, height: newSize },
        } : n
      ));
    };
    const onUp = () => { setIsResizing(false); resizeCenterRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
    };
  }, [isResizing, id, mainFlow]);

  const getDistToEdge = useCallback((clientX, clientY) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return Infinity;
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    return Math.abs(Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2) - rect.width / 2);
  }, []);

  const handleContainerMouseMove = useCallback((e) => {
    if (isResizing) return;
    const near = getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE;
    setNearEdge(prev => prev === near ? prev : near);
  }, [isResizing, getDistToEdge]);

  const handleContainerPointerDown = useCallback((e) => {
    if (isEditing || data.locked) return;
    if (getDistToEdge(e.clientX, e.clientY) < EDGE_ZONE) {
      e.stopPropagation();
      const node = mainFlow.getNode(id);
      if (!node) return;
      resizeCenterRef.current = {
        flowCx: node.position.x + SIZE / 2,
        flowCy: node.position.y + SIZE / 2,
      };
      setIsResizing(true);
    }
  }, [isEditing, data.locked, getDistToEdge, mainFlow, id, SIZE]);

  const canvasData = data.canvasData || {
    nodes: data.nodes || [], edges: data.edges || [], drawings: data.drawings || [],
  };
  const nodeCount = canvasData.nodes?.length || 0;

  const fontSize     = data.fontSize     || 11;
  const fontFamily   = data.fontFamily   || 'Inter, ui-sans-serif, system-ui, sans-serif';
  const textColor    = data.textColor    || null;
  const titleSpacing = data.titleSpacing ?? 0;

  const commitTitle = useCallback((val) => {
    const v = (val ?? title).trim();
    setTitle(v);
    mainFlow.updateNodeData(id, { title: v });
    setIsEditing(false);
  }, [id, mainFlow, title]);

  const handleDoubleClick = useCallback((e) => {
    if (isEditing || data.locked || isResizing) return;
    e.stopPropagation();
    nav?.diveIn(id);
  }, [id, nav, data.locked, isEditing, isResizing]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    mainFlow.deleteElements({ nodes: [{ id }] });
  }, [id, mainFlow]);

  const arcPath = `M 0,${R} A ${R},${R} 0 0,1 ${SIZE},${R}`;
  const titleFill = textColor ?? (title ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.22)');
  const edgeCursor = (nearEdge || isResizing) ? 'nwse-resize' : undefined;

  return (
    <>
      <div
        ref={containerRef}
        className="group"
        style={{ width: SIZE, height: SIZE, position: 'relative', cursor: edgeCursor }}
        onMouseMove={handleContainerMouseMove}
        onMouseLeave={() => { if (!isResizing) setNearEdge(false); }}
        onPointerDown={handleContainerPointerDown}
      >
        {/* ── Circle body ──────────────────────────────────────────────────── */}
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
            cursor: edgeCursor || 'pointer',
          }}
        >
          <CanvasThumbnail canvasData={canvasData} width="100%" height="100%" />
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none',
            background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.35) 100%)',
          }} />
          {!data.locked && !isResizing && (
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

        {/* ── Curved title ─────────────────────────────────────────────────── */}
        {!isEditing && (
          <svg width={SIZE} height={SIZE} style={{
            position: 'absolute', inset: 0, overflow: 'visible',
            pointerEvents: 'none', zIndex: 10,
          }}>
            <defs><path id={pathId} d={arcPath} /></defs>
            <text
              fontSize={fontSize}
              fontFamily={fontFamily}
              fontWeight="500"
              letterSpacing="0.5"
              dy={-titleSpacing}
              fill={titleFill}
            >
              <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                {title || 'Sub-Canvas'}
              </textPath>
            </text>
          </svg>
        )}

        {/* ── Title edit click zone ─────────────────────────────────────────── */}
        {!isEditing && !data.locked && (
          <div
            style={{ position: 'absolute', top: -20, left: '15%', width: '70%', height: 20,
                     cursor: 'text', zIndex: 15 }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setIsEditing(true); }}
          />
        )}

        {/* ── Edit input ───────────────────────────────────────────────────── */}
        {isEditing && (
          <div style={{ position: 'absolute', top: -26, left: 0, width: SIZE, zIndex: 20 }}
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
                if (e.key === 'Escape') { setTitle(data.title || ''); setIsEditing(false); }
              }}
              placeholder="Sub-Canvas"
              className="w-full text-center text-[11px] font-medium bg-black/75 text-white/90
                         placeholder-white/25 border border-blue-400/50 rounded-full px-2.5 py-0.5
                         focus:outline-none backdrop-blur-sm"
            />
          </div>
        )}

        {/* ── Delete button ─────────────────────────────────────────────────── */}
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
