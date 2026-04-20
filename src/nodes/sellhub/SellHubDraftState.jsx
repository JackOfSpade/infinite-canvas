import React from 'react';
import { EditableField } from '../../components/EditableField';

export function SellHubDraftState({
  product,
  editing,
  setEditing,
  handleFieldEdit,
  handleConfirmDraft,
  locked = false,
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="text-amber-400/60 text-[10px] font-semibold uppercase tracking-wider">📝 Draft</div>

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

      <div className="text-white/30 text-[10px]">Condition: {product.condition || 'Unknown'}</div>

      {product.generated_description && (
        <div className="text-white/35 text-[10px] leading-relaxed max-h-12 overflow-hidden">
          {product.generated_description}
        </div>
      )}

      <button 
        onClick={locked ? undefined : handleConfirmDraft}
        disabled={locked}
        className={`w-full py-2 rounded-lg text-xs font-medium transition-colors mt-1 ${
          locked
            ? 'bg-white/5 text-white/20 cursor-default'
            : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
        }`}
      >
        Confirm &amp; Research Price
      </button>
    </div>
  );
}
