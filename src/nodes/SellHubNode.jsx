import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AnimatedSourceRing } from '../components/AnimatedSourceRing';
import { HubContainer } from '../components/HubContainer';
import { EditableField } from '../components/EditableField';
import { QuickPriceButtons } from '../components/QuickPriceButtons';
import { PlatformToggles } from '../components/PlatformToggles';
import { Camera, Loader2, Check, Copy } from 'lucide-react';
import { PriceJustification } from '../components/PriceJustification';
import { SELL_PLATFORMS, PRICE_COMP_SOURCES } from '../utils/constants';
import { useListingActions } from '../hooks/useListingActions';
import { useToast } from '../components/ToastProvider';

/**
 * SellHubNode — draggable canvas module for marketplace selling.
 * Phase 2: Dual ring — comp source icons during research, platform icons when priced.
 * Per-source progress tracking for price research.
 *
 * data.hubState: 'empty' | 'analyzing' | 'draft' | 'researching' | 'priced' | 'error'
 * data.imagePaths: string[]
 * data.product: { brand, model, generated_title, generated_description, condition, category }
 * data.pricing: { recommended_price, quick_sell_price, max_profit_price, justification, market_summary }
 * data.comps: { sold: [], active: [] }
 * data.userPrice: number
 * data.selectedPlatforms: string[]
 */
