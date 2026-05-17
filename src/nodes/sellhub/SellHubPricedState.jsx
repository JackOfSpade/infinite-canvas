import React, { useState, useRef, useEffect } from 'react';
import { QuickPriceButtons } from '../../components/QuickPriceButtons';
import { PriceJustification } from '../../components/PriceJustification';
import { PhotoStrip } from '../../components/PhotoStrip';
import { Check, Copy, Download, RefreshCw, ChevronDown, ChevronUp, Edit3, Plus, Activity } from 'lucide-react';
import { SELL_PLATFORMS } from '../../utils/constants';
import { EventLogger } from '../../utils/EventLogger';
import { useToast } from '../../components/ToastProvider';
import { useSyncWhileFocused } from '../../hooks/useSyncWhileFocused';

export function SellHubPricedState({
  product,
  pricing,
  comps,
  priceInput,
  handlePriceChange,
  handleQuickPrice,
  justificationExpanded,
  toggleJustification,
  copied,
  handleCopyListing,
  listingText = '',
  locked = false,
  imagePaths = [],
  onReresearch,
  // Phase-2 redesign: marketplace cards replace the platform-toggles UX.
  spawnedMarketplaceIds = [], // ids already represented by a connected MarketplaceCardNode
  onSpawnMarketplaceCard,     // (platformId) => spawn a card next to the hub
  onCheckAllStatuses,         // () => trigger checkStatus on every connected card
  checkingAll = false,
}) {
  const [savingListing, setSavingListing] = useState(false);
  const [savedListing, setSavedListing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { value: editedText, setValue: setEditedText, focusProps: textFocusProps } = useSyncWhileFocused(listingText);
  const { addToast } = useToast();
  const isMountedRef = useRef(true);
  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

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

      <PhotoStrip imagePaths={imagePaths} size="sm" />

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
            onPointerDown={(e) => e.stopPropagation()}
            className={`nodrag flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right ${locked ? 'opacity-50 cursor-default' : ''}`}
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

      {/* Marketplace cards — spawn one per platform you list on.
          Each card persists on the canvas, holds its own listing URL, and can
          be status-checked independently. Replaces the old auto-post toggles. */}
      <div className="pt-1 border-t border-white/5 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider">
            Marketplaces
          </div>
          {spawnedMarketplaceIds.length > 0 && !locked && (
            <button
              onClick={onCheckAllStatuses}
              disabled={checkingAll}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-[9px] font-medium border border-blue-500/20 transition-colors disabled:opacity-50"
              title="Ask AI to check the current status of every connected marketplace listing"
            >
              <Activity size={9} className={checkingAll ? 'animate-pulse' : ''} />
              {checkingAll ? 'Checking…' : 'Check All'}
            </button>
          )}
        </div>
        <div className="text-white/30 text-[9px] leading-snug">
          Spawn a card for each marketplace you list on. Each card holds a listing URL you paste after posting manually.
        </div>
        <div className="flex flex-wrap gap-1">
          {SELL_PLATFORMS.map(p => {
            const spawned = spawnedMarketplaceIds.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={locked || spawned ? undefined : () => onSpawnMarketplaceCard?.(p.id)}
                disabled={locked || spawned}
                onPointerDown={(e) => e.stopPropagation()}
                title={spawned ? `${p.name} card already on canvas` : `Add ${p.name} marketplace card`}
                className={`nodrag flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors border ${
                  spawned
                    ? 'bg-emerald-500/10 text-emerald-400/70 border-emerald-500/20 cursor-default'
                    : locked
                      ? 'bg-white/5 text-white/20 border-white/5 cursor-default'
                      : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10 hover:text-white/90'
                }`}
                style={spawned ? undefined : { borderLeftColor: p.color, borderLeftWidth: 2 }}
              >
                {spawned ? <Check size={8} /> : <Plus size={8} />}
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

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
            {...textFocusProps}
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
