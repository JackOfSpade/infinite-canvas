import React, { useState } from 'react';
import { Dialog } from './Dialog';

/**
 * Font family options available in the picker.
 * Grouped: Generic → Common cross-platform → macOS-specific → Developer/modern.
 */
const FONT_OPTIONS = [
  // ── Generic (always available) ─────────────────────────────────────────
  { value: 'system-ui, sans-serif', label: 'System UI' },
  { value: 'sans-serif', label: 'Sans-Serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
  { value: 'cursive', label: 'Cursive' },
  { value: 'fantasy', label: 'Fantasy' },
  // ── Common cross-platform ──────────────────────────────────────────────
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: '"Helvetica Neue", Helvetica, sans-serif', label: 'Helvetica' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: 'Tahoma, Geneva, sans-serif', label: 'Tahoma' },
  { value: '"Trebuchet MS", Helvetica, sans-serif', label: 'Trebuchet MS' },
  { value: 'Impact, Charcoal, sans-serif', label: 'Impact' },
  { value: '"Arial Narrow", Arial, sans-serif', label: 'Arial Narrow' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: '"Times New Roman", Times, serif', label: 'Times New Roman' },
  { value: '"Palatino Linotype", Palatino, serif', label: 'Palatino' },
  { value: 'Garamond, serif', label: 'Garamond' },
  { value: '"Book Antiqua", Palatino, serif', label: 'Book Antiqua' },
  { value: '"Courier New", Courier, monospace', label: 'Courier New' },
  { value: '"Lucida Console", Monaco, monospace', label: 'Lucida Console' },
  { value: '"Lucida Sans Unicode", "Lucida Grande", sans-serif', label: 'Lucida Sans' },
  { value: '"Comic Sans MS", "Comic Sans", cursive', label: 'Comic Sans' },
  // ── macOS / Apple ──────────────────────────────────────────────────────
  { value: '-apple-system, BlinkMacSystemFont, sans-serif', label: 'SF Pro (macOS)' },
  { value: '"SF Mono", "Fira Mono", monospace', label: 'SF Mono (macOS)' },
  { value: 'Menlo, Monaco, monospace', label: 'Menlo (macOS)' },
  { value: '"Gill Sans", "Gill Sans MT", sans-serif', label: 'Gill Sans' },
  { value: 'Optima, Candara, sans-serif', label: 'Optima (macOS)' },
  { value: 'Futura, "Century Gothic", sans-serif', label: 'Futura' },
  { value: 'Baskerville, "Baskerville Old Face", serif', label: 'Baskerville' },
  { value: 'Didot, "GFS Didot", serif', label: 'Didot (macOS)' },
  { value: '"Bodoni MT", Bodoni, serif', label: 'Bodoni' },
  { value: '"Cochin", Georgia, serif', label: 'Cochin' },
  // ── Developer / modern ─────────────────────────────────────────────────
  { value: '"Inter", system-ui, sans-serif', label: 'Inter' },
  { value: '"JetBrains Mono", "Fira Code", monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", "Fira Mono", monospace', label: 'Fira Code' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },
  { value: '"Ubuntu Mono", monospace', label: 'Ubuntu Mono' },
];

/** Quick-pick text colour swatches (Pastel Primary + Secondary colors) */
const TEXT_COLORS = [
  '#000000', // Black
  '#ffffff', // White
  '#fca5a5', // Pastel Red
  '#fdba74', // Pastel Orange
  '#fde047', // Pastel Yellow
  '#86efac', // Pastel Green
  '#93c5fd', // Pastel Blue
  '#d8b4fe', // Pastel Purple
];

const BG_COLORS = ['transparent', ...TEXT_COLORS];

