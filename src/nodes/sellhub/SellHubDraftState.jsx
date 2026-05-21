import React from 'react';
import { EditableField } from '../../components/EditableField';
import { PhotoStrip } from '../../components/PhotoStrip';

// Mirrors the enum the AI is prompted to pick from in marketplace.js so the
// dropdown options match what's already living in `product.condition`.
const CONDITION_OPTIONS = [
  'New',
  'Like New',
  'Used - Excellent',
  'Used - Good',
  'Used - Fair',
  'For Parts',
];

export function SellHubDraftState({
  product,
  editing,
  setEditing,
  handleFieldEdit,
  handleConfirmDraft,
  locked = false,
  imagePaths = [],
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="text-amber-400/60 text-[10px] font-semibold uppercase tracking-wider">📝 Draft</div>

      <PhotoStrip imagePaths={imagePaths} />


      <EditableField
        variant="title"
        value={product.generated_title}
        placeholder="Click to set title"
        isEditing={editing === 'title'}
        onStartEdit={() => setEditing('title')}
        onSave={(v) => handleFieldEdit('generated_title', v)}
        disabled={locked}
      />

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-white/30">Brand: </span>
          <EditableField
            value={product.brand}
            isEditing={editing === 'brand'}
            onStartEdit={() => setEditing('brand')}
            onSave={(v) => handleFieldEdit('brand', v)}
            disabled={locked}
          />
        </div>
        <div>
          <span className="text-white/30">Model: </span>
          <EditableField
            value={product.model}
            isEditing={editing === 'model'}
            onStartEdit={() => setEditing('model')}
            onSave={(v) => handleFieldEdit('model', v)}
            disabled={locked}
          />
        </div>
      </div>

      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-white/30">Condition:</span>
        <select
          value={CONDITION_OPTIONS.includes(product.condition) ? product.condition : ''}
          onChange={(e) => handleFieldEdit('condition', e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={locked}
          className="nodrag bg-white/5 border border-white/10 rounded px-1 py-0.5 text-white/70 text-[10px] focus:outline-none focus:border-blue-400/50 disabled:opacity-50 disabled:cursor-default"
        >
          {!CONDITION_OPTIONS.includes(product.condition) && (
            <option value="" disabled>{product.condition || 'Unknown'}</option>
          )}
          {CONDITION_OPTIONS.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <button
        onClick={locked ? undefined : handleConfirmDraft}
        disabled={locked}
        className={`w-full py-2 rounded-lg text-xs font-medium transition-colors mt-1 ${
          locked
            ? 'bg-white/5 text-white/20 cursor-default'
            : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
        }`}
      >
        Confirm & Research Price
      </button>
    </div>
  );
}
