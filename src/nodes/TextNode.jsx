import React, { useState, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ContextMenu } from '../components/ContextMenu';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { useContextMenu } from '../hooks/useContextMenu';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function TextNode({ id, data }) {
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showFontDialog, setShowFontDialog] = useState(false);
  const { updateNodeData } = useReactFlow();

  const inputRef = useRef(null);

  const isEmptyPredicate = () => {
    return !inputRef.current?.innerText?.trim();
  };

  const { isEditing, setIsEditing, handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, inputRef);

  const handleTextBlur = () => {
    const text = inputRef.current?.innerText || '';
    handleBlur({ text });
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    setIsEditing(true);
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus({ preventScroll: true });
    }, 0);
  };

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || 'sans-serif';
  const isEmpty = !data.text && !isEditing;

  // Sync text content when data changes externally (undo/redo)
  React.useEffect(() => {
    if (!isEditing && inputRef.current) {
      if (inputRef.current.innerText !== (data.text || '')) {
        inputRef.current.innerText = data.text || '';
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.text, isEditing]);

  const htmlContent = React.useMemo(() => {
    return DOMPurify.sanitize(marked.parse(data.text || ''));
  }, [data.text]);

  // Context menu items
  const menuItems = [
    {
      label: 'Font & Size',
      onClick: () => setShowFontDialog(true),
    },
  ];

  return (
    <div className="relative group px-1">
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white" />
      
      {/* Placeholder shown on hover when empty and not editing */}
      {isEmpty && !isEditing && (
        <div 
          className="absolute inset-0 flex items-center text-white/40 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
        >
          text
        </div>
      )}

      <div 
        ref={inputRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onDoubleClick={handleDoubleClick}
        onBlur={handleTextBlur}
        onKeyDown={(e) => { if (e.key === 'Escape') inputRef.current.blur(); }}
        onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
        onContextMenu={onContextMenu}
        className={`text-white/90 outline-none min-w-[20px] min-h-[1em] select-none ${
          isEditing ? 'cursor-text whitespace-nowrap' : 'cursor-default hidden'
        }`}
        style={{ fontSize: `${fontSize}px`, fontFamily }}
      />

      {!isEditing && (
        <div
          onDoubleClick={handleDoubleClick}
          onContextMenu={onContextMenu}
          className="text-white/90 outline-none min-w-[20px] min-h-[1em] select-none cursor-default prose-headings:m-0 prose-p:m-0 prose-ul:m-0 [&_a]:text-blue-400 [&_a]:underline"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}

      <Handle type="source" position={Position.Right} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white" />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={closeContextMenu}
        />
      )}

      {showFontDialog && (
        <FontSizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          onApply={({ fontSize: fs, fontFamily: ff }) => updateNodeData(id, { fontSize: fs, fontFamily: ff })}
          onClose={() => setShowFontDialog(false)}
        />
      )}
    </div>
  );
}