const ColorSection = ({ label, colors, value, onSwatchClick, onInputChange, onInputBlur }) => {
  const currentRep = (value === null || value === '') ? 'transparent' : value;

  return (
    <div>
      <label className="text-white/70 text-xs mb-1.5 block">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {colors.map(c => (
          <button
            key={c}
            onClick={() => onSwatchClick(c)}
            className={`w-5 h-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${currentRep === c ? 'ring-2 ring-white scale-110' : 'opacity-75'}`}
            style={{
              backgroundColor: c === 'transparent' ? '#1f1f1f' : c,
              border: c === '#ffffff' ? '1px solid rgba(255,255,255,0.3)' : (c === 'transparent' ? '1px dashed rgba(255,255,255,0.3)' : 'none')
            }}
            title={c === 'transparent' ? `Clear ${label}` : c}
          >
            {c === 'transparent' && <span className="text-white/40 text-[10px] pointer-events-none">✕</span>}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="#HEX or rgba(…)"
        value={value || ''}
        onChange={(e) => onInputChange(e.target.value)}
        onBlur={(e) => onInputBlur(e.target.value)}
        className="w-full text-xs p-1.5 bg-black/50 text-white rounded outline-none border border-white/20 focus:border-blue-400"
      />
    </div>
  );
};

/**
 * Reusable Customize dialog
 */
export function CustomizeDialog({
  fontSize: initialSize,
  fontFamily: initialFamily,
  textColor: initialColor = '#ffffff',
  backgroundColor: initialBgColor = 'transparent',
  titleSpacing: initialSpacing,
  onApply,
  onClose,
}) {
  const [fontSize, setFontSize] = useState(initialSize);
  const [fontFamily, setFontFamily] = useState(initialFamily);
  const [textColor, setTextColor] = useState(initialColor);
  const [backgroundColor, setBackgroundColor] = useState(initialBgColor);
  const [titleSpacing, setTitleSpacing] = useState(initialSpacing ?? 0);

  const showSpacing = initialSpacing !== undefined;
  const hasFont = initialSize !== undefined;

  /** Push every change to the caller immediately — no Done button needed. */
  const emit = (overrides) => {
    const payload = { fontSize, fontFamily, textColor, backgroundColor, titleSpacing, ...overrides };
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    onApply(cleanPayload);
  };

  const handleFamilyChange = (val) => {
    setFontFamily(val);
    emit({ fontFamily: val });
  };

  const handleSizeChange = (val) => {
    setFontSize(val);
    const num = Number(val);
    // Emit real-time updates ONLY if the current input is a valid number inside bounds
    if (!isNaN(num) && num >= 1 && num <= 500) emit({ fontSize: num });
  };

  const handleSizeBlur = () => {
    // Assert visual bounds correction only when they click away
    const clamped = Math.max(1, Math.min(500, Number(fontSize) || initialSize || 14));
    setFontSize(clamped);
    emit({ fontSize: clamped });
  };

  const handleSpacingChange = (val) => {
    setTitleSpacing(val);
    const num = Number(val);
    if (!isNaN(num) && val !== '' && val !== '-') emit({ titleSpacing: Math.max(-20, Math.min(40, num)) });
  };

  const handleSpacingBlur = () => {
    const clamped = Math.max(-20, Math.min(40, Number(titleSpacing) || 0));
    setTitleSpacing(clamped);
    emit({ titleSpacing: clamped });
  };

  const handleColorSwatch = (c) => {
    setTextColor(c);
    emit({ textColor: c });
  };

  const handleColorInput = (val) => {
    setTextColor(val);
    // Support CSS named colors alongside hex/rgba
    if (/^#[0-9a-fA-F]{3,8}$/.test(val) || /^rgba?\(/.test(val) || /^[a-zA-Z]+$/.test(val)) {
      emit({ textColor: val });
    }
  };

  const handleBgColorSwatch = (c) => {
    const finalColor = c === 'transparent' ? null : c;
    setBackgroundColor(finalColor);
    emit({ backgroundColor: finalColor });
  };

  const handleBgColorInput = (val) => {
    const finalColor = val === '' ? null : val;
    setBackgroundColor(finalColor);
    if (val === '' || /^#[0-9a-fA-F]{3,8}$/.test(val) || /^rgba?\(/.test(val) || /^[a-zA-Z]+$/.test(val)) {
      emit({ backgroundColor: finalColor });
    }
  };

  return (
    <Dialog title="Customize" onClose={onClose}>
      {hasFont && (
        <>
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

          <div className="flex justify-between items-center gap-2">
            <label className="text-white/70 text-sm w-16 shrink-0">Size</label>
            <input
              type="number"
              className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
              value={fontSize}
              onChange={(e) => handleSizeChange(e.target.value)}
              onBlur={handleSizeBlur}
              min={1}
              max={500}
            />
          </div>
        </>
      )}

      {showSpacing && (
        <div className="flex justify-between items-center gap-2">
          <label className="text-white/70 text-sm w-16 shrink-0">Gap</label>
          <input
            type="number"
            className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none"
            value={titleSpacing}
            onChange={(e) => handleSpacingChange(e.target.value)}
            onBlur={handleSpacingBlur}
            min={-20}
            max={40}
            title="Gap between title and circle edge (px)"
          />
        </div>
      )}

      {/* Text colour */}
      {hasFont && (
        <ColorSection
          label="Text Color"
          colors={TEXT_COLORS}
          value={textColor}
          onSwatchClick={handleColorSwatch}
          onInputChange={handleColorInput}
          onInputBlur={(val) => emit({ textColor: val })}
        />
      )}

      {/* Background colour */}
      <ColorSection
        label="Background Color"
        colors={BG_COLORS}
        value={backgroundColor}
        onSwatchClick={handleBgColorSwatch}
        onInputChange={handleBgColorInput}
        onInputBlur={(val) => emit({ backgroundColor: val === '' ? null : val })}
      />
    </Dialog>
  );
}
