import React from 'react';
import { EditableField } from '../../components/EditableField';
import { Camera } from 'lucide-react';

/** Converts a local filesystem path to the custom local-file:// protocol URL. */
function toLocalFileUrl(filePath) {
  return `local-file://${filePath.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

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

      {/* Photo strip */}
      {imagePaths.length > 0 ? (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {imagePaths.slice(0, 4).map((p, i) => (
            <img
              key={i}
              src={toLocalFileUrl(p)}
              alt={`Product photo ${i + 1}`}
              className="h-16 w-16 object-cover rounded shrink-0 border border-white/10"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ))}
          {imagePaths.length > 4 && (
            <div className="h-16 w-16 rounded border border-white/10 bg-black/20 flex items-center justify-center shrink-0 text-white/30 text-[10px]">
              +{imagePaths.length - 4}
            </div>
          )}
        </div>
      ) : (
        <div className="h-10 flex items-center gap-1 text-white/15 text-xs">
          <Camera size={12} />
          No photos
        </div>
      )}

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
        Confirm & Research Price
      </button>
    </div>
  );
}
