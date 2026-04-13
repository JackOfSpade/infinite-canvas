import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileIcon } from 'lucide-react';

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

  return (
    <div 
      className={`glass-card p-3 rounded-xl flex items-center gap-3 w-64 transition-all ${selected ? 'border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'border-white/10'}`}
      onDoubleClick={handleDoubleClick}
      title={data.filePath}
    >
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
