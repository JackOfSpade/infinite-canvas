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
 * @param {string}   [variant]   - 'title' (larger) or 'inline' (compact)
 */
export function EditableField({ value, placeholder, isEditing, onStartEdit, onSave, variant = 'inline', disabled = false }) {
  const handleBlur = (e) => onSave(e.target.value);
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onSave(e.target.value);
    }
  };

  if (isEditing && !disabled) {
    // `nodrag` makes ReactFlow ignore pointer-downs that start inside the
    // input so the user can drag-select text without the parent node moving.
    // `stopPropagation` on pointerdown is defensive — matches the pattern
    // used by other in-node controls in this codebase.
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
