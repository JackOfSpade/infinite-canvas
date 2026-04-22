import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { CustomizeDialog } from '../components/CustomizeDialog';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Lock } from 'lucide-react';

export function TextNode({ id, data }) {
  const [showCustomizeDialog, setShowCustomizeDialog] = useState(false);
  const { updateNodeData } = useReactFlow();

  const inputRef = useRef(null);

  const isEmptyPredicate = useCallback(() => {
    return !inputRef.current?.innerText?.trim();
  }, []);

  const { isEditing, setIsEditing, handleBlur } = useNodeAutoEdit(id, data.isNew, isEmptyPredicate, inputRef);

  const handleTextBlur = useCallback(() => {
    const text = inputRef.current?.innerText || '';
    handleBlur({ text });
  }, [handleBlur]);

  const handleDoubleClick = useCallback((e) => {
    if (data.locked) return; // Locked nodes are not editable
    e.stopPropagation();
    setIsEditing(true);
  }, [data.locked, setIsEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    }
  }, [isEditing]);

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily || (data.isSticky ? "'Indie Flower', 'Comic Sans MS', cursive" : 'sans-serif');
  // textColor overrides the default; sticky notes default to dark ink
  const textColor = data.textColor || (data.isSticky ? '#1f2937' : null);
  const isEmpty = !data.text && !isEditing;

  // Sync text content when data changes externally (undo/redo)
  useEffect(() => {
    if (!isEditing && inputRef.current) {
      if (inputRef.current.innerText !== (data.text || '')) {
        inputRef.current.innerText = data.text || '';
      }
    }
  }, [data.text, isEditing]);

  const htmlContent = useMemo(() => {
    return DOMPurify.sanitize(marked.parse(data.text || ''));
  }, [data.text]);

  // Listen for font dialog trigger from global context menu
  useEffect(() => {
    const handleOpenFont = () => {
      if (data.locked) return; // Locked nodes are not editable
      setShowCustomizeDialog(true);
    };
    document.addEventListener(`edit-node-font-${id}`, handleOpenFont);
    return () => document.removeEventListener(`edit-node-font-${id}`, handleOpenFont);
  }, [id, data.locked]);

  return (
    <div 
      className={`relative group px-2 py-1 rounded-md transition-colors ${data.isSticky ? 'shadow-xl' : ''}`}
      style={{
        backgroundColor: data.isSticky ? (data.backgroundColor ? data.backgroundColor.replace(/[\d.]+\)$/, '1)') : '#fef3c7') : (data.backgroundColor || 'transparent'),
        minWidth: data.isSticky ? '150px' : 'auto',
        minHeight: data.isSticky ? '150px' : 'auto',
        transform: data.isSticky && !isEditing ? 'rotate(-2deg)' : 'none',
        boxShadow: data.isSticky ? '2px 4px 10px rgba(0,0,0,0.3)' : undefined,
        borderBottomRightRadius: data.isSticky ? '20px 15px' : undefined,
        color: data.isSticky ? '#1f2937' : 'inherit'
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />
      <Handle type="target" position={Position.Left} id="left" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />
      
      {data.isSticky && (
        <div className="absolute bottom-0 right-0 w-6 h-6 rounded-tl-xl transition-all pointer-events-none" 
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
      {isEmpty && (
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
        className={`outline-none min-w-[20px] min-h-[1em] ${
          isEditing ? 'cursor-text whitespace-nowrap' : 'select-none cursor-default hidden'
        }`}
        style={{ fontSize: `${fontSize}px`, fontFamily, ...(textColor ? { color: textColor } : {}), ...(isEditing ? { userSelect: 'text' } : {}) }}
      />

      {!isEditing && (
        <div
          onDoubleClick={handleDoubleClick}
          className={`outline-none min-w-[20px] min-h-[1em] select-none cursor-default prose-headings:m-0 prose-p:m-0 prose-ul:m-0 [&_a]:text-blue-500 [&_a]:underline ${data.isSticky ? 'p-2 font-handwriting' : ''}`}
          style={{
            fontSize: `${fontSize}px`,
            fontFamily: fontFamily,
            ...(textColor ? { color: textColor } : {}),
          }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}

      <Handle type="source" position={Position.Right} id="right" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />

      {showCustomizeDialog && (
        <CustomizeDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          textColor={data.textColor || (data.isSticky ? '#1f2937' : '#ffffff')}
          backgroundColor={data.backgroundColor}
          onApply={(updates) => updateNodeData(id, updates)}
          onClose={() => setShowCustomizeDialog(false)}
        />
      )}
    </div>
  );
}
