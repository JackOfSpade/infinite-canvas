import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { HubContainer } from '../components/HubContainer';
import { Camera, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { PRICE_COMP_SOURCES } from '../utils/constants';
import { useListingActions } from '../hooks/useListingActions';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { HubBusyState } from '../components/HubBusyState';
import { SellHubDraftState } from './sellhub/SellHubDraftState';
import { SellHubPricedState } from './sellhub/SellHubPricedState';
import { useCheckAllConnected } from '../hooks/useCheckAllConnected';

/**
 * Inline error banner shown above the draft / empty body. Replaces the old
 * dedicated 'error' hubState — the user wanted failures to keep their place in
 * the flow (still see/edit the product, still able to drop new photos) rather
 * than be wiped to a "Try Again" wall.
 */
function ErrorBanner({ errorMessage, isRateLimit, locked, onRetry, onDismiss }) {
  const msg = String(errorMessage || '');
  const isBillingDepleted = /prepayment credits are depleted|billing|insufficient/i.test(msg);
  const headerLabel = !isRateLimit
    ? 'Last attempt failed'
    : isBillingDepleted ? 'Billing Credits Depleted' : 'Usage Limit Reached';

  return (
    <div className="m-2 p-2 rounded-md bg-red-500/10 border border-red-500/30" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={11} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-red-300 text-[10px] font-semibold uppercase tracking-wider mb-0.5">
            {headerLabel}
          </div>
          <div className="text-white/70 text-[10px] leading-snug break-words">
            {errorMessage}
          </div>
          {isBillingDepleted && (
            <div className="text-white/40 text-[10px] mt-1 leading-snug">
              Billing is enabled but prepayment is empty — free tier no longer applies. Top up at Cloud Billing, or use a key from an account without billing.
            </div>
          )}
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {!locked && onRetry && (
              <button
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
                className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-[10px] font-medium transition-colors"
              >
                <RefreshCw size={9} /> Try again
              </button>
            )}
            {!locked && isRateLimit && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  document.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'ai' } }));
                }}
                className="nodrag px-1.5 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 text-[10px] font-medium transition-colors"
              >
                Change model / key
              </button>
            )}
            {!locked && isBillingDepleted && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.openExternal?.('https://ai.google.dev/gemini-api/docs/billing#prepay');
                }}
                className="nodrag px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[10px] font-medium transition-colors"
              >
                Top up billing
              </button>
            )}
          </div>
        </div>
        {!locked && onDismiss && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="nodrag text-white/30 hover:text-white/60 shrink-0"
            title="Dismiss"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * SellHubNode — draggable canvas module for marketplace selling.
 *
 * data.hubState: 'empty' | 'analyzing' | 'draft' | 'researching' | 'priced'
 *   (legacy 'error' value from older saves is mapped to draft/empty at render
 *    time; new failures set errorMessage but stay in draft/empty.)
 * data.imagePaths: string[]
 * data.product: { brand, model, generated_title, generated_description, condition, category }
 * data.pricing: { recommended_price, quick_sell_price, max_profit_price, justification, market_summary }
 * data.comps: { sold: [], active: [] }
 * data.errorMessage: string | null — surfaced inline via ErrorBanner above the body
 * data.isRateLimit: boolean
 * data.userPrice: number
 */
export function SellHubNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const { addToast } = useToast();
  const processingRef = useRef(false);
  const processingPriceRef = useRef(false);
  const isMountedRef = useRef(true);
  // Cancellation epoch — bumped by resetHandler. In-flight startAnalysis /
  // handleConfirmDraft capture the epoch at start; their success and catch
  // blocks compare on completion. A mismatch means the user cancelled (or
  // a newer attempt is now in flight) and the late settlement must not
  // overwrite the freshly-reverted state (this was the "Analysis failed —
  // Window closed" bug — the backend abort settled after the UI reverted).
  const cancellationEpochRef = useRef(0);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);
  // Stable ref so handleDrop always calls the latest startAnalysis without needing deps.
  const startAnalysisRef = useRef(null);
  const {
    product, editing, setEditing, priceInput, justificationExpanded,
    copied, handleFieldEdit, handlePriceChange,
    handleQuickPrice, handleCopyListing, toggleJustification,
    researchPrice, listingText,
  } = useListingActions(id, data);

  // ── Phase-2 marketplace cards ──────────────────────────────────────────
  // Each platform the user is selling on becomes its own canvas node spawned
  // from here and connected by an edge. The hub then becomes the control
  // center: spawn cards + "Check All Statuses" (walks each connected card).
  const { checkingAll, checkAll: handleCheckAllStatuses, getConnectedCards } = useCheckAllConnected({
    hubId: id,
    cardType: 'marketplacecard',
    getUrl: (d) => d?.listingUrl,
    getPlatformId: (d) => d?.platformId,
    updateNode: updateNodeData,
    itemLabel: 'marketplace',
  });

  const spawnedMarketplaceIds = getConnectedCards()
    .map(n => n.data?.platformId)
    .filter(Boolean);

  const handleSpawnMarketplaceCard = useCallback((platformId) => {
    if (data.locked) return;
    if (spawnedMarketplaceIds.includes(platformId)) return;
    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    const index = spawnedMarketplaceIds.length;
    const cardId = `mkt-${id}-${platformId}-${Date.now()}`;
    const newNode = {
      id: cardId,
      type: 'marketplacecard',
      position: { x: hubPos.x + 400, y: hubPos.y + index * 260 },
      data: {
        platformId,
        listingUrl: '',
        status: 'unknown',
        productSnapshot: product?.generated_title
          ? { title: product.generated_title, price: priceInput }
          : null,
      },
    };
    const newEdge = {
      id: `edge-${id}-${cardId}`,
      source: id, target: cardId,
      type: 'smoothstep', animated: true,
      style: { stroke: 'rgba(245,158,11,0.5)', strokeWidth: 2 },
    };
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    if (addElementsGlobally) {
      addElementsGlobally(id, [newNode], [newEdge], 'sibling');
    } else {
      addNodes([newNode]);
      addEdges([newEdge]);
    }
  }, [
    data.locked, spawnedMarketplaceIds, id, getNode, product, priceInput,
    addElementsGlobally, addNodes, addEdges,
  ]);


  // Per-source comp progress: { 'ebay-sold': { status, count }, 'amazon': { status, count }, ... }
  const [compProgress, setCompProgress] = useState({});

  const hubState = data.hubState || 'empty';

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

  // Surface the live ring state to the bug-report snapshot so reports like
  // "old comps circle is still showing" can be diagnosed from the report alone
  // (otherwise compProgress is only visible to the user's eyes).
  useEffect(() => {
    EventLogger.registerNodeState(id, { hubState, compProgress });
    return () => EventLogger.unregisterNodeState(id);
  }, [id, hubState, compProgress]);


  const startAnalysis = useCallback(async (imagePaths) => {
    // Ensure no null/empty paths slip through
    const validPaths = (imagePaths || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPaths.length === 0 || !window.electronAPI || processingRef.current) return;

    processingRef.current = true;
    setCompProgress({});
    const currentId = id;
    // Capture epoch so a later resetHandler can invalidate this attempt's
    // settlement. Also clear any leftover errorMessage so a successful run
    // doesn't leave a stale banner around after the next render.
    const myEpoch = cancellationEpochRef.current;
    updateGlobal(currentId, { hubState: 'analyzing', imagePaths: validPaths, errorMessage: null, isRateLimit: false });

    try {
      const result = await window.electronAPI.analyzePhotos({ imagePaths: validPaths, nodeId: currentId });

      if (myEpoch !== cancellationEpochRef.current) return; // user cancelled — let resetHandler's state stand

      if (!result.success) {
        const err = new Error(result.error);
        if (result.isRateLimit) err.isRateLimit = true;
        throw err;
      }

      updateGlobal(currentId, {
        hubState: 'draft',
        product: result.product,
        errorMessage: null,
      });
    } catch (error) {
      if (myEpoch !== cancellationEpochRef.current) return; // cancelled — don't overwrite revert
      EventLogger.error('[SellHub] Analysis failed:', error);
      // Revert to 'empty' (no product was produced) but surface the failure
      // inline via errorMessage so the user can retry from the same step.
      updateGlobal(currentId, {
        hubState: 'empty',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
      addToast({ title: 'Photo Analysis Failed', description: error?.message || String(error), type: 'error' });
    } finally {
      if (isMountedRef.current) {
        processingRef.current = false;
      }
    }
  }, [id, updateGlobal, addToast]);

  // Keep ref in sync so handleDrop always invokes the latest closure.
  startAnalysisRef.current = startAnalysis;

  // Auto-start analysis if images were dropped (must come after startAnalysis is declared
  // — referencing it earlier would hit the const TDZ on first render).
  useEffect(() => {
    if (data.imagePaths?.length > 0 && hubState === 'empty' && !processingRef.current) {
      startAnalysis(data.imagePaths);
    }
  }, [data.imagePaths, hubState, startAnalysis]);

  // Explicit re-run for the "Re-analyze with real AI" CTA on the mock banner.
  // Resets product to a clean slate so the downstream useEffect picks up the
  // empty state and re-invokes startAnalysis with the current imagePaths.
  const handleReanalyze = useCallback(() => {
    if (data.locked || processingRef.current) return;
    if (!data.imagePaths?.length) return;
    updateGlobal(id, { hubState: 'empty', product: null, pricing: null, comps: null, errorMessage: null });
  }, [data.locked, data.imagePaths, id, updateGlobal]);

  // React to settings changes so live nodes don't get stuck showing a stale
  // "API key missing" banner after the user fixes the config. Clearing
  // errorMessage is always safe — the user can retry from any step.
  useEffect(() => {
    if (!window.electronAPI?.onSettingsChanged) return;
    const cleanup = window.electronAPI.onSettingsChanged((payload) => {
      if (!payload?.changedSections?.includes('ai')) return;
      if (data.errorMessage) {
        updateGlobal(id, { errorMessage: null, isRateLimit: false });
      }
    });
    return () => cleanup?.();
  }, [id, data.errorMessage, updateGlobal]);

  // ── Comp-source cards (ephemeral, one per PRICE_COMP_SOURCE) ──────────────
  // Per-source progress shown as real canvas nodes connected by edges —
  // same UX pattern as MarketplaceCardNode in the priced state and
  // JobSourceCardNode under JobHubNode. Each card subscribes to its own
  // progress events. They're ephemeral because comp sources aren't user-
  // facing platforms — they're internal data sources for the price model.

  const cleanupCompSourceCards = useCallback(() => {
    const cardIds = getNodes()
      .filter(n => n.type === 'compsourcecard' && n.data?.hubId === id)
      .map(n => ({ id: n.id }));
    if (cardIds.length === 0) return;
    const cardIdSet = new Set(cardIds.map(c => c.id));
    const edgesToDelete = getEdges()
      .filter(e => cardIdSet.has(e.source) || cardIdSet.has(e.target))
      .map(e => ({ id: e.id }));
    deleteElements({ nodes: cardIds, edges: edgesToDelete });
  }, [id, getNodes, getEdges, deleteElements]);

  // If the hub is deleted mid-research, reap its ephemeral comp cards so they
  // don't strand on the canvas with no listener for their progress events.
  // Ref pattern keeps the unmount effect dep-free without staling the closure.
  const cleanupRef = useRef(cleanupCompSourceCards);
  cleanupRef.current = cleanupCompSourceCards;
  useEffect(() => () => cleanupRef.current(), []);

  const spawnCompSourceCards = useCallback(() => {
    // Defensive: clear any leftovers from a previous (interrupted) run.
    cleanupCompSourceCards();

    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    // Lay the cards out in a circle around the hub, centered roughly on the
    // hub's body. Radius is wide enough that the cards don't overlap the hub.
    const count  = PRICE_COMP_SOURCES.length;
    const radius = 260;
    const cx = hubPos.x + 140; // hub width / 2
    const cy = hubPos.y + 120; // approx hub vertical center during research
    const stamp = Date.now();

    const newNodes = PRICE_COMP_SOURCES.map((source, i) => {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      return {
        id: `comp-${id}-${source.id}-${stamp}`,
        type: 'compsourcecard',
        position: {
          x: cx + Math.cos(angle) * radius - 70, // card width / 2
          y: cy + Math.sin(angle) * radius - 24, // card height / 2
        },
        data: {
          sourceId: source.id,
          name:     source.name,
          letter:   source.letter,
          color:    source.color,
          hubId:    id,
          ephemeral: true,
        },
        // NB: do NOT set `deletable: false` here. ReactFlow's deleteElements()
        // honors that flag and skips the node — which prevented cleanup on
        // cancel/error and left orphaned cards on the canvas (the original
        // "cancelling doesn't undo the spawns" bug). Letting users delete
        // them manually mid-research is fine; they'll respawn on next click.
      };
    });

    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      type: 'smoothstep',
      animated: true,
      style: { stroke: 'rgba(245,158,11,0.5)', strokeWidth: 2 },
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }
  }, [id, getNode, addElementsGlobally, addNodes, addEdges, cleanupCompSourceCards]);

  const handleConfirmDraft = useCallback(async () => {
    if (processingPriceRef.current || !data.product) return;
    processingPriceRef.current = true;
    const currentId = id;
    const myEpoch = cancellationEpochRef.current;

    // Clear per-source progress before the new run. Without this, re-research
    // from the priced state leaves stale "X found" / done states on the ring
    // until each source's first new progress event overwrites it.
    setCompProgress({});
    spawnCompSourceCards();
    updateGlobal(currentId, { hubState: 'researching', errorMessage: null, isRateLimit: false });

    try {
      const result = await researchPrice((state, res) => {
        if (myEpoch !== cancellationEpochRef.current) return; // cancelled — ignore mid-flight updates
        if (!res) return;

        if (state === 'priced') {
          updateGlobal(currentId, {
            hubState: 'priced',
            pricing: res.pricing,
            comps: res.comps || { sold: [], active: [] },
            errorMessage: null,
          });
          const rec = res.pricing?.recommended_price;
          addToast({
            title: 'Pricing Engine',
            description: rec != null ? `Recommended price: $${rec}` : 'No comparable listings found — set your own price.',
            type: 'success',
          });
        } else if (state === 'priced-empty') {
          updateGlobal(currentId, {
            hubState: 'priced',
            pricing: { recommended_price: null, justification: res.error },
            comps: { sold: [], active: [] },
            errorMessage: null,
          });
        }
      });
      if (myEpoch !== cancellationEpochRef.current) return;
      if (!result) {
        updateGlobal(currentId, { hubState: 'draft' });
      }
    } catch (err) {
      if (myEpoch !== cancellationEpochRef.current) return; // cancelled — preserve revert
      EventLogger.error('[SellHub] Price research failed:', err);
      // Revert to 'draft' (product is intact) and surface the error inline
      // so the user can edit the draft or click Try Again from the banner.
      updateGlobal(currentId, {
        hubState: 'draft',
        errorMessage: err?.message || String(err),
        isRateLimit: !!err?.isRateLimit,
      });
      addToast({ title: 'Pricing Error', description: err?.message || String(err), type: 'error' });
    } finally {
      processingPriceRef.current = false;
      // Reap the ephemeral comp-source cards regardless of outcome (success,
      // empty, error). They're useful only while research is in flight.
      cleanupCompSourceCards();
    }
  }, [id, updateGlobal, researchPrice, addToast, data.product, spawnCompSourceCards, cleanupCompSourceCards]);

  const handleDrop = useCallback((e) => {
    if (data.locked) return; // Locked nodes don't accept new drops

    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer?.files || []);
    // Log EVERY drop attempt up front (extensions + total count) so bug reports
    // can distinguish "drop never fired" from "drop fired but every file was
    // rejected by the regex" — the previous code only logged on success.
    const exts = files.map(f => (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '?').toLowerCase());
    EventLogger.log(`[SellHub][${id}] Drop attempt: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}]`);

    const ACCEPTED_RE = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
    const images = files.filter(f => ACCEPTED_RE.test(f.name));
    const validImages = images.map(f => {
      const path = f.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(f) : '');
      return { ...f, resolvedPath: path };
    }).filter(f => f.resolvedPath);

    if (validImages.length === 0) {
      // Tell the user instead of silently doing nothing — the previous early
      // return left the empty-state UI looking unchanged, which is the exact
      // "nothing happened" failure mode this bug report described.
      if (files.length > 0) {
        EventLogger.log(`[SellHub][${id}] Drop rejected: 0 supported images of ${files.length} file(s)`);
        addToast({
          title: 'Unsupported file type',
          description: `Dropped ${files.length} file(s) but none are supported images. Accepted: PNG, JPG, WEBP, GIF, HEIC, HEIF.`,
          type: 'error',
        });
      }
      return;
    }

    EventLogger.log(`[SellHub][${id}] Drop accepted: ${validImages.length}/${files.length} images`);

    // In draft/priced state, or analyzing/researching state: append photos rather than restarting analysis
    if (hubState === 'draft' || hubState === 'priced' || hubState === 'analyzing' || hubState === 'researching') {
      const newPaths = validImages.map(f => f.resolvedPath);
      const existing = data.imagePaths || [];
      const merged = [...new Set([...existing, ...newPaths])]; // deduplicate
      updateGlobal(id, { imagePaths: merged });
      addToast({
        title: `${newPaths.length} Photo${newPaths.length > 1 ? 's' : ''} Added`,
        description: `${merged.length} total photo${merged.length > 1 ? 's' : ''} — listing preserved`,
        type: 'success'
      });
      return;
    }

    // Empty / error state: start fresh analysis
    startAnalysisRef.current?.(validImages.map(f => f.resolvedPath));
  }, [data.locked, data.imagePaths, hubState, id, updateGlobal, addToast]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    EventLogger.log(`[SellHub][${id}] reset from hubState=${hubState}`);

    // Bump epoch BEFORE anything else so any in-flight startAnalysis /
    // handleConfirmDraft promise settling after this point sees the mismatch
    // and skips its state update. This is what stops the "Window closed"
    // message from clobbering the revert a few seconds later.
    cancellationEpochRef.current += 1;

    // Actually cancel the backend pipeline. The IPC is fire-and-forget; the
    // backend's finally{} clears its own progress. We don't await it.
    window.electronAPI?.cancelNodeTask?.(id);

    // Revert intelligently: when aborting price research the user wants to
    // keep their draft (title/description/condition they already approved),
    // not start over from the drop zone. Only the analyzing step has no
    // product yet, so that one goes all the way back to 'empty'.
    const revertTo = hubState === 'researching' && data.product ? 'draft' : 'empty';

    updateGlobal(id, {
      hubState: revertTo,
      errorMessage: null,
      isRateLimit: false,
    });
    setCompProgress({});
    cleanupCompSourceCards();
    processingRef.current = false;
    processingPriceRef.current = false;
  }, [data.locked, data.product, hubState, id, updateGlobal, cleanupCompSourceCards]);

  // Legacy migration: any older workspace saved with hubState='error' is
  // mapped to the step it should logically belong to. errorMessage already
  // tells us _what_ failed via the banner, so we don't need a dedicated state.
  const effectiveHubState = hubState === 'error'
    ? (data.product ? 'draft' : 'empty')
    : hubState;

  const nodeWidth = 280;
  const nodeHeight = effectiveHubState === 'empty' ? 140 : effectiveHubState === 'draft' || effectiveHubState === 'priced' ? 320 : 120;

  // Running total from comp progress
  const totalComps = Object.values(compProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  const handleDismissError = useCallback(() => {
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
  }, [id, updateGlobal]);

  // "Try again" routes to whichever pipeline matches what just failed:
  //  - product present → re-run price research (handleConfirmDraft)
  //  - product missing but imagePaths present → re-run analysis
  const handleRetryFailed = useCallback(() => {
    if (data.locked) return;
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
    if (data.product) {
      handleConfirmDraft();
    } else if (data.imagePaths?.length > 0) {
      startAnalysis(data.imagePaths);
    }
  }, [data.locked, data.product, data.imagePaths, id, updateGlobal, handleConfirmDraft, startAnalysis]);

  const banner = data.errorMessage ? (
    <ErrorBanner
      errorMessage={data.errorMessage}
      isRateLimit={!!data.isRateLimit}
      locked={!!data.locked}
      onRetry={handleRetryFailed}
      onDismiss={handleDismissError}
    />
  ) : null;

  return (
    <HubContainer
      hubState={effectiveHubState}
      theme="amber"
      width={nodeWidth}
      height={undefined}
      minHeight={nodeHeight}
      onDrop={handleDrop}
      interactiveStates={['draft', 'priced']}
    >
        {/* ── Empty: drop zone (+ banner if a prior attempt failed) ─────── */}
        {effectiveHubState === 'empty' && (
          <>
            {banner}
            <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
              <Camera size={28} className="text-emerald-400/40 mb-3" />
              <p className="text-white/40 text-sm font-medium">Drop product photos</p>
              <p className="text-white/20 text-[10px] mt-1">AI identifies & prices</p>
            </div>
          </>
        )}

        {/* ── Analyzing ──────────────────────────────────────────────────── */}
        {effectiveHubState === 'analyzing' && (
          <HubBusyState
            theme="amber"
            label="AI analyzing photos..."
            subline={`${data.imagePaths?.length || 0} photo(s)`}
            onReset={resetHandler}
          />
        )}

        {/* ── Draft: editable product info (+ banner if research failed) ─ */}
        {effectiveHubState === 'draft' && (
          <>
            {banner}
            <SellHubDraftState
              product={product}
              editing={editing}
              setEditing={setEditing}
              handleFieldEdit={handleFieldEdit}
              handleConfirmDraft={handleConfirmDraft}
              locked={!!data.locked}
              imagePaths={data.imagePaths || []}
              onReanalyze={handleReanalyze}
            />
          </>
        )}

        {/* ── Researching ────────────────────────────────────────────────── */}
        {effectiveHubState === 'researching' && (
          <HubBusyState
            theme="amber"
            label="Researching market prices..."
            subline={totalComps > 0 ? `${totalComps} comps found` : null}
            onReset={resetHandler}
          />
        )}

        {/* ── Priced: price + platform controls ──────────────────────────── */}
        {effectiveHubState === 'priced' && (
          <SellHubPricedState
            product={product}
            pricing={data.pricing}
            comps={data.comps}
            priceInput={priceInput}
            handlePriceChange={handlePriceChange}
            handleQuickPrice={handleQuickPrice}
            justificationExpanded={justificationExpanded}
            toggleJustification={toggleJustification}
            copied={copied}
            handleCopyListing={handleCopyListing}
            listingText={listingText}
            locked={!!data.locked}
            imagePaths={data.imagePaths || []}
            onReresearch={handleConfirmDraft}
            spawnedMarketplaceIds={spawnedMarketplaceIds}
            onSpawnMarketplaceCard={handleSpawnMarketplaceCard}
            onCheckAllStatuses={handleCheckAllStatuses}
            checkingAll={checkingAll}
          />
        )}
      </HubContainer>
  );
}
