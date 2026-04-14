import React, { useState, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { FontSizeDialog } from '../components/FontSizeDialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Lock } from 'lucide-react';

export function TextNode({ id, data }) {
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
  }, [data.text, isEditing]);

  const htmlContent = React.useMemo(() => {
    return DOMPurify.sanitize(marked.parse(data.text || ''));
  }, [data.text]);

  // Listen for font dialog trigger from global context menu
  React.useEffect(() => {
    const handleOpenFont = () => setShowFontDialog(true);
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id]);

  return (
    <div 
      className={`relative group px-2 py-1 rounded-md transition-colors ${data.isSticky ? 'shadow-xl' : ''}`}
      style={{
        backgroundColor: data.isSticky ? (data.backgroundColor || '#fef3c7') : (data.backgroundColor || 'transparent'),
        minWidth: data.isSticky ? '150px' : 'auto',
        minHeight: data.isSticky ? '150px' : 'auto',
        transform: data.isSticky && !isEditing ? 'rotate(-2deg)' : 'none',
        boxShadow: data.isSticky ? '2px 4px 10px rgba(0,0,0,0.3)' : undefined,
        borderBottomRightRadius: data.isSticky ? '20px 15px' : undefined,
        color: data.isSticky ? '#1f2937' : 'inherit'
      }}
    >
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white" />
      
      {data.isSticky && (
        <div className="absolute bottom-0 right-0 w-6 h-6 rounded-tl-xl transition-all" 
          style={{
            background: 'linear-gradient(to top left, rgba(0,0,0,0) 50%, rgba(0,0,0,0.05) 50%)',
            borderBottomRightRadius: '15px'
          }} 
        />
      )}

      
      {data.locked && (
        <div className="absolute -top-2 -right-2 bg-black/60 rounded-full p-0.5 text-white/70 backdrop-blur-sm pointer-events-none z-10">
          <Lock size={10} />
        </div>
      )}
      
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
        onContextMenu={(e) => { if (isEditing) e.stopPropagation(); }}
        className={`outline-none min-w-[20px] min-h-[1em] select-none ${
          isEditing ? 'cursor-text whitespace-nowrap' : 'cursor-default hidden'
        } ${data.isSticky ? 'text-gray-900' : 'text-white/90'}`}
        style={{ fontSize: `${fontSize}px`, fontFamily }}
      />

      {!isEditing && (
        <div
          onDoubleClick={handleDoubleClick}
          className={`outline-none min-w-[20px] min-h-[1em] select-none cursor-default prose-headings:m-0 prose-p:m-0 prose-ul:m-0 [&_a]:text-blue-500 [&_a]:underline ${data.isSticky ? 'text-gray-900 p-2 font-handwriting' : 'text-white/90'}`}
          style={{ fontSize: `${fontSize}px`, fontFamily: data.isSticky ? "'Indie Flower', 'Comic Sans MS', cursive" : fontFamily }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}

      <Handle type="source" position={Position.Right} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white" />

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
