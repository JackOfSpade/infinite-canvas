import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { usePlatformsVerifyingProgress } from '../contexts/useSessionStatus';
import { HubContainer } from '../components/HubContainer';
import { Camera } from 'lucide-react';
import { ACTIVE_COMP_SOURCES, SELL_PLATFORMS } from '../utils/constants';
import { normalizeCompWarnings } from '../utils/compSourceScope';
import { radialRadius, fitViewDuration } from '../utils/layoutGeometry';
import { useListingActions } from '../hooks/useListingActions';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { HubBusyState } from '../components/HubBusyState';
import { SellHubDraftState } from './sellhub/SellHubDraftState';
import { SellHubPricedState } from './sellhub/SellHubPricedState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { SellHubCompsReadyDecision } from './sellhub/SellHubCompsReadyDecision';
import { useCheckAllConnected } from '../hooks/useCheckAllConnected';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation, isNodeDeletedAbort } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { PRODUCT_IMAGE_EXT_RE } from '../utils/fileExtensions';
import { mergeSourceIntoComps } from '../utils/compsMerge';
import { getHubDropLockReason } from '../utils/hubDropEligibility';

/**
 * SellHubNode — draggable canvas module for marketplace selling.
 *
 * data.hubState: 'empty' | 'analyzing' | 'draft' | 'researching' | 'priced' | 'comps-ready'
 *   Failures set errorMessage (surfaced via HubErrorBanner) but stay in the
 *   logical step rather than wiping to a dedicated error wall.
 * data.imagePaths: string[]
 * data.product: { brand, model, generated_title, generated_description, condition, category }
 * data.pricing: { recommended_price, quick_sell_price, max_profit_price, justification, market_summary }
 * data.comps: { sold: [], active: [] }
 * data.errorMessage: string | null — surfaced inline via HubErrorBanner above the body
 * data.isRateLimit: boolean
 */
