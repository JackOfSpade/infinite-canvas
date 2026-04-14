import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileIcon, Lock } from 'lucide-react';

export const DocumentNode = React.memo(function DocumentNode({ data, selected }) {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (!data.filePath || !window.electronAPI) return;
    
    window.electronAPI.startFileWatch(data.filePath);
    const removeListener = window.electronAPI.onFileChanged((changedPath) => {
      if (changedPath === data.filePath) setUpdated(true);
    });

    return () => {
      removeListener();
      window.electronAPI.stopFileWatch(data.filePath);
    };
  }, [data.filePath]);

  const handleDoubleClick = async () => {
    setUpdated(false);
    if (data.filePath && window.electronAPI) {
      try {
        await window.electronAPI.openFile(data.filePath);
      } catch (err) {
        console.error('Error opening file:', err);
      }
    }
  };

  const isImage = data.filename?.match(/\.(jpg|jpeg|png|gif|webp)$/i);

  if (isImage) {
    return (
      <div 
        className={`glass-card p-2 rounded-xl flex flex-col items-center gap-2 transition-all relative ${selected ? 'border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'border-white/10'}`}
        onDoubleClick={handleDoubleClick}
        title={data.filePath}
        style={{
          backgroundColor: data.backgroundColor || (selected ? 'rgba(59,130,246,0.1)' : undefined)
        }}
      >
        {data.locked && (
          <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
            <Lock size={10} />
          </div>
        )}
        <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400" />
        
        <div className="relative rounded overflow-hidden flex items-center justify-center bg-black/40 min-w-[100px] min-h-[100px] max-w-[250px] max-h-[300px]">
          <img src={`local-file://${data.filePath}`} alt={data.filename} className="object-contain max-w-full max-h-full" />
          {updated && (
            <span className="absolute top-2 right-2 w-3 h-3 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
          )}
        </div>
        
        <div className="px-1 text-white font-medium truncate text-xs max-w-[200px]">
          {data.filename}
        </div>

        <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400" />
      </div>
    );
  }

  return (
    <div 
      className={`glass-card p-3 rounded-xl flex items-center gap-3 w-64 transition-all relative ${selected ? 'border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'border-white/10'}`}
      onDoubleClick={handleDoubleClick}
      title={data.filePath}
      style={{
        backgroundColor: data.backgroundColor || undefined
      }}
    >
      {data.locked && (
        <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
          <Lock size={10} />
        </div>
      )}
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-400" />
      
      <div className="w-10 h-10 rounded bg-blue-500/20 flex items-center justify-center shrink-0 relative">
        <FileIcon className="w-5 h-5 text-blue-400" />
        {updated && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
        )}
      </div>
      
      <div className="flex flex-col min-w-0 overflow-hidden relative">
        <span className="text-white font-medium truncate text-sm">
          {data.filename || 'Unknown File'}
        </span>
        <span className="text-gray-400 truncate text-xs">
          Document
        </span>
      </div>

      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-400" />
    </div>
  );
});