export function SellHubNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const { addToast } = useToast();
  const processingRef = useRef(false);

  const {
    product, editing, setEditing, priceInput, justificationExpanded,
    selectedPlatforms, copied, handleFieldEdit, handlePriceChange,
    handleQuickPrice, handleCopyListing, togglePlatform, toggleJustification,
    researchPrice,
  } = useListingActions(id, data);

  // Per-source comp progress: { 'ebay-sold': { status, count }, 'amazon': { status, count }, ... }
  const [compProgress, setCompProgress] = useState({});
  // Track which posting platforms have been "opened" (animated outward arrow)
  const [postingPlatforms, setPostingPlatforms] = useState({});

  const hubState = data.hubState || 'empty';

  // Automatically start analysis if images were dropped
  useEffect(() => {
    if (data.imagePaths?.length > 0 && hubState === 'empty' && !processingRef.current) {
      startAnalysis(data.imagePaths);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for per-source price research progress events
  useEffect(() => {
    if (!window.electronAPI?.onPriceSourceProgress) return;
    const cleanup = window.electronAPI.onPriceSourceProgress(({ sourceId, status, count }) => {
      setCompProgress(prev => ({ ...prev, [sourceId]: { status, count } }));
    });
    return () => cleanup?.();
  }, []);

  // ── Ring sources: comp sources during research, platform icons when priced ──
  const getSourceStatuses = useCallback(() => {
    // During price research, show comp source icons
    if (hubState === 'researching') {
      return PRICE_COMP_SOURCES.map(s => {
        const progress = compProgress[s.id];
        if (!progress || progress.status === 'searching') {
          return { ...s, status: 'active', statusText: 'Scanning...', hoverText: `Searching ${s.name} for comparable listings` };
        }
        if (progress.status === 'done') {
          return { ...s, status: 'done', statusText: `${progress.count} found`, hoverText: `Found ${progress.count} comparable listings on ${s.name}` };
        }
        if (progress.status === 'error') {
          return { ...s, status: 'error', statusText: 'Blocked', hoverText: `${s.name} returned no results (may be blocked by anti-bot)` };
        }
        return { ...s, status: 'active', statusText: 'Waiting...', hoverText: `Queued for ${s.name}` };
      });
    }

    // When priced, show sell platform icons
    if (hubState === 'priced') {
      const soldCount = data.comps?.sold?.length || 0;
      const activeCount = data.comps?.active?.length || 0;

      return SELL_PLATFORMS.map(p => {
        const openPlatform = () => {
          if (window.electronAPI?.openExternal) {
            // Animate outward arrow briefly
            setPostingPlatforms(prev => ({ ...prev, [p.id]: 'active' }));
            setTimeout(() => setPostingPlatforms(prev => ({ ...prev, [p.id]: 'done' })), 2000);
            window.electronAPI.openExternal(p.postUrl);
          }
        };

        if (!selectedPlatforms.includes(p.id)) {
          return { ...p, status: 'idle', onClick: openPlatform };
        }

        const postState = postingPlatforms[p.id];
        if (postState === 'active') {
          return { ...p, status: 'active', onClick: openPlatform, statusText: 'Opening...', hoverText: `Opening ${p.name} to create listing` };
        }
        if (postState === 'done') {
          return { ...p, status: 'done', onClick: openPlatform, statusText: 'Opened ✓', hoverText: `Click to open ${p.name} again` };
        }

        const compText = soldCount + activeCount > 0 ? `${soldCount + activeCount} comps` : 'Ready to list';
        return {
          ...p, status: 'done', onClick: openPlatform,
          statusText: compText,
          hoverText: `Click to open ${p.name} and create your listing`,
        };
      });
    }

    // Default: all idle
    return SELL_PLATFORMS.map(p => ({
      ...p, status: 'idle',
      onClick: () => window.electronAPI?.openExternal?.(p.postUrl),
    }));
  }, [hubState, selectedPlatforms, data.comps, compProgress, postingPlatforms]);

  const startAnalysis = async (imagePaths) => {
    if (!window.electronAPI || processingRef.current) return;
    processingRef.current = true;

    try {
      updateNodeData(id, { hubState: 'analyzing' });
      const result = await window.electronAPI.analyzePhotos({ imagePaths });
      if (!result.success) throw new Error(result.error);
      updateNodeData(id, {
        hubState: 'draft',
        product: result.product,
        imagePaths,
      });
    } catch (error) {
      console.error('[SellHub] Analysis failed:', error);
      updateNodeData(id, { hubState: 'error', errorMessage: error.message });
    } finally {
      processingRef.current = false;
    }
  };

  const handleConfirmDraft = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setCompProgress({});

    try {
      updateNodeData(id, { hubState: 'researching' });
      const result = await researchPrice((state, res) => {
        if (state === 'priced') {
          updateNodeData(id, {
            hubState: 'priced',
            pricing: res.pricing,
            comps: res.comps,
            userPrice: res.pricing.recommended_price || '',
          });
          addToast({ title: 'Pricing Engine', description: `Recommended price: $${res.pricing.recommended_price}`, type: 'success' });
        } else if (state === 'priced-empty') {
          updateNodeData(id, {
            hubState: 'priced',
            pricing: { recommended_price: null, justification: res.error },
          });
          addToast({ title: 'Pricing Failed', description: res.error || 'Could not determine a price.', type: 'error' });
        }
      });
      if (!result) {
        updateNodeData(id, { hubState: 'draft' });
      }
    } catch (err) {
      console.error('[SellHub] Price research failed:', err);
      updateNodeData(id, { hubState: 'draft' });
      addToast({ title: 'Pricing Error', description: err.message, type: 'error' });
    } finally {
      processingRef.current = false;
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files || []);
    const images = files.filter(f => f.name.match(/\.(png|jpg|jpeg|webp|gif)$/i));
    if (images.length > 0) startAnalysis(images.map(f => f.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeWidth = 280;
  const nodeHeight = hubState === 'empty' ? 140 : hubState === 'draft' || hubState === 'priced' ? 320 : 120;

  // Running total from comp progress
  const totalComps = Object.values(compProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  return (
    <HubContainer
      hubState={hubState}
      theme="amber"
      width={nodeWidth}
      height={undefined}
      minHeight={nodeHeight}
      onDrop={handleDrop}
      interactiveStates={['draft', 'priced']}
      extras={
        <AnimatedSourceRing
          sources={getSourceStatuses()}
          direction={hubState === 'researching' ? 'in' : 'out'}
          nodeWidth={nodeWidth}
          nodeHeight={nodeHeight}
          radius={hubState === 'priced' ? 170 : 140}
        />
      }
    >
        {/* ── Empty: drop zone ───────────────────────────────────────────── */}
        {hubState === 'empty' && (
          <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
            <Camera size={28} className="text-emerald-400/40 mb-3" />
            <p className="text-white/40 text-sm font-medium">Drop product photos</p>
            <p className="text-white/20 text-[10px] mt-1">AI identifies & prices</p>
          </div>
        )}

        {/* ── Analyzing ──────────────────────────────────────────────────── */}
        {hubState === 'analyzing' && (
          <div className="flex flex-col items-center justify-center py-6 px-4">
            <Loader2 size={22} className="animate-spin text-amber-400 mb-2" />
            <p className="text-white/60 text-xs font-medium">AI analyzing photos...</p>
            <p className="text-white/20 text-[10px] mt-1">{data.imagePaths?.length || 0} photo(s)</p>
          </div>
        )}

        {/* ── Draft: editable product info ───────────────────────────────── */}
        {hubState === 'draft' && (
          <div className="p-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
            <div className="text-amber-400/60 text-[10px] font-semibold uppercase tracking-wider">📝 Draft</div>

            <EditableField variant="title" value={product.generated_title} placeholder="Click to set title"
              isEditing={editing === 'title'} onStartEdit={() => setEditing('title')}
              onSave={(v) => handleFieldEdit('generated_title', v)} />

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-white/30">Brand: </span>
                <EditableField value={product.brand} isEditing={editing === 'brand'}
                  onStartEdit={() => setEditing('brand')} onSave={(v) => handleFieldEdit('brand', v)} />
              </div>
              <div>
                <span className="text-white/30">Model: </span>
                <EditableField value={product.model} isEditing={editing === 'model'}
                  onStartEdit={() => setEditing('model')} onSave={(v) => handleFieldEdit('model', v)} />
              </div>
            </div>

            <div className="text-white/30 text-[10px]">Condition: {product.condition || 'Unknown'}</div>

            {product.generated_description && (
              <div className="text-white/35 text-[10px] leading-relaxed max-h-12 overflow-hidden">{product.generated_description}</div>
            )}

            <button onClick={handleConfirmDraft}
              className="w-full py-2 rounded-lg text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors mt-1">
              Confirm & Research Price
            </button>
          </div>
        )}

        {/* ── Researching ────────────────────────────────────────────────── */}
        {hubState === 'researching' && (
          <div className="flex flex-col items-center justify-center py-6 px-4">
            <Loader2 size={22} className="animate-spin text-amber-400 mb-2" />
            <p className="text-white/60 text-xs font-medium">Researching market prices...</p>
            {totalComps > 0 && (
              <p className="text-amber-400/60 text-[10px] mt-1">{totalComps} comps found</p>
            )}
          </div>
        )}

        {/* ── Priced: price + platform controls ──────────────────────────── */}
        {hubState === 'priced' && (
          <div className="p-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
            <div className="text-emerald-400/60 text-[10px] font-semibold uppercase tracking-wider">💰 Ready to List</div>

            <div className="text-white/80 text-sm font-semibold truncate">{product.generated_title || 'Item'}</div>

            {/* Price */}
            {data.pricing?.recommended_price && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/30">Recommended:</span>
                <span className="text-emerald-400 font-semibold">${data.pricing.recommended_price}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="text-white/40 text-xs">Your Price:</span>
              <div className="flex-1 flex items-center gap-1">
                <span className="text-white/40 text-sm">$</span>
                <input type="number" value={priceInput}
                  onChange={(e) => handlePriceChange(e.target.value)}
                  className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right" placeholder="0" />
              </div>
            </div>

            {/* Quick price buttons */}
            <QuickPriceButtons pricing={data.pricing} onSelect={handleQuickPrice} />

            {/* Price justification */}
            <PriceJustification pricing={data.pricing} comps={data.comps} expanded={justificationExpanded}
              onToggle={toggleJustification} />

            {/* Platform toggles */}
            <div className="pt-1 border-t border-white/5">
              <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider mb-1">Click source icon to post →</div>
              <PlatformToggles selected={selectedPlatforms} onToggle={togglePlatform} />
            </div>

            {/* Copy + open actions */}
            <div className="flex gap-1.5">
              <button onClick={handleCopyListing}
                className="flex-1 py-1.5 rounded text-[10px] font-medium flex items-center justify-center gap-1 bg-white/5 text-white/50 hover:bg-white/10 transition-colors">
                {copied ? <Check size={10} /> : <Copy size={10} />}
                {copied ? 'Copied!' : 'Copy Listing'}
              </button>
            </div>
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {hubState === 'error' && (
          <div className="flex flex-col items-center justify-center py-6 px-4">
            <p className="text-red-400 text-xs font-medium mb-1">Analysis failed</p>
            <p className="text-white/30 text-[10px] text-center">{data.errorMessage}</p>
            <button onClick={() => { updateNodeData(id, { hubState: 'empty', errorMessage: null }); setCompProgress({}); }}
              className="mt-2 px-3 py-1 rounded text-[10px] bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
              onPointerDown={(e) => e.stopPropagation()}>
              Try again
            </button>
          </div>
        )}
      </HubContainer>
  );
}
