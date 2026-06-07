import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { EditableField } from '../../components/EditableField';
import { PhotoStrip } from '../../components/PhotoStrip';
import { buildItemQuery } from '../../utils/bundlePricing';
import { EventLogger } from '../../utils/EventLogger';
import { syncUncontrolledTextValue } from '../../utils/uncontrolledTextValue';

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

function selectionLabel(element) {
  const start = Number.isInteger(element?.selectionStart) ? element.selectionStart : '?';
  const end = Number.isInteger(element?.selectionEnd) ? element.selectionEnd : '?';
  return `${start}-${end}`;
}

/**
 * Keep the browser in charge of the live textarea value. The notes still write
 * through to React Flow on every input, but parent renders never program the
 * active field's value, preserving middle-of-text caret position and the
 * browser's native undo/redo stack.
 */
function PricingNotesTextarea({ value, onChange, locked, diagnosticId }) {
  const [initialValue] = useState(() => String(value ?? ''));
  const inputRef = useRef(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (syncUncontrolledTextValue(inputRef.current, value, focusedRef.current)) {
      EventLogger.log(`[TextEdit] external-sync field=${diagnosticId} len=${inputRef.current?.value.length || 0}`);
    }
  }, [diagnosticId, value]);

  const handleFocus = (e) => {
    focusedRef.current = true;
    EventLogger.log(`[TextEdit] focus field=${diagnosticId} len=${e.currentTarget.value.length} selection=${selectionLabel(e.currentTarget)}`);
  };

  const handleBlur = (e) => {
    focusedRef.current = false;
    onChange?.(e.currentTarget.value);
    EventLogger.log(`[TextEdit] blur field=${diagnosticId} len=${e.currentTarget.value.length} selection=${selectionLabel(e.currentTarget)}`);
  };

  const handleInput = (e) => {
    const element = e.currentTarget;
    const inputType = e.nativeEvent?.inputType || 'unknown';
    onChange?.(element.value);

    const selectionEnd = Number.isInteger(element.selectionEnd) ? element.selectionEnd : element.value.length;
    if (selectionEnd < element.value.length || /^history(?:Undo|Redo)$/i.test(inputType)) {
      EventLogger.log(
        `[TextEdit] input field=${diagnosticId} type=${inputType} len=${element.value.length} selection=${selectionLabel(element)}`,
      );
    }
  };

  return (
    <textarea
      ref={inputRef}
      defaultValue={initialValue}
      data-native-undo="true"
      onInput={handleInput}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      disabled={locked}
      rows={3}
      placeholder="Size, flaws, included accessories, urgency, original cost..."
      className="nodrag nowheel w-full resize-none rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-white/80 placeholder:text-white/25 text-[10px] leading-snug outline-none focus:border-blue-400/50 disabled:opacity-50 disabled:cursor-default"
    />
  );
}

/**
 * One additional bundle item — a FULL duplicate of the primary item's editable
 * form (title / brand / model / condition / pricing notes), since each extra runs
 * its own complete pricing pass. The user has no photos for these, so they fill
 * the same fields the AI would have populated. Manages its own click-to-edit
 * state (which field is open) so multiple item cards don't fight over one.
 */
function ExtraItemEditor({ item, index, onEdit, onRemove, locked, hubId }) {
  const [editing, setEditing] = useState(null); // 'title' | 'brand' | 'model' | null
  const save = (field) => (v) => { onEdit?.(item.id, { [field]: v }); setEditing(null); };

  return (
    <div className="space-y-2 rounded-md border border-white/10 bg-white/[0.02] p-2">
      <div className="flex items-start justify-between gap-1">
        <span className="text-white/25 text-[9px] font-semibold uppercase tracking-wider mt-1">Item {index + 2}</span>
        <button
          onClick={() => onRemove?.(item.id)}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={locked}
          title="Remove this item"
          className="nodrag shrink-0 p-1 rounded text-white/30 hover:text-red-300 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-default"
        >
          <X size={11} />
        </button>
      </div>

      <EditableField
        variant="title"
        value={item.generated_title}
        placeholder="Click to set title"
        isEditing={editing === 'title'}
        onStartEdit={() => setEditing('title')}
        onSave={save('generated_title')}
        disabled={locked}
      />

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-white/30">Brand: </span>
          <EditableField
            value={item.brand}
            isEditing={editing === 'brand'}
            onStartEdit={() => setEditing('brand')}
            onSave={save('brand')}
            disabled={locked}
          />
        </div>
        <div>
          <span className="text-white/30">Model: </span>
          <EditableField
            value={item.model}
            isEditing={editing === 'model'}
            onStartEdit={() => setEditing('model')}
            onSave={save('model')}
            disabled={locked}
          />
        </div>
      </div>

      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-white/30">Condition:</span>
        <select
          value={CONDITION_OPTIONS.includes(item.condition) ? item.condition : 'Used - Good'}
          onChange={(e) => onEdit?.(item.id, { condition: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={locked}
          className="nodrag bg-white/5 border border-white/10 rounded px-1 py-0.5 text-white/70 text-[10px] focus:outline-none focus:border-blue-400/50 disabled:opacity-50 disabled:cursor-default"
        >
          {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <label className="block text-white/30 text-[10px]">Pricing notes</label>
        <PricingNotesTextarea
          value={item.pricingNotes || ''}
          onChange={(nextValue) => onEdit?.(item.id, { pricingNotes: nextValue })}
          locked={locked}
          diagnosticId={`${hubId}:extra:${item.id}`}
        />
      </div>
    </div>
  );
}

export function SellHubDraftState({
  hubId,
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
  const itemCount = 1 + extraItems.filter(it => buildItemQuery(it)).length;

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
        <PricingNotesTextarea
          value={pricingNotes}
          onChange={onPricingNotesChange}
          locked={locked}
          diagnosticId={`${hubId}:primary`}
        />
      </div>

      {/* Additional independent items packaged into this one listing (e.g. a
          kayak + its paddle). Each is a FULL duplicate of the primary item's
          editable form and runs its own complete pricing pass; the AI then
          combines them into a single synergy-aware bundle price. */}
      <div className="space-y-2 pt-1 border-t border-white/5">
        <div className="flex items-center justify-between">
          <label className="text-white/30 text-[10px]">Also in this listing</label>
          {extraItems.length > 0 && (
            <span className="text-white/25 text-[9px]">{extraItems.length} extra item{extraItems.length === 1 ? '' : 's'}</span>
          )}
        </div>
        {extraItems.map((item, i) => (
          <ExtraItemEditor
            key={item.id}
            item={item}
            index={i}
            onEdit={onEditExtraItem}
            onRemove={onRemoveExtraItem}
            locked={locked}
            hubId={hubId}
          />
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