export function SellHubNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const { addToast } = useToast();
  const processingRef = useRef(false);
  const processingPriceRef = useRef(false);
  const initialDropAcceptedRef = useRef(false);
  const isMountedRef = useRef(true);
  // Cancellation epoch — see hooks/useEpochCancellation.js. In-flight async
  // workflows (startAnalysis / handleConfirmDraft / synthesizeAndPrice)
  // call `epoch.start()` and re-check `cancelled()` after each await so a
  // user-triggered reset (which bumps the epoch) doesn't get clobbered by
  // a late settlement.
  const epoch = useEpochCancellation();
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);
  // Stable ref so handleDrop always calls the latest startAnalysis without needing deps.
  const startAnalysisRef = useRef(null);
  const {
    product, editing, setEditing, justificationExpanded,
    handleFieldEdit, toggleJustification,
    scrapePriceComps, rescrapeSource, synthesizePrice,
  } = useListingActions(id, data);

  // ── Phase-2 marketplace cards ──────────────────────────────────────────
  // Each platform the user is selling on becomes its own canvas node spawned
  // from here and connected by an edge. The hub then becomes the control
  // center: spawn cards + "Check All Statuses" (walks each connected card).
  const { checkingAll, checkAll: handleCheckAllStatuses } = useCheckAllConnected({
    hubId: id,
    cardType: 'marketplacecard',
    getUrl: (d) => d?.listingUrl,
    getPlatformId: (d) => d?.platformId,
    updateNode: updateNodeData,
    itemLabel: 'marketplace',
  });

  // Query the WHOLE canvas (not just edge-connected) by hubId backlink so a
  // user who detached a card can't accidentally double-spawn the same
  // platform. With the hub→card edge now locked non-deletable on spawn, true
  // orphans only exist for pre-this-change cards — those fall back to manual
  // delete + respawn, which is fine.
  const spawnedMarketplaceIds = getNodes()
    .filter(n => n.type === 'marketplacecard' && n.data?.hubId === id)
    .map(n => n.data?.platformId)
    .filter(Boolean);

  const handleSpawnMarketplaceCard = useCallback((platformId) => {
    if (data.locked) return;
    if (spawnedMarketplaceIds.includes(platformId)) return;
    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    // Place the card in the first vertical slot not already occupied by a sibling
    // marketplace card. Using the live count instead collided after a deletion:
    // spawn ebay(0)+mercari(1), delete ebay, spawn poshmark → count is 1 again →
    // poshmark lands on mercari's row. Deriving the slot from existing positions
    // reuses the freed row instead.
    const usedSlots = new Set(
      getNodes()
        .filter(n => n.type === 'marketplacecard' && n.data?.hubId === id)
        .map(n => Math.round(((n.position?.y ?? hubPos.y) - hubPos.y) / 260))
    );
    let index = 0;
    while (usedSlots.has(index)) index++;
    const cardId = `mkt-${id}-${platformId}-${Date.now()}`;
    const newNode = {
      id: cardId,
      type: 'marketplacecard',
      position: { x: hubPos.x + 400, y: hubPos.y + index * 260 },
      data: {
        platformId,
        hubId: id,
        listingUrl: '',
        status: 'unknown',
        productSnapshot: product?.generated_title
          ? { title: product.generated_title, price: data.pricing?.recommended_price || null }
          : null,
      },
    };
    const newEdge = {
      id: `edge-${id}-${cardId}`,
      source: id, target: cardId,
      type: 'smoothstep', animated: true,
      // Hub→spawn-card edge is structural, not user-managed. Locking
      // selectable/deletable means it can only go away when the card itself
      // is deleted (ReactFlow auto-prunes attached edges), keeping the
      // hub's spawn-tracking and "Check All" walks in lockstep with the
      // actual card lifecycle.
      selectable: false,
      deletable: false,
      focusable: false,
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
    data.locked, spawnedMarketplaceIds, id, getNode, getNodes, product, data.pricing?.recommended_price,
    addElementsGlobally, addNodes, addEdges,
  ]);


  // Surfaced via EventLogger.registerNodeState so the bug-report node-
  // diagnostics row shows "queued: N" when early captcha-resolves are
  // sitting waiting for scrape completion. Previously this state was
  // invisible, which made "I solved all the cards but it still said 1
  // left" reports hard to diagnose.
  const [queuedResolvesCount, setQueuedResolvesCount] = useState(0);

  const hubState = data.hubState || 'empty';
  const dropLockReason = getHubDropLockReason({ type: 'sellhub', data });
  const inputDropsBlocked = !!dropLockReason;
  const { verifying: platformsVerifying, done: verifyDone, total: verifyTotal } = usePlatformsVerifyingProgress(['ebay', 'poshmark', 'mercari', 'swappa', 'facebook']);

  useEffect(() => {
    if (data.inputLocked || data.product || data.imagePaths?.length > 0) {
      initialDropAcceptedRef.current = true;
    }
  }, [data.inputLocked, data.product, data.imagePaths]);

  // Per-source comp progress populated from backend `price-source-progress`
  // events. Reset before each fresh run so stale counts don't bleed in.
  const {
    progress: compProgress,
    reset: resetCompProgress,
  } = useSourceProgress(window.electronAPI?.onPriceSourceProgress, id);

  // Surface the live ring state to the bug-report snapshot so reports like
  // "old comps circle is still showing" can be diagnosed from the report alone
  // (otherwise compProgress is only visible to the user's eyes).
  useEffect(() => {
    EventLogger.registerNodeState(id, { hubState, compProgress, queuedResolvesCount });
    return () => EventLogger.unregisterNodeState(id);
  }, [id, hubState, compProgress, queuedResolvesCount]);


  const startAnalysis = useCallback(async (imagePaths) => {
    // Ensure no null/empty paths slip through
    const validPaths = (imagePaths || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPaths.length === 0 || !window.electronAPI || processingRef.current) return;

    processingRef.current = true;
    resetCompProgress();
    const currentId = id;
    // Capture epoch so a later resetHandler can invalidate this attempt's
    // settlement. Also clear any leftover errorMessage so a successful run
    // doesn't leave a stale banner around after the next render.
    const cancelled = epoch.start();
    updateGlobal(currentId, { hubState: 'analyzing', imagePaths: validPaths, inputLocked: true, errorMessage: null, isRateLimit: false });

    try {
      const result = await window.electronAPI.analyzePhotos({ imagePaths: validPaths, nodeId: currentId });

      if (cancelled()) return; // user cancelled — let resetHandler's state stand

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
      // User cancelled OR deleted the hub mid-analysis. Bail silently in
      // both cases — see isNodeDeletedAbort for why the second check is
      // needed despite the existing cancelled() guard.
      if (cancelled() || isNodeDeletedAbort(error)) return;
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
  }, [id, updateGlobal, addToast, epoch, resetCompProgress]);

  // Keep ref in sync so handleDrop always invokes the latest closure.
  useEffect(() => {
    startAnalysisRef.current = startAnalysis;
  }, [startAnalysis]);

  // Auto-start analysis if images were dropped (must come after startAnalysis is declared
  // — referencing it earlier would hit the const TDZ on first render).
  // Skip when errorMessage is set: the catch block reverts hubState to 'empty'
  // while leaving imagePaths populated, so without this guard a failed
  // attempt re-triggers itself on the next render — infinite retry storm
  // until the user manages to click Reset.
  useEffect(() => {
    if (
      data.imagePaths?.length > 0 &&
      hubState === 'empty' &&
      !data.errorMessage &&
      !processingRef.current
    ) {
      startAnalysis(data.imagePaths);
    }
  }, [data.imagePaths, hubState, data.errorMessage, startAnalysis]);

  // React to settings changes. We log them for bug report telemetry but do NOT
  // auto-clear the error or revert the state without explicit user action.
  useEffect(() => {
    if (!window.electronAPI?.onSettingsChanged) return;
    const cleanup = window.electronAPI.onSettingsChanged((payload) => {
      if (!payload?.changedSections?.includes('ai')) return;
      if (data.errorMessage) {
        EventLogger.log(`[SellHub][${id}] Settings changed with active error; keeping error banner open for explicit user action`);
      }
    });
    return () => cleanup?.();
  }, [id, data.errorMessage]);

  // ── Comp-source cards (ephemeral, one per PRICE_COMP_SOURCE) ──────────────
  // Per-source progress shown as real canvas nodes connected by edges —
  // same UX pattern as MarketplaceCardNode in the priced state and
  // JobSourceCardNode under JobSearchNode. Each card subscribes to its own
  // progress events. They're ephemeral because comp sources aren't user-
  // facing platforms — they're internal data sources for the price model.

  // Reap every comp-source card belonging to this hub. Called defensively at
  // the start of a new scrape run (clean slate) and on user-cancel from the
  // 'comps-ready' state. Individual cards self-manage in normal flow:
  // clean-success cards self-delete on a 3s timer, warned/errored cards
  // stick around until the user clicks Solve or Skip on them.
  const cleanupCompSourceCards = useCallback(() => {
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['compsourcecard'],
    });
  }, [id, getNodes, getEdges, deleteElements]);

  // On hub DELETE, reap EVERYTHING that belongs to it — the ephemeral comp-source
  // cards AND the marketplacecard platform cards spawned after pricing (the
  // eBay/Swappa/… listing cards). cleanupCompSourceCards above is reused for
  // pre-run/cancel cleanup, which must leave the spawned platform cards alone, so
  // the unmount cascade needs its own wider sweep. Mirrors Job Search Module's cleanupAllJobChildren.
  const cleanupAllHubChildren = useCallback(() => {
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['compsourcecard', 'marketplacecard'],
    });
  }, [id, getNodes, getEdges, deleteElements]);

  // If the hub is deleted, reap its comp cards (no listener for their progress
  // events otherwise) and its spawned marketplace cards (orphaned otherwise).
  useUnmountEffect(cleanupAllHubChildren);

  const spawnCompSourceCards = useCallback(() => {
    // Defensive: clear any leftovers from a previous (interrupted) run.
    cleanupCompSourceCards();

    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    // Lay the cards out in a circle around the hub, centered roughly on the
    // hub's body.
    const count  = ACTIVE_COMP_SOURCES.length;
    const HUB_W = 280, HUB_H = 240;     // approx hub footprint while researching
    const CARD_W = 140, CARD_H = 48;
    // Radius derived from card count + footprint so cards clear the hub and
    // never overlap each other as the comp-source list grows (replaces a fixed 260).
    const radius = radialRadius({ count, cardW: CARD_W, cardH: CARD_H, hubW: HUB_W, hubH: HUB_H });
    const cx = hubPos.x + HUB_W / 2;
    const cy = hubPos.y + HUB_H / 2;
    const stamp = Date.now();

    const newNodes = ACTIVE_COMP_SOURCES.map((source, i) => {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      return {
        id: `comp-${id}-${source.id}-${stamp}`,
        type: 'compsourcecard',
        position: {
          x: cx + Math.cos(angle) * radius - CARD_W / 2,
          y: cy + Math.sin(angle) * radius - CARD_H / 2,
        },
        data: {
          sourceId: source.id,
          name:     source.name,
          letter:   source.letter,
          color:    source.color,
          domain:   source.domain,
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

    // Route each hub→card edge to the hub's nearest side so edges don't all
    // bunch on one face. pickEdgeHandles handles the math; both ends already
    // render the required NodeHandles slots.
    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      ...pickEdgeHandles(
        { x: n.position.x + CARD_W / 2, y: n.position.y + CARD_H / 2 },
        { x: cx,                        y: cy                       },
      ),
      ...structuralEdge('rgba(245,158,11,0.5)'),
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }
  }, [id, getNode, addElementsGlobally, addNodes, addEdges, cleanupCompSourceCards]);

  // After scrape finishes, transition straight to 'priced' (clean) or pause
  // in 'comps-ready' (some sources blocked) so the user can resolve or skip
  // before we spend AI tokens. Extracted because both the initial run and
  // the "Skip & price now" button funnel through the same synthesis step.
  const synthesizeAndPrice = useCallback(async (comps, scrapeWarnings, cancelled) => {
    const currentId = id;
    try {
      const synthResult = await synthesizePrice(comps);
      if (cancelled()) return;
      // Platform fit is assessed in a SECOND background AI call after pricing.
      // If we render the marketplace list before it lands, every platform shows
      // as "good" and then unfit ones collapse behind the toggle a few seconds
      // later — a jarring "all good, then filtered" flicker. `platformFitPending`
      // lets the priced UI hold the marketplace list in a "selecting…" state
      // until the verdicts arrive. Only set it when we'll actually run the
      // assessment — otherwise the list would spin forever.
      const willAssessFit = !!(window.electronAPI?.assessPlatformFit && data.product);
      updateGlobal(currentId, {
        hubState: 'priced',
        pricing: synthResult.pricing,
        comps,
        scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
        platformFit: null,
        platformFitPending: willAssessFit,
        errorMessage: null,
      });
      // Fire platform-fit assessment in the background; clear `pending` whether
      // it succeeds OR fails (on failure platformFit stays null → the list falls
      // back to showing every platform unfiltered, never a stuck spinner).
      if (willAssessFit) {
        window.electronAPI.assessPlatformFit({
          product: data.product,
          platforms: SELL_PLATFORMS.map(p => ({ id: p.id, name: p.name })),
          nodeId: currentId,
        })
          .then(r => {
            if (cancelled()) return;
            updateGlobal(currentId, {
              platformFit: (r?.fit && typeof r.fit === 'object') ? r.fit : null,
              platformFitPending: false,
            });
          })
          .catch(err => {
            EventLogger.error('[SellHub] Platform-fit assessment failed (non-fatal):', err);
            if (!cancelled()) updateGlobal(currentId, { platformFitPending: false });
          });
      }
      const rec = synthResult.pricing?.recommended_price;
      const warnCount = Array.isArray(scrapeWarnings) ? scrapeWarnings.length : 0;
      addToast({
        title: 'Pricing Engine',
        description: rec != null
          ? `Recommended price: $${rec}${warnCount > 0 ? ` (synthesized without ${warnCount} blocked source(s))` : ''}`
          : 'No similar listings — set your own price.',
        type: warnCount > 0 ? 'warning' : 'success',
      });
    } catch (err) {
      if (cancelled() || isNodeDeletedAbort(err)) return;
      EventLogger.error('[SellHub] Price synthesis failed:', err);
      updateGlobal(currentId, {
        hubState: 'draft',
        errorMessage: err?.message || String(err),
        isRateLimit: !!err?.isRateLimit,
      });
      addToast({ title: 'Pricing Error', description: err?.message || String(err), type: 'error' });
    }
  }, [id, updateGlobal, synthesizePrice, addToast, data.product]);

  const handleConfirmDraft = useCallback(async () => {
    if (processingPriceRef.current || !data.product) return;
    processingPriceRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();

    resetCompProgress();
    spawnCompSourceCards();
    updateGlobal(currentId, { hubState: 'researching', errorMessage: null, isRateLimit: false, pendingComps: null, platformFit: null, platformFitPending: false });

    requestAnimationFrame(() => {
      fitView({ duration: fitViewDuration(ACTIVE_COMP_SOURCES.length), padding: 0.2 });
    });

    try {
      const scrapeResult = await scrapePriceComps();
      if (cancelled()) return;

      // Hard login preflight (policy): the backend blocked the run because one or
      // more in-scope marketplaces aren't logged in. Terminal "log in first" state
      // — no synthesis and no Skip (unlike a resolvable per-source block). Return
      // to 'draft' so logging in (Settings > Accounts) and re-confirming re-runs.
      if (scrapeResult.preflightBlocked) {
        const missing = Array.isArray(scrapeResult.missingLogins) ? scrapeResult.missingLogins : [];
        updateGlobal(currentId, {
          hubState: 'draft',
          errorMessage: `Price check needs login on: ${missing.join(', ')}. Log in (Settings → Accounts) and re-run.`,
          isRateLimit: false, pendingComps: null, scrapeWarnings: [],
          platformFit: null, platformFitPending: false,
        });
        addToast({
          title: 'Log in to run a price check',
          description: `Not logged in: ${missing.join(', ')}. This run requires login on all in-scope marketplaces.`,
          type: 'warning',
        });
        return;
      }

      const comps = scrapeResult.comps || { sold: [], active: [] };
      // Re-tag/drop warnings whose sourceId has no spawned card (e.g. backend-only
      // 'swappa-sold' → the 'swappa' family card) BEFORE they reach the gate, so a
      // blocked sub-source can actually be Skipped/Solved instead of stranding the
      // hub in 'comps-ready'. Card ids = the cards actually spawned (ACTIVE_COMP_SOURCES).
      const scrapeWarnings = normalizeCompWarnings(
        Array.isArray(scrapeResult.scrapeWarnings) ? scrapeResult.scrapeWarnings : [],
        ACTIVE_COMP_SOURCES.map(s => s.id),
      );

      // Branch: any blocked source → pause and ask the user. AI synthesis is
      // skipped here so we don't spend tokens on partial data without consent.
      // The 'comps-ready' UI hands the decision back: Solve blockers (cards
      // already show Solve buttons) or Skip → call synthesizeAndPrice directly.
      // Edge case: zero comps AND zero warnings means search came up empty
      // legitimately — go straight to priced with an empty result.
      // Drain any captcha-resolves that landed during the scrape. Each
      // queued merge replaces same-source items in pendingComps and drops
      // the source from scrapeWarnings. Order doesn't matter — the filter
      // is by source id, so later entries for the same source overwrite
      // earlier ones cleanly.
      let mergedComps = comps;
      let effectiveWarnings = scrapeWarnings;
      if (pendingMergesRef.current.length > 0) {
        const queued = pendingMergesRef.current.splice(0);
        setQueuedResolvesCount(0);
        EventLogger.log(`[SellHub][${id}] applying ${queued.length} queued early-resolve(s): ${queued.map(q => q.sourceId).join(', ')}`);
        for (const q of queued) {
          mergedComps = mergeSourceIntoComps(mergedComps, { sourceId: q.sourceId, category: q.category, items: q.items });
          effectiveWarnings = effectiveWarnings.filter(w => w.sourceId !== q.sourceId);
        }
      }
      const effectiveTotal = (mergedComps.sold?.length || 0) + (mergedComps.active?.length || 0);

      if (effectiveWarnings.length > 0) {
        updateGlobal(currentId, {
          hubState: 'comps-ready',
          pendingComps: mergedComps,
          scrapeWarnings: effectiveWarnings,
          errorMessage: null,
        });
        addToast({
          title: 'Sources blocked',
          description: `${effectiveWarnings.length} source(s) blocked or errored. Resolve them or click Skip to price with partial data.`,
          type: 'warning',
        });
        return;
      }

      if (effectiveTotal === 0) {
        updateGlobal(currentId, {
          hubState: 'priced',
          pricing: { recommended_price: null, justification: 'No similar listings found — set your own price.', market_summary: { sold_count: 0, active_count: 0 }, recommended_platforms: [] },
          comps: mergedComps,
          scrapeWarnings: [],
          platformFit: null,
          platformFitPending: false,
          errorMessage: null,
        });
        return;
      }

      // All clean (either no warnings from the start, or queued resolves
      // cleared them) → straight to synthesis.
      await synthesizeAndPrice(mergedComps, effectiveWarnings, cancelled);
    } catch (err) {
      if (cancelled() || isNodeDeletedAbort(err)) return;
      EventLogger.error('[SellHub] Price scrape failed:', err);
      updateGlobal(currentId, {
        hubState: 'draft',
        errorMessage: err?.message || String(err),
        isRateLimit: !!err?.isRateLimit,
      });
      addToast({ title: 'Scrape Error', description: err?.message || String(err), type: 'error' });
    } finally {
      processingPriceRef.current = false;
      // No cleanup pass here — clean-success cards self-dismiss on their
      // own 3s timer (so the user actually sees the "25 found" result),
      // and warned/errored cards stick around until the user acts on them.
      // Defensive cleanup at start-of-next-run (spawnCompSourceCards) still
      // ensures no carry-over.
    }
  }, [id, updateGlobal, scrapePriceComps, synthesizeAndPrice, addToast, data.product, spawnCompSourceCards, fitView, epoch, resetCompProgress]);

  // Per-source skip — fired by a comp card's Skip button. Drops the source
  // from data.scrapeWarnings, deletes the card, then if the warnings list
  // is empty AND we're still in 'comps-ready', auto-fires synthesis. This
  // is the per-card analogue of the old hub-level "Skip & price now"
  // button: each blocked source gets its own decision, and the AI call
  // only fires once every blocked source has been individually
  // resolved-or-skipped. Filtered by hubId so a multi-hub canvas doesn't
  // cross-trigger.
  //
  // Refs bridge data.scrapeWarnings / data.pendingComps / hubState so two
  // skip events firing within a single React batch both read the LATEST
  // warnings list (the first event's updateGlobal hasn't flushed when the
  // second runs). Without the refs, the second event would re-add the
  // first event's already-dismissed warning.
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const pendingCompsRef   = useRef(data.pendingComps);
  const hubStateRef       = useRef(hubState);
  useEffect(() => { scrapeWarningsRef.current = data.scrapeWarnings; }, [data.scrapeWarnings]);
  useEffect(() => { pendingCompsRef.current   = data.pendingComps;   }, [data.pendingComps]);
  useEffect(() => { hubStateRef.current       = hubState;            }, [hubState]);
  useEffect(() => {
    const onSkip = (e) => {
      if (e.detail?.hubId !== id) return;
      const skippedSourceId = e.detail?.sourceId;
      if (!skippedSourceId) return;

      const remainingWarnings = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== skippedSourceId);
      // Mutate the ref synchronously so a SECOND skip event in the same
      // tick sees the post-first-skip list, not the stale closure value.
      scrapeWarningsRef.current = remainingWarnings;
      EventLogger.log(`[SellHub][${id}] user skipped ${skippedSourceId}; ${remainingWarnings.length} blocked source(s) remaining`);
      updateGlobal(id, { scrapeWarnings: remainingWarnings });

      // Delete the skipped card (and its edge, auto-pruned by ReactFlow).
      const cardNode = getNodes().find(n => n.type === 'compsourcecard' && n.data?.hubId === id && n.data?.sourceId === skippedSourceId);
      if (cardNode) deleteElements({ nodes: [{ id: cardNode.id }] });

      // If this was the last blocker AND we're still in the pause state,
      // auto-fire synthesis. The hubState check guards against firing
      // again after the user already moved on (e.g., already in 'priced').
      if (remainingWarnings.length === 0 && hubStateRef.current === 'comps-ready' && pendingCompsRef.current) {
        if (processingPriceRef.current) return;
        processingPriceRef.current = true;
        const cancelled = epoch.start();
        const comps = pendingCompsRef.current;
        (async () => {
          try {
            updateGlobal(id, { hubState: 'researching' });
            await synthesizeAndPrice(comps, [], cancelled);
            updateGlobal(id, { pendingComps: null });
          } finally {
            processingPriceRef.current = false;
          }
        })();
      }
    };
    document.addEventListener('comp-source-skip', onSkip);
    return () => document.removeEventListener('comp-source-skip', onSkip);
  }, [id, updateGlobal, getNodes, deleteElements, synthesizeAndPrice, epoch]);

  // After a comp card's captcha-resolve window auto-detects the challenge as
  // cleared, refetch ONLY the unblocked source and merge into pendingComps.
  // Previous behavior (full handleConfirmDraft re-run) threw away the prior
  // scrape's ~70 successful items and re-hit every other source for nothing.
  //
  // Refs bridge data.scrapeWarnings / data.pendingComps / hubState into the
  // async retry handler so rapid resolves don't read stale closures.
  const rescrapeSourceRef = useRef(rescrapeSource);
  const synthesizeAndPriceRef = useRef(synthesizeAndPrice);
  useEffect(() => { rescrapeSourceRef.current = rescrapeSource; }, [rescrapeSource]);
  useEffect(() => { synthesizeAndPriceRef.current = synthesizeAndPrice; }, [synthesizeAndPrice]);

  // Queue of resolves that landed BEFORE the scrape itself completed (per-
  // source-progress events fire mid-scrape, so a fast user can click Solve
  // and resolve a captcha while the rest of the scrape is still running).
  // Without queueing, those early resolves would be discarded by the
  // hubState guard, leaving the warning in scrapeWarnings and the hub
  // stuck in comps-ready with "1 left" even though the user solved
  // everything visible. Drained in handleConfirmDraft after the scrape
  // settles and pendingComps is initialized.
  const pendingMergesRef = useRef([]);
  useEffect(() => {
    const onResolved = async (e) => {
      if (e.detail?.hubId !== id) return;
      const resolvedSourceId = e.detail?.sourceId;
      if (!resolvedSourceId) return;

      // Prefer items extracted inline in the visible captcha-resolve session.
      // The session that passed the bot check is the only session guaranteed
      // to be able to read the real content — a headless rescrape after
      // close just re-triggers the same wall on sites that fingerprint
      // (the original bug was exactly this loop for Mercari). Only fall
      // back to rescrape when inline extract wasn't possible.
      const inlineItems = Array.isArray(e.detail?.items) ? e.detail.items : null;
      let result;
      if (inlineItems) {
        EventLogger.log(`[SellHub][${id}] captcha resolved for ${resolvedSourceId} — using ${inlineItems.length} inline-extracted item(s); no rescrape needed`);
        addToast({
          title: 'Captcha cleared',
          description: `${resolvedSourceId} pulled ${inlineItems.length} item(s) inline — other sources keep their results.`,
          type: 'success',
        });
        result = { sourceId: resolvedSourceId, items: inlineItems, warning: null, category: e.detail?.category || 'sold' };
      } else {
        EventLogger.log(`[SellHub][${id}] captcha resolved for ${resolvedSourceId} — no inline items, falling back to rescrape`);
        addToast({
          title: 'Captcha cleared',
          description: `Refetching ${resolvedSourceId} (cookies are fresh) — other sources keep their results.`,
          type: 'success',
        });
        try {
          result = await rescrapeSourceRef.current(resolvedSourceId);
        } catch (err) {
          // Silent bail if the user deleted the hub while a rescrape was
          // mid-flight — no toast, no log, the hub is gone anyway.
          if (isNodeDeletedAbort(err)) return;
          EventLogger.error(`[SellHub][${id}] rescrape ${resolvedSourceId} failed:`, err);
          addToast({ title: 'Rescrape failed', description: err?.message || String(err), type: 'error' });
          return;
        }
      }

      // The hubState guard splits three ways:
      //  - 'comps-ready': normal path, merge below.
      //  - 'researching': the scrape is still running. User clicked Solve
      //    on a per-source-progress warning that arrived mid-scrape.
      //    Queue this result and let handleConfirmDraft's success-path
      //    drain it after the scrape settles, otherwise the warning
      //    would stick around when scrape completion overwrites
      //    pendingComps with the original (warning-included) data.
      //  - anything else ('draft', 'priced', 'empty'): user moved on
      //    (Cancel or Refresh Prices) — discard.
      if (hubStateRef.current === 'researching') {
        EventLogger.log(`[SellHub][${id}] queueing early resolve for ${resolvedSourceId} (${result.items?.length || 0} items, category=${result.category}) — will apply after scrape completes`);
        pendingMergesRef.current.push({
          sourceId: resolvedSourceId,
          items: result.items || [],
          category: result.category || 'sold',
        });
        setQueuedResolvesCount(pendingMergesRef.current.length);
        return;
      }
      if (hubStateRef.current !== 'comps-ready') {
        EventLogger.log(`[SellHub][${id}] hubState=${hubStateRef.current} during rescrape settle — discarding ${resolvedSourceId} result`);
        return;
      }

      // Source still blocked? Update its warning and leave it for the user.
      // The card's progress event subscription already updated its visual
      // state via the per-source-progress emits inside scrapeOneSource.
      if (result.warning) {
        EventLogger.log(`[SellHub][${id}] ${resolvedSourceId} still blocked after retry: ${result.warning.code}`);
        const updatedWarnings = (scrapeWarningsRef.current || []).map(w =>
          w.sourceId === resolvedSourceId ? { ...w, ...result.warning, sourceId: resolvedSourceId } : w
        );
        scrapeWarningsRef.current = updatedWarnings;
        updateGlobal(id, { scrapeWarnings: updatedWarnings });
        addToast({
          title: 'Source still blocked',
          description: `${resolvedSourceId}: ${result.warning.code}. Try Solve again or Skip.`,
          type: 'warning',
        });
        return;
      }

      // Success — merge items into pendingComps under their category. Tag-by-
      // source lets a retry-of-a-retry replace prior items cleanly instead of
      // accumulating duplicates. Items already carry a `source` field from
      // the extractors.
      const prevComps = pendingCompsRef.current || { sold: [], active: [] };
      const category = result.category || 'sold';
      const mergedComps = mergeSourceIntoComps(prevComps, { sourceId: resolvedSourceId, category, items: result.items });
      const remainingWarnings = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== resolvedSourceId);
      pendingCompsRef.current = mergedComps;
      scrapeWarningsRef.current = remainingWarnings;
      updateGlobal(id, { pendingComps: mergedComps, scrapeWarnings: remainingWarnings });

      EventLogger.log(`[SellHub][${id}] merged ${result.items.length} ${resolvedSourceId} items into pendingComps; ${remainingWarnings.length} blocked source(s) remaining`);

      // If this was the last blocker AND we're still in the pause state,
      // auto-fire synthesis. The hubState check guards against firing after
      // the user already moved on (Cancel'd or Skip'd everything else).
      if (remainingWarnings.length === 0 && hubStateRef.current === 'comps-ready') {
        if (processingPriceRef.current) return;
        processingPriceRef.current = true;
        const cancelled = epoch.start();
        try {
          updateGlobal(id, { hubState: 'researching' });
          await synthesizeAndPriceRef.current(mergedComps, [], cancelled);
          updateGlobal(id, { pendingComps: null });
        } finally {
          processingPriceRef.current = false;
        }
      }
    };
    document.addEventListener('comp-captcha-resolved', onResolved);
    return () => document.removeEventListener('comp-captcha-resolved', onResolved);
  }, [id, addToast, updateGlobal, epoch]);

  const acceptImagePaths = useCallback((paths, attemptedCount = paths?.length || 0) => {
    const validPaths = [...new Set((paths || []).filter(p => typeof p === 'string' && p.trim()))];
    if (validPaths.length === 0) {
      // Tell the user instead of silently doing nothing — the previous early
      // return left the empty-state UI looking unchanged, which is the exact
      // "nothing happened" failure mode this bug report described.
      if (attemptedCount > 0) {
        EventLogger.log(`[SellHub][${id}] Drop rejected: 0 supported images of ${attemptedCount} file(s)`);
        addToast({
          title: 'Unsupported file type',
          description: `Dropped ${attemptedCount} file(s) but none are supported images. Accepted: PNG, JPG, WEBP, GIF, HEIC, HEIF.`,
          type: 'error',
        });
      }
      return;
    }

    if (initialDropAcceptedRef.current || dropLockReason || processingRef.current || processingPriceRef.current) {
      EventLogger.log(`[SellHub][${id}] Drop rejected: hub already started`);
      addToast({
        title: 'Photos are locked',
        description: 'This marketplace module is tied to its original photos. Create a new marketplace module to use different photos.',
        type: 'info',
      });
      return;
    }

    initialDropAcceptedRef.current = true;
    EventLogger.log(`[SellHub][${id}] Drop accepted: ${validPaths.length}/${attemptedCount} images`);

    startAnalysisRef.current?.(validPaths);
  }, [addToast, dropLockReason, id]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (data.locked) return; // Locked nodes don't accept new drops
    if (platformsVerifying || inputDropsBlocked) return;

    const files = Array.from(e.dataTransfer?.files || []);
    // Log EVERY drop attempt up front (extensions + total count) so bug reports
    // can distinguish "drop never fired" from "drop fired but every file was
    // rejected by the regex" — the previous code only logged on success.
    const exts = files.map(f => (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '?').toLowerCase());
    EventLogger.log(`[SellHub][${id}] Drop attempt: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}]`);

    const imagePaths = files
      .filter(f => PRODUCT_IMAGE_EXT_RE.test(f.name))
      .map(f => f.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(f) : ''))
      .filter(Boolean);
    acceptImagePaths(imagePaths, files.length);
  }, [acceptImagePaths, data.locked, id, inputDropsBlocked, platformsVerifying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      if (data.locked) return;
      if (platformsVerifying || inputDropsBlocked) return;
      const files = e.detail?.files || [];
      const imagePaths = files
        .filter(f => PRODUCT_IMAGE_EXT_RE.test(f.filename || f.filePath || ''))
        .map(f => f.filePath)
        .filter(Boolean);
      EventLogger.log(`[SellHub][${id}] Document-node drop received: ${files.length} file(s)`);
      acceptImagePaths(imagePaths, files.length);
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [acceptImagePaths, data.locked, id, inputDropsBlocked, platformsVerifying]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    EventLogger.log(`[SellHub][${id}] reset from hubState=${hubState}`);

    // Bump epoch BEFORE anything else so any in-flight startAnalysis /
    // handleConfirmDraft promise settling after this point sees the mismatch
    // and skips its state update. This is what stops the "Window closed"
    // message from clobbering the revert a few seconds later.
    epoch.bump();

    // Actually cancel the backend pipeline. The IPC is fire-and-forget; the
    // backend's finally{} clears its own progress. We don't await it.
    window.electronAPI?.cancelNodeTask?.(id);

    // Revert intelligently: when aborting price research the user wants to
    // keep their draft (title/description/condition they already approved),
    // not start over from the drop zone. Only the analyzing step has no
    // product yet, so that one goes all the way back to 'empty'.
    const revertTo = (hubState === 'researching' || hubState === 'comps-ready') && data.product ? 'draft' : 'empty';

    // When reverting all the way to 'empty', also drop imagePaths. Otherwise
    // the auto-start effect would re-fire startAnalysis immediately on the
    // next render — `imagePaths > 0 && hubState === 'empty' && !errorMessage`
    // all still match, defeating the cancel and looping the backend task.
    const updates = {
      hubState: revertTo,
      errorMessage: null,
      isRateLimit: false,
      pendingComps: null,
    };
    if (revertTo === 'empty') updates.imagePaths = null;
    updateGlobal(id, updates);
    resetCompProgress();
    cleanupCompSourceCards();
    // Drop queued early-resolves — they belong to the cancelled run and
    // would otherwise leak into the next scrape's drain pass.
    pendingMergesRef.current.splice(0);
    setQueuedResolvesCount(0);
    processingRef.current = false;
    processingPriceRef.current = false;
  }, [data.locked, data.product, hubState, id, updateGlobal, cleanupCompSourceCards, epoch, resetCompProgress]);

  const nodeWidth = 280;
  const nodeHeight = hubState === 'empty'
    ? 140
    : hubState === 'draft' || hubState === 'priced'
      ? 320
      : hubState === 'comps-ready'
        ? 220
        : 120;

  // Running total from comp progress
  const totalComps = Object.values(compProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[SellHub][${id}] User clicked Dismiss Error`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
  }, [id, updateGlobal]);

  // "Try again" routes to whichever pipeline matches what just failed:
  //  - product present → re-run price research (handleConfirmDraft)
  //  - product missing but imagePaths present → re-run analysis
  const handleRetryFailed = useCallback(() => {
    if (data.locked) return;
    EventLogger.log(`[SellHub][${id}] User clicked Try Again on error banner`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
    if (data.product) {
      handleConfirmDraft();
    } else if (data.imagePaths?.length > 0) {
      startAnalysis(data.imagePaths);
    }
  }, [data.locked, data.product, data.imagePaths, id, updateGlobal, handleConfirmDraft, startAnalysis]);

  const banner = data.errorMessage ? (
    <HubErrorBanner
      errorMessage={data.errorMessage}
      isRateLimit={!!data.isRateLimit}
      locked={!!data.locked}
      onRetry={handleRetryFailed}
      onDismiss={handleDismissError}
    />
  ) : null;

  return (
    <HubContainer
      hubState={hubState}
      theme="amber"
      width={nodeWidth}
      height={undefined}
      minHeight={nodeHeight}
      onDrop={handleDrop}
      dropsBlocked={platformsVerifying || inputDropsBlocked}
      verifyProgress={platformsVerifying ? { done: verifyDone, total: verifyTotal } : null}
      dragHover={data.dragHover || null}
    >
        {/* ── Empty: drop zone (+ banner if a prior attempt failed) ─────── */}
        {hubState === 'empty' && (
          <>
            {banner}
            <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
              <Camera size={28} className="text-emerald-400/40 mb-3" />
              {platformsVerifying ? (
                <>
                  <p className="text-white/40 text-sm font-medium">Checking connections…</p>
                  <p className="text-white/20 text-[10px] mt-1">Verifying marketplace logins</p>
                </>
              ) : inputDropsBlocked ? (
                <>
                  <p className="text-white/40 text-sm font-medium">Photos locked</p>
                  <p className="text-white/25 text-[10px] mt-1 text-center">Create a new marketplace module for different photos</p>
                </>
              ) : (
                <>
                  <p className="text-white/40 text-sm font-medium">Drop product photos</p>
                  <p className="text-white/20 text-[10px] mt-1">AI identifies & prices</p>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Analyzing ──────────────────────────────────────────────────── */}
        {hubState === 'analyzing' && (
          <HubBusyState
            theme="amber"
            label="AI analyzing photos..."
            subline={`${data.imagePaths?.length || 0} photo(s)`}
            onReset={resetHandler}
          />
        )}

        {/* ── Draft: editable product info (+ banner if research failed) ─ */}
        {hubState === 'draft' && (
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
            />
          </>
        )}

        {/* ── Researching ────────────────────────────────────────────────── */}
        {hubState === 'researching' && (
          <HubBusyState
            theme="amber"
            label="Researching market prices..."
            subline={totalComps > 0 ? `${totalComps} similar listing${totalComps === 1 ? '' : 's'} found` : null}
            onReset={resetHandler}
          />
        )}

        {/* ── Comps Ready: scrape finished but some sources blocked ─────── */}
        {/* Pauses before AI synthesis so the user can solve captchas (cards
            already show Solve buttons) or skip and price with partial data. */}
        {hubState === 'comps-ready' && (
          <SellHubCompsReadyDecision
            scrapeWarnings={data.scrapeWarnings || []}
            pendingComps={data.pendingComps || { sold: [], active: [] }}
            onCancel={resetHandler}
          />
        )}

        {/* ── Priced: price + platform controls ──────────────────────────── */}
        {hubState === 'priced' && (
          <SellHubPricedState
            product={product}
            pricing={data.pricing}
            comps={data.comps}
            scrapeWarnings={data.scrapeWarnings || []}
            justificationExpanded={justificationExpanded}
            toggleJustification={toggleJustification}
            locked={!!data.locked}
            imagePaths={data.imagePaths || []}
            onReresearch={handleConfirmDraft}
            spawnedMarketplaceIds={spawnedMarketplaceIds}
            onSpawnMarketplaceCard={handleSpawnMarketplaceCard}
            onCheckAllStatuses={handleCheckAllStatuses}
            checkingAll={checkingAll}
            platformFit={data.platformFit || null}
            platformFitPending={!!data.platformFitPending}
          />
        )}
      </HubContainer>
  );
}
