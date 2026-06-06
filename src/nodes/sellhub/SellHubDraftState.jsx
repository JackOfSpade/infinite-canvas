import React from 'react';
import { Plus, X } from 'lucide-react';
import { EditableField } from '../../components/EditableField';
import { PhotoStrip } from '../../components/PhotoStrip';
import { useSyncWhileFocused } from '../../hooks/useSyncWhileFocused';

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
  pricingNotes = '',
  onPricingNotesChange,
  // Additional independent items packaged into this one listing (kayak + paddle).
  extraItems = [],
  onAddExtraItem,
  onEditExtraItem,
  onRemoveExtraItem,
  locked = false,
  imagePaths = [],
}) {
  const itemCount = 1 + extraItems.filter(it => (it.query || '').trim()).length;
  const {
    value: draftPricingNotes,
    setValue: setDraftPricingNotes,
    focusProps: pricingNotesFocusProps,
  } = useSyncWhileFocused(pricingNotes);

  const handlePricingNotesInput = (e) => {
    const nextValue = e.target.value;
    setDraftPricingNotes(nextValue);
    onPricingNotesChange?.(nextValue);
  };

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

      <div className="space-y-1">
        <label className="block text-white/30 text-[10px]">Pricing notes</label>
        <textarea
          value={draftPricingNotes}
          data-native-undo="true"
          onChange={handlePricingNotesInput}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onFocus={pricingNotesFocusProps.onFocus}
          onBlur={pricingNotesFocusProps.onBlur}
          disabled={locked}
          rows={3}
          placeholder="Size, flaws, included accessories, urgency, original cost..."
          className="nodrag nowheel w-full resize-none rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-white/80 placeholder:text-white/25 text-[10px] leading-snug outline-none focus:border-blue-400/50 disabled:opacity-50 disabled:cursor-default"
        />
      </div>

      {/* Additional independent items packaged into this one listing (e.g. a
          kayak + its paddle). Each runs its own complete pricing pass and the
          hub sums them into a suggested bundle total. */}
      <div className="space-y-1 pt-1 border-t border-white/5">
        <div className="flex items-center justify-between">
          <label className="text-white/30 text-[10px]">Also in this listing</label>
          {extraItems.length > 0 && (
            <span className="text-white/25 text-[9px]">{extraItems.length} extra item{extraItems.length === 1 ? '' : 's'}</span>
          )}
        </div>
        {extraItems.map((item) => (
          <div key={item.id} className="flex items-center gap-1">
            <input
              type="text"
              data-native-undo="true"
              value={item.query || ''}
              onChange={(e) => onEditExtraItem?.(item.id, { query: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="e.g. Bending Branches kayak paddle"
              disabled={locked}
              className="nodrag flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2 py-1 text-white/80 placeholder:text-white/25 text-[10px] outline-none focus:border-blue-400/50 disabled:opacity-50"
            />
            <select
              value={CONDITION_OPTIONS.includes(item.condition) ? item.condition : 'Used - Good'}
              onChange={(e) => onEditExtraItem?.(item.id, { condition: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={locked}
              title="Condition for this item"
              className="nodrag shrink-0 bg-white/5 border border-white/10 rounded px-1 py-1 text-white/70 text-[9px] focus:outline-none focus:border-blue-400/50 disabled:opacity-50"
            >
              {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              onClick={() => onRemoveExtraItem?.(item.id)}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={locked}
              title="Remove this item"
              className="nodrag shrink-0 p-1 rounded text-white/30 hover:text-red-300 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-default"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        {!locked && (
          <button
            onClick={onAddExtraItem}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex items-center gap-1 text-blue-400/70 hover:text-blue-300 text-[10px] font-medium transition-colors"
          >
            <Plus size={10} /> Add item
          </button>
        )}
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
        {itemCount > 1 ? `Confirm & Research ${itemCount} Items` : 'Confirm & Research Price'}
      </button>
    </div>
  );
}
