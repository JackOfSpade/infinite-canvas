import React, { useState, useRef, useEffect } from 'react';
import { QuickPriceButtons } from '../../components/QuickPriceButtons';
import { PriceJustification } from '../../components/PriceJustification';
import { PlatformToggles } from '../../components/PlatformToggles';
import { Check, Copy, Download, Camera, RefreshCw, ChevronDown, ChevronUp, Edit3 } from 'lucide-react';
import { SELL_PLATFORMS } from '../../utils/constants';
import { EventLogger } from '../../utils/EventLogger';
import { useToast } from '../../components/ToastProvider';

/** Converts a local filesystem path to the custom local-file:// protocol URL. */
function toLocalFileUrl(filePath) {
  return `local-file://${filePath.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export function SellHubPricedState({
  product,
  pricing,
  comps,
  priceInput,
  handlePriceChange,
  handleQuickPrice,
  justificationExpanded,
  toggleJustification,
  selectedPlatforms,
  togglePlatform,
  copied,
  handleCopyListing,
  listingText = '',
  locked = false,
  // New props
  imagePaths = [],
  platformStatuses = {},
  onMarkListed,
  onReresearch,
}) {
  const [savingListing, setSavingListing] = useState(false);
  const [savedListing, setSavedListing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Local editable copy of listing text — user can customize before copy/save
  const [editedText, setEditedText] = useState(listingText);
  const textFocusRef = useRef(false);
  const { addToast } = useToast();
  const isMountedRef = useRef(true);
  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  // Sync when listingText changes externally (e.g. price/product edits) but only if
  // the user isn’t actively editing — same pattern as JobCardNode notes.
  useEffect(() => {
    if (!textFocusRef.current) {
      setEditedText(listingText);
    }
  }, [listingText]);

  const handleSaveListing = async () => {
    if (!window.electronAPI?.saveFileDialog || savingListing) return;
    setSavingListing(true);
    try {
      const safe = (product.generated_title || 'listing').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
      const result = await window.electronAPI.saveFileDialog({
        defaultFilename: `${safe}.txt`,
        content: editedText,       // use locally edited text
        filters: [{ name: 'Text Files', extensions: ['txt'] }],
      });
      if (!isMountedRef.current) return;
      if (result?.saved) {
        setSavedListing(true);
        setTimeout(() => { if (isMountedRef.current) setSavedListing(false); }, 2000);
        addToast({ title: 'Listing Saved', description: result.filePath, type: 'success' });
      } else if (result?.success === false) {
        // atomicWriteFile failed after the dialog was accepted (e.g. disk full, permissions)
        EventLogger.error('[SellHub] Save dialog write failed:', result.error);
        addToast({ title: 'Save Failed', description: result.error || 'Could not write file', type: 'error' });
      }
      // result.saved === false without success===false means user canceled — no feedback needed
    } catch (e) {
      if (!isMountedRef.current) return;
      EventLogger.error('[SellHub] Save listing failed:', e);
      addToast({ title: 'Save Failed', description: e?.message || String(e), type: 'error' });
    } finally {
      if (isMountedRef.current) setSavingListing(false);
    }
  };

  return (
    <div className="p-3 space-y-2">
      <div className="text-emerald-400/60 text-[10px] font-semibold uppercase tracking-wider">💰 Ready to List</div>

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
        <div className="h-6 flex items-center gap-1 text-white/15 text-[10px]">
          <Camera size={10} />
          No photos
        </div>
      )}

      <div className="text-white/80 text-sm font-semibold truncate">{product.generated_title || 'Item'}</div>

      {/* Price */}
      {pricing?.recommended_price && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/30">Recommended:</span>
          <span className="text-emerald-400 font-semibold">${pricing.recommended_price}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-white/40 text-xs">Your Price:</span>
        <div className="flex-1 flex items-center gap-1">
          <span className="text-white/40 text-sm">$</span>
          <input
            type="number"
            value={priceInput}
            onChange={locked ? undefined : (e) => handlePriceChange(e.target.value)}
            disabled={locked}
            className={`flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right ${locked ? 'opacity-50 cursor-default' : ''}`}
            placeholder="0"
          />
        </div>
      </div>

      {/* Quick price buttons */}
      <QuickPriceButtons pricing={pricing} onSelect={locked ? undefined : handleQuickPrice} disabled={locked} />

      {/* Price justification */}
      <PriceJustification
        pricing={pricing}
        comps={comps}
        expanded={justificationExpanded}
        onToggle={toggleJustification}
      />

      {/* Platform selection */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider mb-1">
          Click source icon to post →
        </div>
        <PlatformToggles selected={selectedPlatforms} onToggle={locked ? undefined : togglePlatform} disabled={locked} />
      </div>

      {/* Per-platform mark-as-listed */}
      {selectedPlatforms.length > 0 && (
        <div className="pt-1 border-t border-white/5 space-y-1">
          <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider">Mark as listed:</div>
          <div className="flex flex-wrap gap-1">
            {selectedPlatforms.map(pid => {
              const platform = SELL_PLATFORMS.find(p => p.id === pid);
              if (!platform) return null;
              const isListed = platformStatuses[pid] === 'listed';
              return (
                <button
                  key={pid}
                  onClick={locked ? undefined : () => onMarkListed?.(pid)}
                  disabled={locked}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={isListed ? `${platform.name}: Listed ✓` : `Mark ${platform.name} as listed`}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] transition-colors ${
                    isListed
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'
                      : locked
                        ? 'bg-white/5 text-white/20 cursor-default'
                        : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                  }`}
                >
                  {isListed && <Check size={8} />}
                  {platform.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Refresh prices */}
      {!locked && onReresearch && (
        <button
          onClick={onReresearch}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag w-full py-1 rounded text-[10px] font-medium flex items-center justify-center gap-1 bg-white/5 text-white/30 hover:bg-amber-500/10 hover:text-amber-400/70 transition-colors border border-white/5"
          title="Discard current pricing and re-research live comparables"
        >
          <RefreshCw size={9} />
          Refresh Prices
        </button>
      )}

      {/* Copy + Save listing */}
      <div className="flex gap-1.5 pt-1">
        <button
          onClick={locked ? undefined : () => handleCopyListing(editedText)}
          disabled={locked}
          className={`flex-1 py-1.5 rounded text-[10px] font-medium flex items-center justify-center gap-1 transition-colors ${
            locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? 'Copied!' : 'Copy Listing'}
        </button>
        <button
          onClick={locked ? undefined : handleSaveListing}
          disabled={locked || savingListing}
          className={`flex-1 py-1.5 rounded text-[10px] font-medium flex items-center justify-center gap-1 transition-colors ${
            savedListing
              ? 'bg-emerald-500/15 text-emerald-400'
              : locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10 disabled:opacity-50'
          }`}
          title="Save listing text to a file"
        >
          {savedListing ? <Check size={10} /> : <Download size={10} />}
          {savingListing ? 'Saving…' : savedListing ? 'Saved!' : 'Save to File'}
        </button>
      </div>

      {/* Preview & Edit Listing */}
      <div className="border border-white/5 rounded overflow-hidden">
        <button
          onClick={() => setPreviewOpen(o => !o)}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag w-full flex items-center justify-between px-2.5 py-1.5 text-[10px] text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors"
        >
          <span className="flex items-center gap-1">
            <Edit3 size={9} />
            Preview & Edit Listing
          </span>
          {previewOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
        {previewOpen && (
          <textarea
            value={editedText}
            onChange={locked ? undefined : (e) => setEditedText(e.target.value)}
            onFocus={() => { textFocusRef.current = true; }}
            onBlur={() => { textFocusRef.current = false; }}
            readOnly={locked}
            rows={8}
            className={`nodrag w-full resize-none bg-black/30 border-t border-white/5 px-2.5 py-2 text-white/60 text-[10px] leading-relaxed outline-none font-mono ${
              locked ? 'cursor-default opacity-60' : 'focus:bg-black/40'
            }`}
            placeholder="Your listing text will appear here…"
          />
        )}
      </div>
    </div>
  );
}
