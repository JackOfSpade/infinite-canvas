import React, { useRef, useCallback, useEffect } from 'react';
import { NodeResizeControl } from '@xyflow/react';
import { useNodeAutoEdit } from '../hooks/useNodeAutoEdit';
import { NodeHandles } from './_shared/NodeHandles';
import { LockBadge } from './_shared/LockBadge';
import { pasteAsPlainText, blurOnEscape } from './_shared/textEditingHandlers';

const RESIZE_CORNERS = [
  { position: 'top-left',     cursor: 'nwse-resize' },
  { position: 'top-right',    cursor: 'nesw-resize' },
  { position: 'bottom-left',  cursor: 'nesw-resize' },
  { position: 'bottom-right', cursor: 'nwse-resize' },
];

const RESIZE_HANDLE_STYLE = {
  width: 8, height: 8, borderRadius: 2, background: '#3b82f6', border: 'none',
};

// Style applied to the inner content element when the node has been user-resized.
// Both the editing div and the display div use the same scroll/wrap behavior.
const RESIZED_INNER_STYLE = {
  width: '100%',
  height: '100%',
  overflowY: 'auto',
  overflowX: 'hidden',
  overflowWrap: 'break-word',
};

export const TextNode = React.memo(function TextNode({ id, data, selected, width, height }) {
  const inputRef = useRef(null);

  const isEmptyPredicate = useCallback(
    () => !inputRef.current?.innerText?.trim(),
    [],
  );

  const { isEditing, setIsEditing, handleBlur } = useNodeAutoEdit(
    id, data.isNew, isEmptyPredicate, inputRef,
  );

  const handleTextBlur = useCallback(() => {
    handleBlur({ text: inputRef.current?.innerText || '' });
  }, [handleBlur]);

  const handleKeyDown = useCallback((e) => {
    blurOnEscape(e, inputRef);
  }, []);

  const handleDoubleClick = useCallback((e) => {
    if (data.locked) return;
    e.stopPropagation();
    setIsEditing(true);
  }, [data.locked, setIsEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    }
  }, [isEditing]);

  const handlePaste = useCallback((e) => {
    pasteAsPlainText(e);
  }, []);

  const fontSize = data.fontSize || 14;
  const fontFamily = data.fontFamily
    || (data.isSticky ? "'Indie Flower', 'Comic Sans MS', cursive" : 'sans-serif');
  // textColor overrides the default; sticky notes default to dark ink
  const textColor = data.textColor || (data.isSticky ? '#1f2937' : null);
  const isEmpty = !data.text && !isEditing;
  const isResized = width != null && height != null;
  const showResizeHandles = selected && !data.locked;

  // Sync text content when data changes externally (undo/redo)
  useEffect(() => {
    if (!isEditing && inputRef.current) {
      const next = data.text || '';
      if (inputRef.current.innerText !== next) inputRef.current.innerText = next;
    }
  }, [data.text, isEditing]);

  // Background for sticky notes: force opaque alpha if user picked a color, else default cream.
  // Only rewrite a genuine 4-component rgba(...) alpha channel here -- a naive trailing
  // "<number>)" match would also clobber the blue channel of a plain rgb(...) color.
  const stickyBg = data.backgroundColor
    ? data.backgroundColor.replace(
      /^(rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,)\s*[\d.]+\s*\)$/,
      '$1 1)',
    )
    : '#fef3c7';

  const wrapperClassName = [
    'relative group rounded-md transition-colors',
    data.isSticky && 'shadow-xl',
    isResized ? 'overflow-hidden px-0.5 py-0' : 'px-2 py-0.5',
    isEditing && 'nodrag',
  ].filter(Boolean).join(' ');

  const wrapperStyle = {
    backgroundColor: data.isSticky ? stickyBg : (data.backgroundColor || 'transparent'),
    minWidth: data.isSticky ? '150px' : 'auto',
    minHeight: data.isSticky ? '150px' : 'auto',
    width: isResized ? '100%' : undefined,
    height: isResized ? '100%' : undefined,
    transform: data.isSticky && !isEditing ? 'rotate(-2deg)' : 'none',
    boxShadow: data.isSticky ? '2px 4px 10px rgba(0,0,0,0.3)' : undefined,
    borderBottomRightRadius: data.isSticky ? '20px 15px' : undefined,
    color: data.isSticky ? '#1f2937' : 'inherit',
  };

  const innerBaseStyle = {
    fontSize: `${fontSize}px`,
    fontFamily,
    lineHeight: 1.2,
    ...(textColor ? { color: textColor } : null),
  };

  const handleClassName = `w-2 h-2 ${data.isSticky ? 'bg-black/50' : 'bg-white'}`;

  return (
    <div className={wrapperClassName} style={wrapperStyle}>
      {showResizeHandles && RESIZE_CORNERS.map(({ position, cursor }) => (
        <NodeResizeControl
          key={position}
          position={position}
          minWidth={data.isSticky ? 150 : 60}
          minHeight={data.isSticky ? 150 : Math.ceil(fontSize * 1.2)}
          style={{ ...RESIZE_HANDLE_STYLE, cursor }}
        />
      ))}

      <NodeHandles className={handleClassName} />

      {data.isSticky && (
        <div
          className="absolute bottom-0 right-0 w-6 h-6 rounded-tl-xl transition-all pointer-events-none"
          style={{
            background: 'linear-gradient(to top left, rgba(0,0,0,0) 50%, rgba(0,0,0,0.05) 50%)',
            borderBottomRightRadius: '15px',
          }}
        />
      )}

      {data.locked && <LockBadge />}

      {isEmpty && (
        <div
          className="absolute inset-0 flex items-center text-white/40 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
        >
          text
        </div>
      )}

      {/* Editing surface: a contenteditable. Hidden (display: none via `hidden`) when not editing. */}
      <div
        ref={inputRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onDoubleClick={handleDoubleClick}
        onBlur={handleTextBlur}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className={`outline-none min-w-[20px] min-h-[1em] ${
          isEditing
            ? `cursor-text ${isResized ? 'whitespace-pre-wrap break-words thin-scrollbar' : 'whitespace-nowrap'}`
            : 'select-none cursor-default hidden'
        }`}
        style={{
          ...innerBaseStyle,
          ...(isEditing ? { userSelect: 'text' } : null),
          ...(isResized ? RESIZED_INNER_STYLE : null),
        }}
      />

      {/* Display surface: plain-text rendering of `data.text`. Hidden while editing so the
          contenteditable shows. We deliberately do NOT parse markdown — text nodes are not
          .md and shouldn't reinterpret `*foo*` as italics, `[x](y)` as a link, etc. Newlines
          render as visible line breaks via `whiteSpace: pre-wrap`. */}
      {!isEditing && (
        <div
          onDoubleClick={handleDoubleClick}
          className={`outline-none min-w-[20px] min-h-[1em] select-none cursor-default ${
            data.isSticky ? 'p-2 font-handwriting' : ''
          } ${isResized ? 'break-words thin-scrollbar' : ''}`}
          style={{
            ...innerBaseStyle,
            whiteSpace: 'pre-wrap',
            ...(isResized ? RESIZED_INNER_STYLE : null),
          }}
        >
          {data.text || ''}
        </div>
      )}
    </div>
  );
});
