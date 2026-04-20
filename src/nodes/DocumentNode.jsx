import React, { useEffect, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileIcon, Lock } from 'lucide-react';
import { IMAGE_RE } from '../utils/constants';

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

  const isImage = Boolean(data.filename?.match(IMAGE_RE));

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

  const handleDoubleClick = async () => {
    if (data.locked) return;
    if (data.filePath && window.electronAPI) {
      try {
        await window.electronAPI.openFile(data.filePath);
      } catch (err) {
        console.error('Error opening file:', err);
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

  return (
    <div
      className={`glass-card p-3 rounded-xl flex items-center gap-3 w-64 transition-all relative group ${selectedClass}`}
      onDoubleClick={handleDoubleClick}
      title={data.filePath}
      style={{ backgroundColor: data.backgroundColor || undefined }}
    >
      {data.locked && <LockBadge />}
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className="w-10 h-10 rounded bg-blue-500/20 flex items-center justify-center shrink-0 relative">
        <FileIcon className="w-5 h-5 text-blue-400" />
      </div>

      <div className="flex flex-col min-w-0 overflow-hidden relative">
        <span className="text-white font-medium truncate text-sm">
          {data.filename || 'Unknown File'}
        </span>
        <span className="text-gray-400 truncate text-xs">
          Document
        </span>
      </div>

      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
});
