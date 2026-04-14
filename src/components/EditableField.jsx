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
export function EditableField({ value, placeholder, isEditing, onStartEdit, onSave, variant = 'inline' }) {
  const handleBlur = (e) => onSave(e.target.value);
  const handleKeyDown = (e) => { if (e.key === 'Enter') onSave(e.target.value); };

  if (isEditing) {
    const inputClass = variant === 'title'
      ? 'w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none'
      : 'w-16 bg-black/30 border border-white/10 rounded px-1 text-white text-xs outline-none inline-block';

    return (
      <input
        autoFocus
        className={inputClass}
        defaultValue={value || ''}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    );
  }

  if (variant === 'title') {
    return (
      <div
        className="text-white/90 text-sm font-semibold leading-tight cursor-text hover:bg-white/5 rounded px-1 -mx-1 py-0.5"
        onClick={onStartEdit}
      >
        {value || placeholder || 'Click to edit'}
      </div>
    );
  }

  return (
    <span
      className="text-white/60 cursor-text hover:text-white/80"
      onClick={onStartEdit}
    >
      {value || placeholder || '?'}
    </span>
  );
}
