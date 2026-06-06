import React from 'react';

/**
 * EditableField — click-to-edit inline text field.
 * Shared by ListingNode and SellHubNode for title, brand, model editing.
 *
 * @param {string}   value       - Current field value
 * @param {string}   placeholder - Placeholder when value is empty
 * @param {boolean}  isEditing   - Whether this field is in edit mode
 * @param {function} onStartEdit - Called when user clicks to edit
 * @param {function} onSave      - Called with new value on blur or Enter
 * @param {string}   [variant]   - 'title' (larger), 'inline' (compact), or 'multiline' (textarea)
 */
export function EditableField({ value, placeholder, isEditing, onStartEdit, onSave, variant = 'inline', disabled = false }) {
  const handleBlur = (e) => onSave(e.target.value);
  // Enter saves on single-line variants; multiline keeps Enter for newlines
  // and saves on blur or Cmd/Ctrl-Enter.
  const handleKeyDown = (e) => {
    if (variant === 'multiline') {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(e.target.value);
    } else if (e.key === 'Enter') {
      onSave(e.target.value);
    }
  };

  if (isEditing && !disabled) {
    // `nodrag` makes ReactFlow ignore pointer-downs that start inside the
    // input so the user can drag-select text without the parent node moving.
    // `stopPropagation` on pointerdown is defensive — matches the pattern
    // used by other in-node controls in this codebase.
    if (variant === 'multiline') {
      return (
        <textarea
          autoFocus
          rows={4}
          data-native-undo="true"
          className="nodrag w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-white/80 text-[10px] leading-relaxed outline-none resize-y"
          defaultValue={value || ''}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      );
    }
    const inputClass = variant === 'title'
      ? 'nodrag w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none'
      : 'nodrag w-16 bg-black/30 border border-white/10 rounded px-1 text-white text-xs outline-none inline-block';

    return (
      <input
        autoFocus
        data-native-undo="true"
        className={inputClass}
        defaultValue={value || ''}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onPointerDown={(e) => e.stopPropagation()}
        // Native dblclick is its own event, not derived from pointerdown — so
        // the pointerdown stopper above doesn't suppress it. Without this
        // stop, double-clicking a word to select it bubbles to ReactFlow's
        // onDoubleClick, which spawns a text node, steals focus, and
        // collapses edit mode before the word selection is even visible.
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  }

  if (variant === 'multiline') {
    return (
      <div
        className={`text-white/35 text-[10px] leading-relaxed rounded px-1 -mx-1 py-0.5 ${
          disabled ? 'cursor-default' : 'cursor-text hover:bg-white/5 hover:text-white/60'
        }`}
        onClick={disabled ? undefined : onStartEdit}
        title={disabled ? undefined : 'Click to edit description'}
      >
        {value || placeholder || 'Click to add a description'}
      </div>
    );
  }

  if (variant === 'title') {
    return (
      <div
        className={`text-white/90 text-sm font-semibold leading-tight rounded px-1 -mx-1 py-0.5 ${
          disabled ? 'cursor-default' : 'cursor-text hover:bg-white/5'
        }`}
        onClick={disabled ? undefined : onStartEdit}
      >
        {value || placeholder || 'Click to edit'}
      </div>
    );
  }

  return (
    <span
      className={`text-white/60 ${disabled ? 'cursor-default' : 'cursor-text hover:text-white/80'}`}
      onClick={disabled ? undefined : onStartEdit}
    >
      {value || placeholder || '?'}
    </span>
  );
}
