import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { AnimatedSourceRing } from '../components/AnimatedSourceRing';
import { HubContainer } from '../components/HubContainer';
import { Camera, Loader2 } from 'lucide-react';
import { SELL_PLATFORMS, PRICE_COMP_SOURCES } from '../utils/constants';
import { useListingActions } from '../hooks/useListingActions';
import { useToast } from '../components/ToastProvider';
import { SellHubDraftState } from './sellhub/SellHubDraftState';
import { SellHubPricedState } from './sellhub/SellHubPricedState';

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

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const { addToast } = useToast();
  const processingRef = useRef(false);
  const processingPriceRef = useRef(false);
  // Stable ref so handleDrop always calls the latest startAnalysis without needing deps.
  const startAnalysisRef = useRef(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
  const postingTimeoutsRef = useRef({});

  useEffect(() => {
    const timeoutsMap = postingTimeoutsRef.current;
    return () => {
      Object.values(timeoutsMap).forEach(clearTimeout);
    };
  }, []);

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
    const cleanup = window.electronAPI.onPriceSourceProgress((payload) => {
      const { nodeId, sourceId, status, count } = payload;
      
      // Multi-hub safety
      if (nodeId && nodeId !== id) return;

      setCompProgress(prev => ({ ...prev, [sourceId]: { status, count } }));
    });
    return () => cleanup?.();
  }, [id]);

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
          if (data.locked) return;
          if (window.electronAPI?.openExternal) {
            // Animate outward arrow briefly
            setPostingPlatforms(prev => ({ ...prev, [p.id]: 'active' }));
            if (postingTimeoutsRef.current[p.id]) clearTimeout(postingTimeoutsRef.current[p.id]);
            postingTimeoutsRef.current[p.id] = setTimeout(() => {
              setPostingPlatforms(prev => ({ ...prev, [p.id]: 'done' }));
            }, 2000);
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
  }, [hubState, selectedPlatforms, data.comps, compProgress, postingPlatforms, data.locked]);

  const startAnalysis = useCallback(async (imagePaths) => {
    // Ensure no null/empty paths slip through
    const validPaths = (imagePaths || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPaths.length === 0 || !window.electronAPI || processingRef.current) return;
    
    processingRef.current = true;
    setCompProgress({});
    const currentId = id;

    try {
      updateGlobal(currentId, { hubState: 'analyzing' });
      const result = await window.electronAPI.analyzePhotos({ imagePaths: validPaths, nodeId: currentId });
      
      if (!isMountedRef.current || !getNode(currentId)) return;
      if (!result.success) throw new Error(result.error);
      
      updateGlobal(currentId, {
        hubState: 'draft',
        product: result.product,
        images: imagePaths,
      });
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error('[SellHub] Analysis failed:', error);
      updateGlobal(currentId, { hubState: 'error', errorMessage: error?.message || String(error) });
      addToast({ title: 'Photo Analysis Failed', description: error?.message || String(error), type: 'error' });
    } finally {
      if (isMountedRef.current) {
        processingRef.current = false;
      }
    }
  }, [id, updateGlobal, addToast]);

  // Keep ref in sync so handleDrop always invokes the latest closure.
  startAnalysisRef.current = startAnalysis;

  const handleConfirmDraft = useCallback(async () => {
    if (processingPriceRef.current || !data.product) return;
    processingPriceRef.current = true;
    const currentId = id;

    try {
      updateGlobal(currentId, { hubState: 'researching' });
      const result = await researchPrice((state, res) => {
        if (!res) return;
        
        if (state === 'priced') {
          updateGlobal(currentId, {
            hubState: 'priced',
            pricing: res.pricing,
            comps: res.comps || []
          });
          addToast({ title: 'Pricing Engine', description: `Recommended price: $${res.pricing.recommended_price}`, type: 'success' });
        } else if (state === 'priced-empty') {
          updateGlobal(currentId, {
            hubState: 'priced',
            pricing: { recommended_price: null, justification: res.error },
            comps: []
          });
        }
      });
      if (!isMountedRef.current || !getNode(currentId)) return;
      if (!result) {
        updateGlobal(currentId, { hubState: 'draft' });
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('[SellHub] Price research failed:', err);
      updateGlobal(currentId, { hubState: 'draft' });
      addToast({ title: 'Pricing Error', description: err?.message || String(err), type: 'error' });
    } finally {
      if (isMountedRef.current) {
        processingPriceRef.current = false;
      }
    }
  }, [id, updateGlobal, researchPrice, addToast, data.product]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (data.locked) return; // Locked nodes don't accept new drops
    if (hubState === 'analyzing' || hubState === 'researching') return; // Ignore drops while busy
    const files = Array.from(e.dataTransfer?.files || []);
    const images = files.filter(f => f.name.match(/\.(png|jpg|jpeg|webp|gif)$/i));
    const validImages = images.map(f => {
      const path = f.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(f) : '');
      return { ...f, resolvedPath: path };
    }).filter(f => f.resolvedPath);
    if (validImages.length > 0) startAnalysisRef.current?.(validImages.map(f => f.resolvedPath));
  }, [data.locked, hubState]);

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
          nodeId={id}
          direction={hubState === 'researching' ? 'in' : 'out'}
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
          <SellHubDraftState 
            product={product}
            editing={editing}
            setEditing={setEditing}
            handleFieldEdit={handleFieldEdit}
            handleConfirmDraft={handleConfirmDraft}
            locked={!!data.locked}
          />
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
          <SellHubPricedState 
            product={product}
            pricing={data.pricing}
            comps={data.comps}
            priceInput={priceInput}
            handlePriceChange={handlePriceChange}
            handleQuickPrice={handleQuickPrice}
            justificationExpanded={justificationExpanded}
            toggleJustification={toggleJustification}
            selectedPlatforms={selectedPlatforms}
            togglePlatform={togglePlatform}
            copied={copied}
            handleCopyListing={handleCopyListing}
            locked={!!data.locked}
          />
        )}

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {hubState === 'error' && (
          <div className="flex flex-col items-center justify-center py-8 px-4 relative z-10 bg-black/40 rounded-xl">
            <p className="text-red-400 text-xs font-medium mb-1">Analysis failed</p>
            <p className="text-white/30 text-[10px] text-center">{data.errorMessage}</p>
            <button onClick={data.locked ? undefined : () => { updateGlobal(id, { hubState: 'empty', errorMessage: null }); setCompProgress({}); }}
              disabled={!!data.locked}
              className={`mt-2 px-3 py-1 rounded text-[10px] transition-colors ${data.locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Try again
            </button>
          </div>
        )}
      </HubContainer>
  );
}
