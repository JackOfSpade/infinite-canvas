import React, { useState } from 'react';
import { Dialog } from './Dialog';

/**
 * Font family options available in the picker.
 * Grouped: Generic → Common cross-platform → macOS-specific → Developer/modern.
 */
const FONT_OPTIONS = [
  // ── Generic (always available) ─────────────────────────────────────────
  { value: 'system-ui, sans-serif',                          label: 'System UI' },
  { value: 'sans-serif',                                     label: 'Sans-Serif' },
  { value: 'serif',                                          label: 'Serif' },
  { value: 'monospace',                                      label: 'Monospace' },
  { value: 'cursive',                                        label: 'Cursive' },
  { value: 'fantasy',                                        label: 'Fantasy' },
  // ── Common cross-platform ──────────────────────────────────────────────
  { value: 'Arial, sans-serif',                              label: 'Arial' },
  { value: '"Helvetica Neue", Helvetica, sans-serif',        label: 'Helvetica' },
  { value: 'Verdana, Geneva, sans-serif',                    label: 'Verdana' },
  { value: 'Tahoma, Geneva, sans-serif',                     label: 'Tahoma' },
  { value: '"Trebuchet MS", Helvetica, sans-serif',          label: 'Trebuchet MS' },
  { value: 'Impact, Charcoal, sans-serif',                   label: 'Impact' },
  { value: '"Arial Narrow", Arial, sans-serif',              label: 'Arial Narrow' },
  { value: 'Georgia, serif',                                 label: 'Georgia' },
  { value: '"Times New Roman", Times, serif',                label: 'Times New Roman' },
  { value: '"Palatino Linotype", Palatino, serif',           label: 'Palatino' },
  { value: 'Garamond, serif',                                label: 'Garamond' },
  { value: '"Book Antiqua", Palatino, serif',                label: 'Book Antiqua' },
  { value: '"Courier New", Courier, monospace',              label: 'Courier New' },
  { value: '"Lucida Console", Monaco, monospace',            label: 'Lucida Console' },
  { value: '"Lucida Sans Unicode", "Lucida Grande", sans-serif', label: 'Lucida Sans' },
  { value: '"Comic Sans MS", "Comic Sans", cursive',         label: 'Comic Sans' },
  // ── macOS / Apple ──────────────────────────────────────────────────────
  { value: '-apple-system, BlinkMacSystemFont, sans-serif',  label: 'SF Pro (macOS)' },
  { value: '"SF Mono", "Fira Mono", monospace',              label: 'SF Mono (macOS)' },
  { value: 'Menlo, Monaco, monospace',                       label: 'Menlo (macOS)' },
  { value: '"Gill Sans", "Gill Sans MT", sans-serif',        label: 'Gill Sans' },
  { value: 'Optima, Candara, sans-serif',                    label: 'Optima (macOS)' },
  { value: 'Futura, "Century Gothic", sans-serif',           label: 'Futura' },
  { value: 'Baskerville, "Baskerville Old Face", serif',     label: 'Baskerville' },
  { value: 'Didot, "GFS Didot", serif',                      label: 'Didot (macOS)' },
  { value: '"Bodoni MT", Bodoni, serif',                     label: 'Bodoni' },
  { value: '"Cochin", Georgia, serif',                       label: 'Cochin' },
  // ── Developer / modern ─────────────────────────────────────────────────
  { value: '"Inter", system-ui, sans-serif',                 label: 'Inter' },
  { value: '"JetBrains Mono", "Fira Code", monospace',       label: 'JetBrains Mono' },
  { value: '"Fira Code", "Fira Mono", monospace',            label: 'Fira Code' },
  { value: '"Source Code Pro", monospace',                   label: 'Source Code Pro' },
  { value: '"Ubuntu Mono", monospace',                       label: 'Ubuntu Mono' },
];

/** Quick-pick text colour swatches */
const TEXT_COLORS = [
  '#ffffff', '#e5e7eb', '#fbbf24', '#fb923c',
  '#f87171', '#f472b6', '#c084fc', '#60a5fa',
  '#22d3ee', '#4ade80', '#1f2937',
];

/**
 * Reusable Font & Size dialog — changes apply instantly without clicking Done.
 * Used by TextNode, LinkNode, and CanvasNode.
 *
 * Props:
 *   fontSize      — current font size (number)
 *   fontFamily    — current font family (string)
 *   textColor     — current text colour (string, optional)
 *   titleSpacing  — vertical gap between title and arc (number, optional; only shown when provided)
 *   onApply({ fontSize, fontFamily, textColor, titleSpacing }) — called on every change
 *   onClose       — called to dismiss the dialog
 */
