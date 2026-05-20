import React, { useCallback, useState, useEffect, useContext, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { PriceJustification } from '../components/PriceJustification';
import { EditableField } from '../components/EditableField';
import { QuickPriceButtons } from '../components/QuickPriceButtons';
import { PlatformToggles } from '../components/PlatformToggles';
import { Camera, Loader2, ExternalLink, Copy, Check } from 'lucide-react';
import { NodeHandles } from './_shared/NodeHandles';
import { SELL_PLATFORMS } from '../utils/constants';
import { useListingActions } from '../hooks/useListingActions';
import { EventLogger } from '../utils/EventLogger';

const STATUS_STYLES = {
  draft: { border: 'border-dashed border-white/20', badge: 'bg-white/10 text-white/50', label: '📝 DRAFT' },
  confirming: { border: 'border-dashed border-amber-500/30', badge: 'bg-amber-500/20 text-amber-400', label: '⏳ ANALYZING' },
  priced: { border: 'border-solid border-emerald-500/30', badge: 'bg-emerald-500/20 text-emerald-400', label: '💰 READY' },
  live: { border: 'border-solid border-green-500/40', badge: 'bg-green-500/20 text-green-400', label: '✅ LISTED' },
};

/** Display names for price-research sources, used in progress status text. */
const SOURCE_NAMES = {
  'ebay-sold':    'eBay Sold',
  'poshmark':     'Poshmark',
  'swappa':       'Swappa',
  'ebay-active':  'eBay Active',
  'mercari':      'Mercari',
  'reverb':       'Reverb',
  'stockx':       'StockX',
};

/**
 * ListingNode — full lifecycle marketplace listing.
 *
 * data.status: 'draft' | 'confirming' | 'priced' | 'live'
 * data.product: { brand, model, category, condition, color, notable_features, generated_title, generated_description }
 * data.pricing: { recommended_price, quick_sell_price, max_profit_price, justification, market_summary }
 * data.comps: { sold: [], active: [] }
 * data.userPrice: number
 * data.selectedPlatforms: string[]
 * data.imagePaths: string[]
 * data.platformStatuses: { ebay: 'listed', facebook: 'draft', ... }
 */
/** Platforms requiring sell-monitor authentication before opening a listing URL. */
const NEEDS_AUTH = ['ebay', 'facebook', 'poshmark', 'mercari', 'swappa'];

export function ListingNode({ id, data }) {
  const status = data.status || 'draft';
  const style = STATUS_STYLES[status] || STATUS_STYLES.draft;

  const {
    product, editing, setEditing, priceInput, justificationExpanded,
    selectedPlatforms, copied, handleFieldEdit, handlePriceChange,
    handleQuickPrice, handleCopyListing, togglePlatform, toggleJustification,
    scrapePriceComps, synthesizePrice, syncPriceFromBackend,
  } = useListingActions(id, data);

  const [loginPrompt, setLoginPrompt] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [statusText, setStatusText] = useState('Researching prices...');
  const { updateNodeData } = useReactFlow();

  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  // Listen for granular pricing progress (Scanning eBay, etc.)
  useEffect(() => {
    if (!window.electronAPI?.onPriceSourceProgress || status !== 'confirming') return;

    const cleanup = window.electronAPI.onPriceSourceProgress(({ sourceId, status: pStatus, count }) => {
      const name = SOURCE_NAMES[sourceId] || sourceId;
      if (pStatus === 'searching') {
        setStatusText(`Scanning ${name}...`);
      } else if (pStatus === 'done' && count > 0) {
        setStatusText(`Found ${count} on ${name}`);
      }
    });

    return () => cleanup?.();
  }, [id, status]);

  useEffect(() => {
    syncPriceFromBackend(data.pricing);
  }, [data.pricing, syncPriceFromBackend]);

  const handleConfirmDraft = useCallback(async () => {
    // Two-stage flow: scrape comparable listings, then synthesize a price from
    // them. (useListingActions split the old single `researchPrice` call into
    // scrape + synthesize so SellHub can pause between them; ListingNode runs
    // them back-to-back since it has no resolve/skip decision UI.)
    updateGlobal(id, { status: 'confirming' });
    try {
      const scrapeResult = await scrapePriceComps();
      if (!isMountedRef.current) return;
      const comps = scrapeResult.comps || { sold: [], active: [] };

      const synthResult = await synthesizePrice(comps);
      if (!isMountedRef.current) return;
      const pricing = synthResult.pricing;

      if (pricing?.recommended_price != null) {
        updateGlobal(id, {
          status: 'priced',
          pricing,
          comps: synthResult.comps || comps,
          userPrice: pricing.recommended_price || '',
        });
      } else {
        // Synthesis ran but produced no usable price (typically no comps found).
        updateGlobal(id, {
          status: 'priced',
          pricing: pricing || { recommended_price: null, justification: 'No comparable listings found.' },
          comps: synthResult.comps || comps,
        });
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      EventLogger.error(`[ListingNode][${id}] Price research failed:`, err);
      updateGlobal(id, { status: 'draft' });
    }
  }, [id, updateGlobal, scrapePriceComps, synthesizePrice]);

  const handleListOnPlatforms = useCallback(async (e) => {
    e.stopPropagation();
    for (const platformId of selectedPlatforms) {
      if (NEEDS_AUTH.includes(platformId) && window.electronAPI?.checkSellMonitorAuth) {
        const authStatus = await window.electronAPI.checkSellMonitorAuth({ platformId });
        if (!isMountedRef.current) return;
        if (!authStatus.connected) {
          setLoginPrompt({
            platformId,
            name: authStatus.name || platformId,
            sellerUrl: authStatus.sellerUrl,
          });
          return;
        }
      }
      const platform = SELL_PLATFORMS.find(p => p.id === platformId);
      if (platform?.postUrl) window.electronAPI?.openExternal?.(platform.postUrl);
    }
  }, [selectedPlatforms]);



  return (
    <div className={`bg-[#1a1a1a] ${style.border} border rounded-lg shadow-lg overflow-hidden group`} style={{ width: 300 }}>
      <NodeHandles className="w-2 h-2" />

      {/* Status badge */}
      <div className={`px-3 py-1 text-[10px] font-semibold ${style.badge}`}>
        {style.label}
      </div>

      {/* Photo preview area */}
      {data.imagePaths?.length > 0 ? (
        <div className="h-32 bg-black/30 flex items-center justify-center overflow-hidden">
          <div className="text-white/20 text-xs flex items-center gap-1">
            <Camera size={14} />
            {data.imagePaths.length} photo{data.imagePaths.length !== 1 ? 's' : ''} attached
          </div>
        </div>
      ) : (
        <div className="h-20 bg-black/20 flex items-center justify-center">
          <div className="text-white/15 text-xs">No photos</div>
        </div>
      )}

      {/* Product details — editable inline */}
      <div className="px-3 py-2 space-y-1.5" onPointerDown={(e) => e.stopPropagation()}>
        {/* Title */}
        <EditableField variant="title" value={product.generated_title} placeholder="Click to set title"
          isEditing={editing === 'title'} onStartEdit={() => setEditing('title')}
          onSave={(v) => handleFieldEdit('generated_title', v)} disabled={!!data.locked} />

        {/* Brand */}
        <div className="flex gap-2 text-xs">
          <span className="text-white/30">Brand:</span>
          <EditableField value={product.brand} placeholder="Unknown"
            isEditing={editing === 'brand'} onStartEdit={() => setEditing('brand')}
            onSave={(v) => handleFieldEdit('brand', v)} disabled={!!data.locked} />
        </div>
        {/* Model */}
        <div className="flex gap-2 text-xs">
          <span className="text-white/30">Model:</span>
          <EditableField value={product.model} placeholder="Unknown"
            isEditing={editing === 'model'} onStartEdit={() => setEditing('model')}
            onSave={(v) => handleFieldEdit('model', v)} disabled={!!data.locked} />
        </div>

        {/* Condition + Category */}
        <div className="flex gap-2 text-xs">
          <span className="text-white/30">Condition:</span>
          <span className="text-white/60">{product.condition || 'Unknown'}</span>
        </div>

        {/* Description */}
        {product.generated_description && (
          <div className="text-white/40 text-xs leading-relaxed max-h-16 overflow-y-auto custom-scrollbar mt-1">
            {product.generated_description}
          </div>
        )}
      </div>

      {/* ── Draft state: Confirm button ─────────────────────────────────────── */}
      {status === 'draft' && (
        <div className="px-3 py-2 border-t border-white/5">
          <button
            onClick={data.locked ? undefined : (e) => { e.stopPropagation(); handleConfirmDraft(); }}
            disabled={!!data.locked}
            className={`w-full py-2 rounded-lg text-sm font-medium transition-colors ${
              data.locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Confirm & Research Price
          </button>
        </div>
      )}

      {/* ── Confirming state: Loading ───────────────────────────────────────── */}
      {status === 'confirming' && (
        <div className="px-3 py-3 border-t border-white/5 flex items-center justify-center gap-2 text-amber-400/80 text-sm">
          <Loader2 size={16} className="animate-spin" />
          {statusText}
        </div>
      )}

      {/* ── Priced state: Price + platforms ──────────────────────────────────── */}
      {status === 'priced' && (
        <div className="border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
          {/* Price recommendation */}
          <div className="px-3 py-2 space-y-2">
            {data.pricing?.recommended_price && (
              <div className="flex items-center justify-between">
                <span className="text-white/40 text-xs">Recommended:</span>
                <span className="text-emerald-400 text-sm font-semibold">${data.pricing.recommended_price}</span>
              </div>
            )}

            {/* User price input */}
            <div className="flex items-center gap-2">
              <span className="text-white/50 text-xs">Your Price:</span>
              <div className="flex-1 flex items-center gap-1">
                <span className="text-white/50 text-sm">$</span>
                <input
                  type="number"
                  value={priceInput}
                  onChange={data.locked ? undefined : (e) => handlePriceChange(e.target.value)}
                  disabled={!!data.locked}
                  className={`flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right ${data.locked ? 'opacity-50 cursor-default' : ''}`}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Quick price buttons */}
            <QuickPriceButtons pricing={data.pricing} onSelect={data.locked ? undefined : handleQuickPrice} disabled={!!data.locked} />
          </div>

          {/* Price Justification */}
          <PriceJustification
            pricing={data.pricing}
            comps={data.comps}
            expanded={justificationExpanded}
            onToggle={toggleJustification}
          />

          {/* Platform selection */}
          <div className="px-3 py-2 border-t border-white/5 space-y-1.5">
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">List on:</div>
            <PlatformToggles selected={selectedPlatforms} onToggle={data.locked ? undefined : togglePlatform} disabled={!!data.locked} />

            {/* Login required prompt */}
            {loginPrompt && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mt-1.5 space-y-1.5">
                <div className="text-amber-400 text-xs font-medium">
                  🔒 Login required for {loginPrompt.name}
                </div>
                <div className="text-white/40 text-[10px]">
                  Sell monitoring needs an active session. Log in once — cookies persist for future use.
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!window.electronAPI?.checkAndLogin) return;
                      setCheckingAuth(true);
                      try {
                        const result = await window.electronAPI.checkAndLogin({ platformId: loginPrompt.platformId });
                        if (!isMountedRef.current) return;
                        if (result.connected) {
                          setLoginPrompt(null);
                          // Re-trigger the listing flow now that we're logged in
                          window.electronAPI?.openExternal?.(loginPrompt.sellerUrl || SELL_PLATFORMS.find(p => p.id === loginPrompt.platformId)?.url);
                        } else {
                          // User closed login window without logging in — keep prompt
                        }
                      } catch (err) {
                        EventLogger.error('Login check failed:', err);
                      } finally {
                        if (isMountedRef.current) {
                          setCheckingAuth(false);
                        }
                      }
                    }}
                    disabled={checkingAuth}
                    className="flex-1 py-1 rounded text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {checkingAuth ? '⏳ Waiting...' : '🔑 Log In'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setLoginPrompt(null); }}
                    className="px-2 py-1 rounded text-xs text-white/30 hover:text-white/50 transition-colors"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {/* Copy listing + List on Platforms */}
            <div className="flex gap-1.5 mt-2">
              <button
                onClick={data.locked ? undefined : (e) => { e.stopPropagation(); handleCopyListing(); }}
                disabled={!!data.locked}
                className={`flex-1 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1 transition-colors ${
                  data.locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'
                }`}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Listing'}
              </button>
              <button
                onClick={data.locked ? undefined : handleListOnPlatforms}
                disabled={!!data.locked}
                className={`flex-1 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1 transition-colors ${
                  data.locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'
                }`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} />
                List on Platforms
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
