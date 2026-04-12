import React, { useState, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ContextMenu } from '../components/ContextMenu';
import { Dialog } from '../components/Dialog';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { useContextMenu } from '../hooks/useContextMenu';

export function LinkNode({ id, data }) {
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showDialog, setShowDialog] = useState(null); // 'font' | 'url'
  const [urlInput, setUrlInput] = useState(data.url || '');
  const clickTimeoutRef = useRef(null);
  const { updateNodeData } = useReactFlow();

  const inputRef = useRef(null);

  const isEmptyPredicate = () => {
    return !inputRef.current?.innerText?.trim();
  };

  const { isEditing: isEditingLabel, setIsEditing: setIsEditingLabel, handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, inputRef);

  const handleLabelBlur = () => {
    const label = inputRef.current?.innerText || '';
    handleBlur({ label });
  };

  // Sync label content when data changes externally (undo/redo)
  React.useEffect(() => {
    if (!isEditingLabel && inputRef.current) {
      if (inputRef.current.innerText !== (data.label || data.url || '')) {
        inputRef.current.innerText = data.label || data.url || '';
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.label, data.url, isEditingLabel]);

  const openLink = () => {
    const targetUrl = data.url || inputRef.current?.innerText || '';
    if (targetUrl && targetUrl.trim()) {
       let target = targetUrl;
       if (!target.startsWith('http://') && !target.startsWith('https://')) {
           target = 'https://' + target;
       }
       if (window.electronAPI?.openExternal) {
           window.electronAPI.openExternal(target);
       } else {
           window.open(target, '_blank');
       }
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) return;
    clickTimeoutRef.current = setTimeout(() => {
      openLink();
      clickTimeoutRef.current = null;
    }, 250);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (clickTimeoutRef.current !== null) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    setIsEditingLabel(true);
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    }, 0);
  };

  const applyUrl = () => {
    updateNodeData(id, { url: urlInput });
    setShowDialog(null);
  };

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || 'sans-serif';
  const isEmpty = !data.label && !data.url;

  // Context menu items
  const menuItems = [
    {
      label: 'Edit URL',
      onClick: () => { setUrlInput(data.url || ''); setShowDialog('url'); },
    },
    {
      label: 'Font & Size',
      onClick: () => setShowDialog('font'),
    },
  ];

  return (
    <div className="relative group px-1">
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />
      
      {/* Placeholder shown on hover when empty and not editing */}
      {isEmpty && !isEditingLabel && (
        <div 
          className="absolute inset-0 flex items-center text-blue-400/40 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
        >
          link
        </div>
      )}

      <div 
        ref={inputRef}
        contentEditable={isEditingLabel}
        suppressContentEditableWarning
        onClick={isEditingLabel ? undefined : handleClick}
        onDoubleClick={handleDoubleClick}
        onBlur={handleLabelBlur}
        onKeyDown={(e) => { if (e.key === 'Escape') inputRef.current.blur(); }}
        onPointerDown={(e) => { if (isEditingLabel) e.stopPropagation(); }}
        onContextMenu={onContextMenu}
        className={`text-blue-400 outline-none whitespace-nowrap min-w-[20px] min-h-[1em] select-none ${isEditingLabel ? 'cursor-text' : 'cursor-pointer hover:underline'}`}
        style={{ fontSize: `${fontSize}px`, fontFamily }}
      />

      <Handle type="source" position={Position.Right} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-blue-400" />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={closeContextMenu}
        />
      )}

      {showDialog === 'font' && (
        <FontSizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          onApply={({ fontSize: fs, fontFamily: ff }) => updateNodeData(id, { fontSize: fs, fontFamily: ff })}
          onClose={() => setShowDialog(null)}
        />
      )}

      {showDialog === 'url' && (
        <Dialog title="Edit URL" onClose={() => setShowDialog(null)}>
          <input 
            type="text"
            className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white font-mono text-sm outline-none"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://..."
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
          />
          <button className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors" onClick={applyUrl}>Done</button>
        </Dialog>
      )}
    </div>
  );
}