export function FontSizeDialog({
  fontSize: initialSize,
  fontFamily: initialFamily,
  textColor: initialColor = '#ffffff',
  titleSpacing: initialSpacing,
  onApply,
  onClose,
}) {
  const [fontSize,     setFontSize]     = useState(initialSize);
  const [fontFamily,   setFontFamily]   = useState(initialFamily);
  const [textColor,    setTextColor]    = useState(initialColor);
  const [titleSpacing, setTitleSpacing] = useState(initialSpacing ?? 0);

  const showSpacing = initialSpacing !== undefined;

  /** Push every change to the caller immediately — no Done button needed. */
  const emit = (overrides) => {
    onApply({
      fontSize,
      fontFamily,
      textColor,
      titleSpacing,
      ...overrides,
    });
  };

  // ── Font family ───────────────────────────────────────────────────────────
  const handleFamilyChange = (val) => {
    setFontFamily(val);
    emit({ fontFamily: val });
  };

  // ── Font size ─────────────────────────────────────────────────────────────
  const handleSizeChange = (val) => {
    const clamped = Math.max(1, Math.min(500, Number(val) || 1));
    setFontSize(clamped);
    emit({ fontSize: clamped });
  };

  // ── Title spacing ─────────────────────────────────────────────────────────
  const handleSpacingChange = (val) => {
    const clamped = Math.max(-20, Math.min(40, Number(val) || 0));
    setTitleSpacing(clamped);
    emit({ titleSpacing: clamped });
  };

  // ── Text colour ───────────────────────────────────────────────────────────
  const handleColorSwatch = (c) => {
    setTextColor(c);
    emit({ textColor: c });
  };

  const handleColorInput = (val) => {
    setTextColor(val);
    // Only emit when it looks like a complete colour value
    if (/^#[0-9a-fA-F]{3,8}$/.test(val) || /^rgba?\(/.test(val)) {
      emit({ textColor: val });
    }
  };

  return (
    <Dialog title="Font & Size" onClose={onClose}>
      {/* Font family */}
      <div className="flex justify-between items-center gap-2">
        <label className="text-white/70 text-sm w-16 shrink-0">Font</label>
        <select
          className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
          value={fontFamily}
          onChange={(e) => handleFamilyChange(e.target.value)}
          style={{ fontFamily }}
        >
          {FONT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value} style={{ fontFamily: opt.value }}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Font size */}
      <div className="flex justify-between items-center gap-2">
        <label className="text-white/70 text-sm w-16 shrink-0">Size</label>
        <input
          type="number"
          className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
          value={fontSize}
          onChange={(e) => handleSizeChange(e.target.value)}
          min={1}
          max={500}
        />
      </div>

      {/* Title spacing (only for canvas nodes) */}
      {showSpacing && (
        <div className="flex justify-between items-center gap-2">
          <label className="text-white/70 text-sm w-16 shrink-0">Gap</label>
          <input
            type="number"
            className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
            value={titleSpacing}
            onChange={(e) => handleSpacingChange(e.target.value)}
            min={-20}
            max={40}
            title="Gap between title and circle edge (px)"
          />
        </div>
      )}

      {/* Text colour */}
      <div>
        <label className="text-white/70 text-xs mb-1.5 block">Text Color</label>
        {/* Quick swatches */}
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {TEXT_COLORS.map(c => (
            <button
              key={c}
              onClick={() => handleColorSwatch(c)}
              className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${textColor === c ? 'ring-2 ring-white scale-110' : 'opacity-75'}`}
              style={{ backgroundColor: c, border: c === '#ffffff' ? '1px solid rgba(255,255,255,0.3)' : 'none' }}
              title={c}
            />
          ))}
        </div>
        {/* Custom hex input */}
        <input
          type="text"
          placeholder="#HEX or rgba(…)"
          value={textColor}
          onChange={(e) => handleColorInput(e.target.value)}
          onBlur={(e) => emit({ textColor: e.target.value })}
          className="w-full text-xs p-1.5 bg-black/50 text-white rounded outline-none border border-white/20 focus:border-blue-400"
        />
      </div>
    </Dialog>
  );
}
