import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileIcon, Lock, Minimize2, Play, AudioLines } from 'lucide-react';
import { getFileCategoryInfo, THEME_COLORS } from '../utils/fileDisplayUtils';
import { EventLogger } from '../utils/EventLogger';

/** Encodes a local file path for use with the custom local-file:// protocol. */
function toLocalFileUrl(filePath) {
  return `local-file://${filePath.replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** Small lock badge shown on locked nodes. */
const LockBadge = () => (
  <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
    <Lock size={10} />
  </div>
);



export const DocumentNode = React.memo(function DocumentNode({ data, selected }) {
  // Use a ref-based counter to force image re-fetches on file change.
  // Avoids the impure Date.now() initializer; counter is stable at 0 on mount.
  const imgVersionRef = useRef(0);
  const imgRef = useRef(null);
  const mediaRef = useRef(null);

  const [isExpanded, setIsExpanded] = useState(false);

  const { category, label, color, badge, Icon } = getFileCategoryInfo(data.filename);
  const theme = THEME_COLORS[color];
  const isImage = category === 'image';
  const isVideo = category === 'video';
  const isAudio = category === 'audio';
  const isMedia = isVideo || isAudio;

  useEffect(() => {
    if (!data.filePath || !window.electronAPI) return;

    window.electronAPI.startFileWatch(data.filePath);
    const removeListener = window.electronAPI.onFileChanged((changedPath) => {
      if (changedPath !== data.filePath) return;
      if (isImage && imgRef.current) {
        // Bump the cache-busting suffix by mutating the src directly — avoids a
        // React re-render and prevents flicker on rapid file changes.
        imgVersionRef.current += 1;
        imgRef.current.src = `${toLocalFileUrl(data.filePath)}?v=${imgVersionRef.current}`;
      }
    });

    return () => {
      removeListener();
      window.electronAPI.stopFileWatch(data.filePath);
    };
  }, [data.filePath, isImage]);

  useEffect(() => {
    if (isExpanded && isMedia && data.filePath) {
      const el = mediaRef.current;
      if (el) {
        // Enforce the src is set correctly on mount. This fixes a bug with React 18 
        // StrictMode where cleanup unmounts the src attribute from the DOM element,
        // but since the React virtual prop `src` never changes, it fails to re-apply.
        el.src = toLocalFileUrl(data.filePath);
      }
      return () => {
        if (el) {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
      };
    }
  }, [isExpanded, isMedia, data.filePath]);


  const handleDoubleClick = async () => {
    if (data.locked) return;
    if (data.filePath && window.electronAPI) {
      try {
        await window.electronAPI.openFile(data.filePath);
      } catch (err) {
        EventLogger.error('Error opening file:', err);
      }
    }
  };

  const selectedClass = selected
    ? 'border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]'
    : 'border-white/10';

  if (isImage) {
    return (
      <div
        className={`glass-card p-2 rounded-xl flex flex-col items-center gap-2 transition-all relative group ${selectedClass}`}
        onDoubleClick={handleDoubleClick}
        title={data.filePath}
        style={{ backgroundColor: data.backgroundColor || (selected ? 'rgba(59,130,246,0.1)' : undefined) }}
      >
        {data.locked && <LockBadge />}
        <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />

        <div className="relative rounded overflow-hidden flex items-center justify-center bg-black/40 min-w-[100px] min-h-[100px] max-w-[250px] max-h-[300px]">
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[9px] font-bold tracking-wider z-10 pointer-events-none backdrop-blur-sm border border-white/10">
            {badge}
          </div>
          <img
            ref={imgRef}
            src={toLocalFileUrl(data.filePath)}
            alt={data.filename}
            className="object-contain max-w-full max-h-full"
          />
        </div>

        <div className="px-1 text-white font-medium truncate text-xs max-w-[200px]">
          {data.filename}
        </div>

        <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    );
  }

  if (isExpanded && isMedia) {
    return (
      <div
        className={`glass-card p-2 rounded-xl flex flex-col items-center gap-2 transition-all relative group shadow-2xl ${selectedClass}`}
        onDoubleClick={handleDoubleClick}
        title={data.filePath}
        style={{ backgroundColor: data.backgroundColor || (selected ? 'rgba(59,130,246,0.1)' : undefined) }}
      >
        {data.locked && <LockBadge />}
        <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />

        <div 
          className="relative rounded overflow-hidden flex flex-col items-center justify-center bg-black/50 pt-8 pb-3 px-3 min-w-[320px]"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button 
             onClick={(e) => { 
               e.stopPropagation(); 
               if (mediaRef.current) {
                 mediaRef.current.pause();
               }
               setIsExpanded(false); 
             }}
             className="nodrag absolute top-1 right-1 p-1.5 hover:bg-white/10 rounded-lg text-white/70 hover:text-white transition-colors z-10"
             title="Collapse Player"
          >
             <Minimize2 size={16} />
          </button>
          
          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[10px] font-bold tracking-wider z-10 pointer-events-none backdrop-blur-sm border border-white/10">
            {badge}
          </div>

          {isVideo ? (
            <video
              ref={mediaRef}
              controls
              src={toLocalFileUrl(data.filePath)}
              className="nodrag max-w-[400px] max-h-[300px] rounded-md shadow-inner bg-black/40"
            />
          ) : (
            <div className="nodrag w-full mt-2 px-6 py-4 bg-black/20 rounded-lg border border-white/5 flex flex-col items-center gap-4 shadow-inner">
              <AudioLines className={`w-12 h-12 ${theme.text} opacity-80`} />
              <audio
                ref={mediaRef}
                controls
                src={toLocalFileUrl(data.filePath)}
                className="w-full h-10 outline-none"
              />
            </div>
          )}
        </div>

        {/* Ensure the media stops playing if this component unmounts while playing. */}
        {/* We rely on the internal useEffect hook for cleanup rather than an external component to avoid StrictMode races */}

        <div className="px-2 text-white font-medium truncate text-sm max-w-[280px]">
          {data.filename}
        </div>

        <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    );
  }

  return (
    <div
      className={`glass-card p-3 rounded-xl flex items-center gap-3 w-64 transition-all relative group ${selectedClass}`}
      onDoubleClick={handleDoubleClick}
      title={data.filePath}
      style={{ backgroundColor: data.backgroundColor || undefined }}
    >
      {data.locked && <LockBadge />}
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className={`w-10 h-10 rounded ${theme.bg} flex items-center justify-center shrink-0 relative overflow-hidden`}>
        <Icon className={`w-5 h-5 ${theme.text} ${isMedia ? 'group-hover:opacity-0 transition-opacity' : ''}`} />
        {isMedia && (
          <button
             onClick={(e) => { e.stopPropagation(); setIsExpanded(true); }}
             className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 hover:bg-black/60"
             title="Play Media"
          >
             <Play className="w-5 h-5 text-white ml-0.5 fill-white" />
          </button>
        )}
      </div>

      <div className="flex flex-col min-w-0 overflow-hidden relative flex-1">
        <span className="text-white font-medium truncate text-sm">
          {data.filename || 'Unknown File'}
        </span>
        <span className="text-gray-400 truncate text-xs">
          {label}
        </span>
      </div>
      
      <div className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider shrink-0 ${theme.text} ${theme.bg}`}>
        {badge}
      </div>

      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
});
