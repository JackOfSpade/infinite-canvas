import React, { useState } from 'react';
import { Dialog } from './Dialog';

/**
 * Font family options available in the picker.
 * Extend this array to add new fonts globally.
 */
const FONT_OPTIONS = [
  { value: 'sans-serif', label: 'Sans-Serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
  { value: 'system-ui', label: 'System UI' },
];

/**
 * Reusable Font & Size dialog.
 * Used by TextNode, LinkNode, and ListingNode to avoid duplicating the same UI.
 *
 * Props:
 *   fontSize     — current font size (number)
 *   fontFamily   — current font family (string)
 *   onApply({ fontSize, fontFamily }) — called when user clicks Done
 *   onClose      — called to dismiss the dialog
 */
export function FontSizeDialog({ fontSize: initialSize, fontFamily: initialFamily, onApply, onClose }) {
  const [fontSize, setFontSize] = useState(initialSize);
  const [fontFamily, setFontFamily] = useState(initialFamily);

  const handleApply = () => {
    onApply({ fontSize, fontFamily });
    onClose();
  };

  return (
    <Dialog title="Font & Size" onClose={onClose} width="w-64">
      <div className="flex justify-between items-center gap-2">
        <label className="text-white/70 text-sm w-12">Font</label>
        <select
          className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
        >
          {FONT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-between items-center gap-2">
        <label className="text-white/70 text-sm w-12">Size</label>
        <input
          type="number"
          className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
          value={fontSize}
          onChange={(e) => setFontSize(Math.max(1, Number(e.target.value) || 1))}
          min={1}
        />
      </div>
      <button
        className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-2 font-medium transition-colors"
        onClick={handleApply}
      >
        Done
      </button>
    </Dialog>
  );
}
