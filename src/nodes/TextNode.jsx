import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position, useReactFlow, NodeResizeControl } from '@xyflow/react';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Lock } from 'lucide-react';

const RESIZE_CORNERS = [
  { position: 'top-left', cursor: 'nwse-resize' },
  { position: 'top-right', cursor: 'nesw-resize' },
  { position: 'bottom-left', cursor: 'nesw-resize' },
  { position: 'bottom-right', cursor: 'nwse-resize' },
];

export const TextNode = React.memo(function TextNode({ id, data, selected, width, height }) {
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

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') inputRef.current?.blur();
  }, []);

  const handlePointerDown = useCallback((e) => {
    if (isEditing) e.stopPropagation();
  }, [isEditing]);

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

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

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

  const isResized = width != null && height != null;
  const showResizeHandles = selected && !data.locked;

  return (
    <div
      className={`relative group rounded-md transition-colors ${data.isSticky ? 'shadow-xl' : ''} ${isResized ? 'overflow-hidden px-0.5 py-0' : 'px-2 py-0.5'} ${isEditing ? 'nodrag' : ''}`}
      style={{
        backgroundColor: data.isSticky ? (data.backgroundColor ? data.backgroundColor.replace(/[\d.]+\)$/, '1)') : '#fef3c7') : (data.backgroundColor || 'transparent'),
        minWidth: data.isSticky ? '150px' : 'auto',
        minHeight: data.isSticky ? '150px' : 'auto',
        width: isResized ? '100%' : undefined,
        height: isResized ? '100%' : undefined,
        transform: data.isSticky && !isEditing ? 'rotate(-2deg)' : 'none',
        boxShadow: data.isSticky ? '2px 4px 10px rgba(0,0,0,0.3)' : undefined,
        borderBottomRightRadius: data.isSticky ? '20px 15px' : undefined,
        color: data.isSticky ? '#1f2937' : 'inherit'
      }}
    >
      {showResizeHandles && RESIZE_CORNERS.map(({ position, cursor }) => (
        <NodeResizeControl
          key={position}
          position={position}
          minWidth={data.isSticky ? 150 : 60}
          minHeight={data.isSticky ? 150 : Math.ceil(fontSize * 1.2)}
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: '#3b82f6',
            border: 'none',
            cursor,
          }}
        />
      ))}
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
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPaste={handlePaste}
        className={`outline-none min-w-[20px] min-h-[1em] ${
          isEditing
            ? `cursor-text ${isResized ? 'whitespace-pre-wrap break-words thin-scrollbar' : 'whitespace-nowrap'}`
            : 'select-none cursor-default hidden'
        }`}
        style={{
          fontSize: `${fontSize}px`,
          fontFamily,
          lineHeight: 1.2,
          ...(textColor ? { color: textColor } : {}),
          ...(isEditing ? { userSelect: 'text' } : {}),
          ...(isResized ? { width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', overflowWrap: 'break-word' } : {}),
        }}
      />

      {!isEditing && (
        <div
          onDoubleClick={handleDoubleClick}
          className={`text-node-content outline-none min-w-[20px] min-h-[1em] select-none cursor-default [&_a]:text-blue-500 [&_a]:underline ${data.isSticky ? 'p-2 font-handwriting' : ''} ${isResized ? 'break-words thin-scrollbar' : ''}`}
          style={{
            fontSize: `${fontSize}px`,
            fontFamily: fontFamily,
            lineHeight: 1.2,
            ...(textColor ? { color: textColor } : {}),
            ...(isResized ? { width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', overflowWrap: 'break-word', whiteSpace: 'pre-wrap' } : {}),
          }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}

      <Handle type="source" position={Position.Right} id="right" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${data.isSticky ? 'bg-black/50' : 'bg-white'}`} />


    </div>
  );
});
