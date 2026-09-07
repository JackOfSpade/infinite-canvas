import React, { useState, useRef, useEffect, useCallback, useContext, useMemo } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { usePlatformsVerifyingProgress } from '../contexts/useSessionStatus';
import { HubContainer } from '../components/HubContainer';
import { Camera } from 'lucide-react';
import { ACTIVE_COMP_SOURCES, SELL_PLATFORMS } from '../utils/constants';
import { normalizeCompWarnings } from '../utils/compSourceScope';
import { radialRadius } from '../utils/layoutGeometry';
import { useListingActions } from '../hooks/useListingActions';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { HubBusyState } from '../components/HubBusyState';
import { SellHubDraftState } from './sellhub/SellHubDraftState';
import { SellHubPricedState } from './sellhub/SellHubPricedState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { SellHubCompsReadyDecision } from './sellhub/SellHubCompsReadyDecision';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation, isNodeDeletedAbort } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { filesToProductImagePaths, summarizeFileExtensions } from '../utils/fileDropUtils';
import { mergeSourceIntoComps, retryWarningRequiringAction, updateResolvedSourceWarning } from '../utils/compsMerge';
import { buildFinalListingTitle, buildRefreshResearchItems, computeBundleTotal, recoverRefreshExtraItems, selectBundleHeadline, selectListingPriceTiers } from '../utils/bundlePricing';
import { generateId } from '../utils/idGenerator';
import { canSellHubReplaceFailedInitialPhotos, getHubDropLockReason } from '../utils/hubDropEligibility';
import { appendPhotoPaths, normalizePhotoPathList, removePhotoPathAt } from '../utils/photoPathList';
import { enqueueUniqueSourceResolve } from '../utils/sourceResolveQueue';
import { getRequiredCompLoginPlatformIds } from '../utils/marketplaceLoginPreflight';
import {
  normalizePriceDropMustSellDate,
  normalizePriceDropReminderWeeks,
  normalizePriceDropStartingPrice,
  normalizePriceDropStartingTier,
  normalizePriceDropTargetPrice,
  oldestPriceDropCardCreatedAtIso,
  priceDropStartingPrice,
} from '../utils/priceDropReminder';
import { getConnectedHubCards } from '../utils/connectedHubCards';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { useRenderStorm } from '../hooks/useRenderStorm';

/**
 * SellHubNode — draggable canvas module for marketplace selling.
 *
 * data.hubState: 'empty' | 'queued' | 'analyzing' | 'draft' | 'researching' | 'priced' | 'comps-ready'
 *   Failures set errorMessage (surfaced via HubErrorBanner) but stay in the
 *   logical step rather than wiping to a dedicated error wall.
 * data.imagePaths: string[]
 * data.product: { brand, model, generated_title, generated_description, condition, category }
 * data.pricing: { recommended_price, quick_sell_price, max_profit_price, justification, market_summary }
 * data.comps: { sold: [], active: [] }
 * data.errorMessage: string | null — surfaced inline via HubErrorBanner above the body
 * data.isRateLimit: boolean
 */
function isOversizedImageError(message) {
  return /image file too large/i.test(String(message || ''));
}

// Comp-source cards linger as a visual "all sources done" summary, then the
// CLEAN ones dismiss together this long after EVERY card has reached a terminal
// state — instead of each clean card popping away on its own 3s timer. Mirrors
// Job Search Module (SOURCE_CARD_DISMISS_GRACE_MS / job-source-dismiss-clean).
// Purely visual: synthesis/pricing already ran independently, so this never
// gates the AI analysis. Blocked/errored/warned cards stay actionable.
const COMP_CARD_DISMISS_GRACE_MS = 10_000;
const TERMINAL_COMP_STATUSES = new Set(['done', 'error', 'skipped']);

function formatPriceDropLogPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'off';
  const rounded = Math.round(price * 100) / 100;
  return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}

export const SellHubNode = React.memo(function SellHubNode({ id, data }) {

  // Surface runaway re-render bursts (effect/state loops, unstable props) in bug
  // reports — otherwise re-render churn is invisible.
  useRenderStorm(`sellhub ${String(id).slice(0, 8)}`);

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const moduleRunQueue = useModuleRunQueue();
  const { addToast } = useToast();
  const processingRef = useRef(false);
  const processingPriceRef = useRef(false);
  const scrapeInFlightRef = useRef(false);
  const resolveDrainInFlightRef = useRef(false);
  const pendingMergesRef = useRef([]);
  const activeResolveSourceIdsRef = useRef(new Set());
  const initialDropAcceptedRef = useRef(false);
  const isMountedRef = useIsMountedRef();
  // Cancellation epoch — see hooks/useEpochCancellation.js. In-flight async
  // workflows (startAnalysis / handleConfirmDraft / synthesizeAndPrice)
  // call `epoch.start()` and re-check `cancelled()` after each await so a
  // user-triggered reset (which bumps the epoch) doesn't get clobbered by
  // a late settlement.
  const epoch = useEpochCancellation();
  // Stable ref so handleDrop always calls the latest startAnalysis without needing deps.
  const startAnalysisRef = useRef(null);
  const {
    product, editing, setEditing, justificationExpanded,
    handleFieldEdit, handlePricingNotesChange, toggleJustification,
    scrapePriceComps, rescrapeSource, synthesizePrice, synthesizeBundlePrice,
  } = useListingActions(id, data);

  // ── Phase-2 marketplace cards ──────────────────────────────────────────
  // Each platform the user is selling on becomes its own canvas node spawned
  // from here and connected by an edge. Status monitoring is no longer per-card
  // or hub-driven — a Marketplace Status Module checks each platform's aggregate
  // notification hub instead (see MarketplaceStatusNode).

  // Query the WHOLE canvas (not just edge-connected) by hubId backlink so a
  // user who detached a card can't accidentally double-spawn the same
  // platform. With the hub→card edge now locked non-deletable on spawn, true
  // orphans only exist for pre-this-change cards — those fall back to manual
  // delete + respawn, which is fine.
  // Read through the store rather than a render-time getNodes() snapshot:
  // spawning a sibling card leaves this hub's own node reference untouched, so
  // a snapshot would never pick up the 2nd/3rd platform and its button would
  // keep rendering as unspawned. Selected as a joined string so the default
  // Object.is comparison doesn't see a fresh array on every store update.
  const spawnedMarketplaceSignature = useStore(
    useCallback((s) => s.nodes
      .filter(n => n.type === 'marketplacecard' && n.data?.hubId === id)
      .map(n => n.data?.platformId)
      .filter(Boolean)
      .sort()
      .join('|'), [id])
  );
  const spawnedMarketplaceIds = useMemo(
    () => (spawnedMarketplaceSignature ? spawnedMarketplaceSignature.split('|') : []),
    [spawnedMarketplaceSignature]
  );
  const priceDropScheduleStartedAt = useStore(
    useCallback((s) => oldestPriceDropCardCreatedAtIso(getConnectedHubCards({
      nodes: s.nodes,
      edges: s.edges,
      hubId: id,
      cardType: 'marketplacecard',
    })), [id])
  );

  const handleSpawnMarketplaceCard = useCallback((platformId) => {
    if (data.locked) return;
    // Re-query live at click time instead of trusting the subscribed
    // spawnedMarketplaceIds closure — a rapid re-click can land before the
    // store update has re-rendered this hub, so only a live read rules out a
    // double spawn (mirrors handleApplyPriceDropPlanToAll's live getNodes()
    // re-query below).
    const alreadySpawned = getNodes().some(n => (
      n.type === 'marketplacecard' && n.data?.hubId === id && n.data?.platformId === platformId
    ));
    if (alreadySpawned) return;
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
    const bundleHeadline = selectBundleHeadline(data.bundlePricing, data.bundleTotal).headline;
    const finalListingTitle = buildFinalListingTitle(product, data.itemPricings);
    const newNode = {
      id: cardId,
      type: 'marketplacecard',
      position: { x: hubPos.x + 400, y: hubPos.y + index * 260 },
      data: {
        platformId,
        hubId: id,
        listingUrl: '',
        notes: '',
        status: 'unknown',
        // Price-drop reminder anchor — shown on the card and aged against
        // this hub's priceDropReminderWeeks (see priceDropReminder.js).
        createdAt: new Date().toISOString(),
        productSnapshot: {
          title: finalListingTitle,
          price: bundleHeadline ?? data.pricing?.recommended_price ?? null,
        },
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
    data.locked, data.bundlePricing, data.bundleTotal, data.itemPricings, id, getNode, getNodes, product, data.pricing?.recommended_price,
    addElementsGlobally, addNodes, addEdges,
  ]);


  // Surfaced via EventLogger.registerNodeState so bug reports show whether
  // captcha-resolve work is queued or actively being applied. Previously this
  // state was invisible, which made "I solved all the cards but it still said
  // 1 left" reports hard to diagnose.
  const [queuedResolvesCount, setQueuedResolvesCount] = useState(0);
  const [isApplyingResolves, setIsApplyingResolves] = useState(false);
  // "Waiting behind N price check(s)" — the backend serializes sell-side browser
  // ops (marketplaceBrowserLock); a queued op emits queuedBehind>0, then 0 once
  // it acquires the shared browser.
  const [queueWait, setQueueWait] = useState(0);
  const [resolveQueueWait, setResolveQueueWait] = useState(0);

  const syncResolveWorkCount = useCallback(() => {
    setQueuedResolvesCount(pendingMergesRef.current.length + activeResolveSourceIdsRef.current.size);
    // Broadcast per-source resolve state to the comp-source cards so a Retry that
    // is queued behind another source's active drain greys out + reads "Queued…"
    // (and "Retrying…" once it's picked up) instead of staying a live, re-clickable
    // Retry button. This is the single choke point for every mutation of the resolve
    // queue (queueSourceResolve + the drain loop + the reset sites all call it), so
    // the cards see every transition. Each event carries the FULL authoritative
    // snapshot (active[] + queued[]) — the card just takes the last event, no
    // per-card coalescing/dedup needed. Reset sites clear the refs then call this,
    // so the empty-arrays broadcast un-greys a card on Cancel/Refresh (no hang).
    document.dispatchEvent(new CustomEvent('comp-source-resolve-state', {
      detail: {
        hubId: id,
        active: Array.from(activeResolveSourceIdsRef.current),
        queued: pendingMergesRef.current.map(q => q?.sourceId).filter(Boolean),
      },
    }));
  }, [id]);

  const queueSourceResolve = useCallback((entry) => {
    const result = enqueueUniqueSourceResolve(
      pendingMergesRef.current,
      entry,
      activeResolveSourceIdsRef.current,
    );
    pendingMergesRef.current = result.queue;
    syncResolveWorkCount();
    return result.status;
  }, [syncResolveWorkCount]);

  const hubState = data.hubState || 'empty';
  // Refs bridge persisted node data / hub state into async event handlers so
  // back-to-back resolve or skip events see the latest synchronous transition
  // before React has flushed updateGlobal.
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const pendingItemsRef   = useRef(data.pendingItems);
  const hubStateRef       = useRef(hubState);
  const researchItemsRef  = useRef(null);
  // Sources the user explicitly skipped this run (vs. still-blocked ones in
  // scrapeWarningsRef) — kept aside instead of discarded so the eventual
  // synthesizeAndPrice call still reports what pricing went ahead without.
  const skippedWarningsRef = useRef([]);
  useEffect(() => { scrapeWarningsRef.current = data.scrapeWarnings; }, [data.scrapeWarnings]);
  useEffect(() => { pendingItemsRef.current   = data.pendingItems;   }, [data.pendingItems]);
  useEffect(() => { hubStateRef.current       = hubState;            }, [hubState]);
  useEffect(() => {
    researchItemsRef.current = buildRefreshResearchItems(data.product, data.extraItems, data.itemPricings, data.pricingNotes);
  }, [data.product, data.extraItems, data.itemPricings, data.pricingNotes]);

  const canReplaceFailedInitialPhotos = canSellHubReplaceFailedInitialPhotos({ type: 'sellhub', data });
  const dropLockReason = getHubDropLockReason({ type: 'sellhub', data });
  const inputDropsBlocked = !!dropLockReason;
  const displayPhotoDropMode = hubState === 'priced' && !data.locked;
  const { verifying: platformsVerifying, done: verifyDone, total: verifyTotal } = usePlatformsVerifyingProgress(['ebay', 'poshmark', 'mercari', 'swappa', 'facebook']);
  const hubDropsBlocked = platformsVerifying || (inputDropsBlocked && !displayPhotoDropMode);

  useEffect(() => {
    if (canReplaceFailedInitialPhotos) {
      initialDropAcceptedRef.current = false;
      return;
    }
    if (data.inputLocked || data.product || data.imagePaths?.length > 0) {
      initialDropAcceptedRef.current = true;
    }
  }, [canReplaceFailedInitialPhotos, data.inputLocked, data.product, data.imagePaths]);

  // Per-source comp progress populated from backend `price-source-progress`
  // events. Reset before each fresh run so stale counts don't bleed in.
  const {
    progress: compProgress,
    reset: resetCompProgress,
  } = useSourceProgress(window.electronAPI?.onPriceSourceProgress, id);

  // Subscribe to the serialization queue status so the hub can show a transient
  // "waiting behind N" banner while another sell-side browser op runs first.
  useEffect(() => {
    const sub = window.electronAPI?.onPriceQueueStatus;
    if (!sub) return undefined;
    const cleanup = sub((payload) => {
      if (payload?.nodeId && payload.nodeId !== id) return;
      // Hub banner is for the hub-level price-check scrape. Resolved-source
      // rescrapes carry sourceId; mirror their browser wait while the hub is in
      // the "applying resolved sources" state because the card may have already
      // auto-dismissed or be offscreen.
      if (payload?.sourceId) {
        setResolveQueueWait(payload?.queuedBehind || 0);
        return;
      }
      setQueueWait(payload?.queuedBehind || 0);
    });
    return () => cleanup?.();
  }, [id]);

  // Surface the live ring state to the bug-report snapshot so reports like
  // "old comps circle is still showing" can be diagnosed from the report alone
  // (otherwise compProgress is only visible to the user's eyes).
  useEffect(() => {
    EventLogger.registerNodeState(id, {
      hubState,
      compProgress,
      queuedResolvesCount,
      isApplyingResolves,
      queueWait,
      resolveQueueWait,
      queuedResolveSourceIds: pendingMergesRef.current.map(q => q?.sourceId).filter(Boolean),
      activeResolveSourceIds: Array.from(activeResolveSourceIdsRef.current),
    });
    return () => EventLogger.unregisterNodeState(id);
  }, [id, hubState, compProgress, queuedResolvesCount, isApplyingResolves, queueWait, resolveQueueWait]);

  // ── Coordinated comp-card dismissal (mirrors Job Search Module) ───────────
  // Keep every comp-source card visible as a set while the price check runs,
  // then dismiss the CLEAN ones together COMP_CARD_DISMISS_GRACE_MS after EVERY
  // card has reached a terminal state. The grace timer dispatches an event the
  // cards listen for; it is purely cosmetic and runs alongside (never before)
  // synthesis, so it cannot delay the AI pricing. Blocked cards ignore the event.
  const sourceDismissTimerRef = useRef(null);

  const scheduleCleanCompCardDismiss = useCallback((reason = 'all-sources-terminal') => {
    if (sourceDismissTimerRef.current) return; // idempotent — first all-terminal moment wins
    sourceDismissTimerRef.current = setTimeout(() => {
      sourceDismissTimerRef.current = null;
      document.dispatchEvent(new CustomEvent('comp-source-dismiss-clean', {
        detail: { hubId: id, reason },
      }));
    }, COMP_CARD_DISMISS_GRACE_MS);
  }, [id]);

  const cancelCleanCompCardDismiss = useCallback(() => {
    if (!sourceDismissTimerRef.current) return;
    clearTimeout(sourceDismissTimerRef.current);
    sourceDismissTimerRef.current = null;
  }, []);

  useEffect(() => {
    const sourceCards = getNodes().filter(n => n.type === 'compsourcecard' && n.data?.hubId === id);
    if (sourceCards.length === 0) {
      cancelCleanCompCardDismiss();
      return;
    }
    // Do not dismiss the source cards while the hub is still applying solved
    // source updates. In that state the visible captcha windows may be gone, but
    // the bundle-wide refetches are still the reason the hub is busy.
    if (isApplyingResolves || queuedResolvesCount > 0) {
      cancelCleanCompCardDismiss();
      return;
    }
    // All cards terminal (done/error/skipped) → start the grace timer. A card
    // still 'searching' (e.g. a live re-fetch after Solve) cancels it. Falls back
    // to persistedProgress so a save-quit-reopen in 'comps-ready' is handled too.
    const allVisibleCardsTerminal = sourceCards.every((node) => {
      const live = compProgress[node.data?.sourceId];
      const persisted = node.data?.persistedProgress;
      const persistedCleanTerminal = persisted?.status === 'done' && !persisted.warning;
      const effective = live?.status === 'searching'
        ? live
        : persistedCleanTerminal
          ? persisted
          : (live || persisted);
      return !!effective && TERMINAL_COMP_STATUSES.has(effective.status);
    });
    if (allVisibleCardsTerminal) {
      scheduleCleanCompCardDismiss();
    } else {
      cancelCleanCompCardDismiss();
    }
  }, [compProgress, id, getNodes, scheduleCleanCompCardDismiss, cancelCleanCompCardDismiss, isApplyingResolves, queuedResolvesCount]);


  const startAnalysis = useCallback(async (imagePaths) => {
    // Ensure no null/empty paths slip through
    const validPaths = (imagePaths || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPaths.length === 0 || !window.electronAPI || processingRef.current) return;

    processingRef.current = true;
    const currentId = id;
    // Capture epoch so a later resetHandler can invalidate this attempt's
    // settlement. Also clear any leftover errorMessage so a successful run
    // doesn't leave a stale banner around after the next render.
    const cancelled = epoch.start();
    let lease = null;

    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'marketplace',
        label: 'Marketplace photo analysis',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Analyzing photos', position },
            imagePaths: validPaths,
            inputLocked: true,
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Analyzing photos', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          resetCompProgress();
          updateGlobal(currentId, {
            hubState: 'analyzing',
            queuedModuleRun: null,
            imagePaths: validPaths,
            inputLocked: true,
            errorMessage: null,
            isRateLimit: false,
          });
        },
      });

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
      const message = error?.message || String(error);
      const updates = {
        hubState: 'empty',
        errorMessage: message,
        isRateLimit: !!error?.isRateLimit,
      };
      if (isOversizedImageError(message)) {
        updates.imagePaths = null;
        updates.inputLocked = false;
        initialDropAcceptedRef.current = false;
      }
      updateGlobal(currentId, updates);
      addToast({ title: 'Photo Analysis Failed', description: message, type: 'error' });
    } finally {
      lease?.release();
      if (isMountedRef.current) {
        processingRef.current = false;
      }
    }
  }, [id, updateGlobal, addToast, epoch, resetCompProgress, moduleRunQueue, isMountedRef]);

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
  // 'comps-ready' state. Individual cards self-manage in normal flow: clean
  // cards dismiss together ~10s after every card is terminal (the hub fires
  // `comp-source-dismiss-clean`); warned/errored cards stick around until the
  // user clicks Solve or Skip on them.
  const cleanupCompSourceCards = useCallback(() => {
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['compsourcecard'],
    });
    // A pending grace-dismiss timer from the PREVIOUS batch (see
    // scheduleCleanCompCardDismiss) is idempotent — it won't rearm for a new
    // batch while the old one is still ticking. Cards this call just deleted
    // can't be dismissed by it anyway, so cancel it here so a fresh batch
    // spawned moments later (e.g. Cancel from comps-ready, then immediately
    // Confirm & Research again) gets its own full 10s grace instead of
    // inheriting whatever was left on the old run's clock.
    cancelCleanCompCardDismiss();
  }, [id, getNodes, getEdges, deleteElements, cancelCleanCompCardDismiss]);

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
  useUnmountEffect(() => {
    moduleRunQueue.cancelQueuedRunsForNode(id);
  });
  // The clean-card dismissal grace timer (see scheduleCleanCompCardDismiss)
  // otherwise outlives the component: if the hub unmounts while a batch of
  // clean comp cards is mid-grace, the pending setTimeout fires ~10s later
  // into a torn-down node with nothing listening for its event.
  useUnmountEffect(cancelCleanCompCardDismiss);

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
  const synthesizeAndPrice = useCallback(async (items, scrapeWarnings, cancelled) => {
    const currentId = id;
    try {
      // The comp snapshot is final once AI pricing starts. Remove every source
      // card so a stale Solve/Retry action cannot misleadingly appear to affect
      // the price after the only early-resolve drain point has passed.
      scrapeInFlightRef.current = false;
      resolveDrainInFlightRef.current = false;
      pendingMergesRef.current.splice(0);
      activeResolveSourceIdsRef.current.clear();
      setIsApplyingResolves(false);
      syncResolveWorkCount();   // -> count 0 + broadcast empty snapshot so any card queued on this run un-greys
      setResolveQueueWait(0);
      cleanupCompSourceCards();

      // Price each item independently (its own comps / query / condition), then
      // sum into a suggested bundle total. Item 0 is always the primary
      // (AI-analyzed) product, so it uses the product-derived defaults.
      const itemPricings = [];
      for (const it of items) {
        const comps = it.comps || { sold: [], active: [] };
        const compCount = (comps.sold?.length || 0) + (comps.active?.length || 0);
        // No comps → skip the AI call entirely (don't spend tokens to be told
        // "no listings"); stamp a canned empty result instead.
        if (compCount === 0) {
          itemPricings.push({
            key: it.key, label: it.label, query: it.query, condition: it.condition, pricingNotes: it.pricingNotes || '', comps,
            pricing: { recommended_price: null, justification: 'No similar listings found — set your own price.', market_summary: { sold_count: 0, active_count: 0 }, recommended_platforms: [] },
          });
          continue;
        }
        // Primary keeps its product-derived defaults (its notes come from
        // data.pricingNotes inside the hook). Each EXTRA passes its OWN query,
        // condition, and pricing notes so it's priced as an independent item.
        const overrides = it.key === 'primary'
          ? { itemKey: it.key, itemLabel: it.label || it.query }
          : {
              itemKey: it.key,
              itemLabel: it.label || it.query,
              query: it.query,
              condition: it.condition,
              productSpec: { title: it.label || it.query },
              pricingNotes: it.pricingNotes || '',
            };
        const synthResult = await synthesizePrice(comps, overrides);
        if (cancelled()) return;
        itemPricings.push({
          key: it.key,
          label: it.label,
          query: it.query,
          condition: it.condition,
          pricingNotes: it.pricingNotes || '',
          pricing: synthResult.pricing,
          comps,
        });
      }
      const primary = itemPricings[0];
      const isBundle = itemPricings.length > 1;
      // Arithmetic sum of the per-item prices — kept as the reference figure AND
      // the fallback if the AI combine call is unavailable or fails.
      const bundleTotal = isBundle ? computeBundleTotal(itemPricings) : null;
      // AI combine: ask for attributable bundle/tier pricing factors, then the
      // backend deterministically derives every whole-listing price from them.
      // Non-fatal: on any failure we keep bundleTotal as the headline.
      let bundlePricing = null;
      const pricedItemCount = itemPricings.filter((it) => {
        const price = Number(it.pricing?.recommended_price);
        return it.pricing?.recommended_price !== null
          && it.pricing?.recommended_price !== undefined
          && it.pricing?.recommended_price !== ''
          && Number.isFinite(price)
          && Math.round(price * 100) / 100 > 0;
      }).length;
      const unpricedItemCount = itemPricings.length - pricedItemCount;
      if (isBundle) {
        if (pricedItemCount >= 2 && window.electronAPI?.synthesizeBundlePrice) {
          try {
            bundlePricing = await synthesizeBundlePrice(
              itemPricings.map(it => ({
                label: it.label || it.query,
                condition: it.condition,
                recommended_price: it.pricing?.recommended_price ?? null,
                quick_sell_price: it.pricing?.quick_sell_price ?? null,
                max_profit_price: it.pricing?.max_profit_price ?? null,
                match_quality: it.pricing?.match_quality ?? null,
                reasoning: it.pricing?.justification ?? null,
                notes: it.pricingNotes || '',
              })),
              bundleTotal,
            );
            if (cancelled()) return;
          } catch (err) {
            EventLogger.error('[SellHub] Bundle price synthesis failed (using item sum):', err);
          }
        }
      }
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
        pricing: primary.pricing,
        comps: primary.comps,
        // Per-item breakdown drives the bundle UI; null for single-item so the
        // priced state renders exactly as before.
        itemPricings: isBundle ? itemPricings : null,
        bundleTotal,
        // Factor-derived combined price (null → UI falls back to bundleTotal).
        bundlePricing: isBundle ? bundlePricing : null,
        scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
        platformFit: null,
        platformFitPending: willAssessFit,
        errorMessage: null,
      });
      // Attached marketplace cards survive a price recheck. Refresh only their
      // listing snapshot so status checks use the new whole-bundle title/price;
      // card URLs, statuses, attention, and watch URLs remain untouched.
      const finalListingTitle = buildFinalListingTitle(data.product, itemPricings);
      const finalListingPrice = selectBundleHeadline(bundlePricing, bundleTotal).headline
        ?? primary.pricing?.recommended_price
        ?? null;
      for (const card of getNodes().filter(node => (
        node.type === 'marketplacecard' && node.data?.hubId === currentId
      ))) {
        updateGlobal(card.id, {
          productSnapshot: {
            ...(card.data?.productSnapshot || {}),
            title: finalListingTitle,
            price: finalListingPrice,
          },
        });
      }
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
      const rec = primary.pricing?.recommended_price;
      const warnCount = Array.isArray(scrapeWarnings) ? scrapeWarnings.length : 0;
      // Headline bundle figure = factor-derived price when available, else sum.
      const bundleHeadline = bundlePricing?.bundle_price ?? bundleTotal;
      const bundleScope = unpricedItemCount > 0
        ? ` for ${pricedItemCount} priced item${pricedItemCount === 1 ? '' : 's'} (${unpricedItemCount} unpriced excluded)`
        : '';
      addToast({
        title: 'Pricing Engine',
        description: isBundle
          ? (bundleHeadline != null
              ? `Bundle of ${itemPricings.length}: suggested $${bundleHeadline}${bundleScope}${bundlePricing?.synergy && bundlePricing.synergy !== 'neutral' ? ` (${bundlePricing.synergy} vs $${bundleTotal} apart)` : ''}${warnCount > 0 ? ` — ${warnCount} blocked source(s)` : ''}`
              : `${pricedItemCount > 0 ? `Priced ${pricedItemCount} of ${itemPricings.length} items` : 'No items could be priced'} — set your own total.`)
          : (rec != null
              ? `Recommended price: $${rec}${warnCount > 0 ? ` (synthesized without ${warnCount} blocked source(s))` : ''}`
              : 'No similar listings — set your own price.'),
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
  }, [id, updateGlobal, synthesizePrice, synthesizeBundlePrice, addToast, data.product, cleanupCompSourceCards, getNodes, syncResolveWorkCount]);

  const queueSynthesizeAndPrice = useCallback(async (items, scrapeWarnings, cancelled) => {
    let lease = null;
    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: id,
        kind: 'marketplace',
        label: 'Marketplace price synthesis',
        onQueued: ({ position }) => {
          updateGlobal(id, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Pricing resolved comps', position },
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(id, { queuedModuleRun: { label: 'Pricing resolved comps', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          updateGlobal(id, { hubState: 'researching', queuedModuleRun: null });
        },
      });
      await synthesizeAndPrice(items, scrapeWarnings, cancelled);
    } finally {
      lease?.release();
    }
  }, [id, moduleRunQueue, synthesizeAndPrice, updateGlobal]);

  // Merge a (re)solved comp source back into per-item comps. SINGLE item →
  // inline-extracted items are preferred (cheap, and avoids re-hitting
  // fingerprinting sites like Mercari with a headless rescrape). BUNDLE →
  // rescrape that source for EVERY item, since the inline extract only covers
  // the one query whose captcha window was solved. Returns the updated items
  // plus any warning that still remains after the retry. A bundle source is only
  // resolved when it succeeded for EVERY item.
  const mergeResolvedSource = useCallback(async (items, researchItems, {
    sourceId,
    inlineItems,
    category,
    warning: resolvedWarning,
    noChallengeConfirmed = false,
  }, cancelled) => {
    if (items.length <= 1) {
      let useItems = Array.isArray(inlineItems) ? inlineItems : null;
      let cat = category;
      let rawWarning = resolvedWarning || null;
      // noChallengeConfirmed only holds for the INLINE result (the visible Solve
      // window). A headless rescrape is a fresh fetch with no such proof, so a
      // fallback rescrape must re-arm the normal gate.
      let usedInline = !!useItems;
      if (!useItems) {
        const r = await rescrapeSource(sourceId);
        useItems = r.items || [];
        cat = r.category || cat;
        rawWarning = r.warning;
      }
      const retryWarning = retryWarningRequiringAction(rawWarning, useItems, { noChallengeConfirmed: noChallengeConfirmed && usedInline });
      if (cancelled()) return { items, warning: retryWarning };
      const base = items[0] || { comps: { sold: [], active: [] } };
      return {
        items: [{ ...base, comps: mergeSourceIntoComps(base.comps || { sold: [], active: [] }, { sourceId, category: cat || 'sold', items: useItems }) }],
        warning: retryWarning ? { ...retryWarning, sourceId } : null,
      };
    }
    // Pass noChallengeConfirmed so the backend's aggregate progress event clears
    // too (it re-derives the per-item verdict). The visible Solve proved this
    // host/session has no anti-bot wall — a property that holds for EVERY item
    // query on the same host this session, so a genuinely-empty item (e.g. a
    // vacuum on Swappa, which sells only electronics) is the page's real answer,
    // not a block to re-arm. Without this a multi-item bundle whose source is
    // truly empty stays stuck in error/retry-empty forever (the "swappa/ebay
    // unable to finish" report) — the single-item path already trusts this proof.
    const res = await rescrapeSource(sourceId, researchItems.map(ri => ({ key: ri.key, query: ri.query })), noChallengeConfirmed);
    if (cancelled()) return { items, warning: null };
    const perItem = Array.isArray(res.perItem) ? res.perItem : [];
    const mergedItems = items.map((it, k) => {
      const pi = perItem[k];
      if (!pi || !Array.isArray(pi.items)) return it;
      return { ...it, comps: mergeSourceIntoComps(it.comps || { sold: [], active: [] }, { sourceId, category: pi.category || category || 'sold', items: pi.items }) };
    });
    const failedWarnings = perItem
      .map(pi => retryWarningRequiringAction(pi?.warning, pi?.items, { noChallengeConfirmed }))
      .filter(Boolean);
    const missing = Math.max(0, items.length - perItem.length);
    const failedCount = failedWarnings.length + missing;
    const firstWarning = failedWarnings[0] || (missing > 0 ? {
      code: 'task-failed',
      severity: 'block',
      evidence: 'Retry returned no result for one or more bundle items.',
      suggestion: 'This source remains blocked. Retry again, or explicitly click Skip to continue without it.',
    } : null);
    const warning = firstWarning ? {
      ...firstWarning,
      sourceId,
      evidence: `${failedCount}/${items.length} bundle item retry attempt(s) still failed. ${firstWarning.evidence || ''}`.trim(),
    } : null;
    return { items: mergedItems, warning };
  }, [rescrapeSource]);

  const drainQueuedResolves = useCallback(async (items, researchItems, warnings, cancelled) => {
    let mergedItems = items;
    let effectiveWarnings = warnings;
    if (pendingMergesRef.current.length === 0) {
      return { items: mergedItems, warnings: effectiveWarnings };
    }

    cancelCleanCompCardDismiss();
    resolveDrainInFlightRef.current = true;
    setIsApplyingResolves(true);
    setResolveQueueWait(0);
    syncResolveWorkCount();
    try {
      // New Solve results can arrive while a bundle source is being retried.
      // Keep draining until the unique-source queue is empty so none are lost.
      while (pendingMergesRef.current.length > 0) {
        // Consume one entry at a time. Sources still waiting remain visible in
        // the unique-source queue, so another Solve result replaces that entry
        // instead of accidentally scheduling a duplicate retry.
        const q = pendingMergesRef.current.shift();
        activeResolveSourceIdsRef.current.add(q.sourceId);
        syncResolveWorkCount();
        EventLogger.log(`[SellHub][${id}] applying queued source resolve: ${q.sourceId}`);
        try {
          const mergeResult = await mergeResolvedSource(mergedItems, researchItems, q, cancelled);
          mergedItems = mergeResult.items;
          if (cancelled()) return { items: mergedItems, warnings: effectiveWarnings, cancelled: true };
          effectiveWarnings = updateResolvedSourceWarning(effectiveWarnings, q.sourceId, mergeResult.warning);
        } finally {
          activeResolveSourceIdsRef.current.delete(q.sourceId);
          syncResolveWorkCount();
        }
      }
      return { items: mergedItems, warnings: effectiveWarnings };
    } finally {
      resolveDrainInFlightRef.current = false;
      setIsApplyingResolves(false);
      setResolveQueueWait(0);
      syncResolveWorkCount();
    }
  }, [id, mergeResolvedSource, syncResolveWorkCount, cancelCleanCompCardDismiss]);

  // ── Additional items packaged into this one listing (bundle research) ─────
  // The primary item comes from the AI photo analysis (data.product); these are
  // user-typed extras (kayak + paddle), each priced on its own complete pass.
  const extraItems = useMemo(() => (Array.isArray(data.extraItems) ? data.extraItems : []), [data.extraItems]);
  const handleAddExtraItem = useCallback(() => {
    updateGlobal(id, { extraItems: [...(data.extraItems || []), { id: generateId(), generated_title: '', brand: '', model: '', condition: data.product?.condition || 'Used - Good', pricingNotes: '' }] });
  }, [id, data.extraItems, data.product, updateGlobal]);
  const handleEditExtraItem = useCallback((itemId, patch) => {
    const clearsGeneratedQuery = ['generated_title', 'brand', 'model'].some(field => Object.prototype.hasOwnProperty.call(patch || {}, field))
      && !Object.prototype.hasOwnProperty.call(patch || {}, 'search_query');
    updateGlobal(id, {
      extraItems: (data.extraItems || []).map(it => (
        it.id === itemId
          ? { ...it, ...patch, ...(clearsGeneratedQuery ? { search_query: '' } : {}) }
          : it
      )),
    });
  }, [id, data.extraItems, updateGlobal]);
  const handleRemoveExtraItem = useCallback((itemId) => {
    updateGlobal(id, { extraItems: (data.extraItems || []).filter(it => it.id !== itemId) });
  }, [id, data.extraItems, updateGlobal]);

  const handleConfirmDraft = useCallback(async () => {
    if (processingPriceRef.current || !data.product) return;
    processingPriceRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();
    let lease = null;

    try {
      // Check the same cached marketplace sessions as the backend first so a
      // login-blocked request does not start work that the backend will reject.
      const requiredLoginIds = getRequiredCompLoginPlatformIds(ACTIVE_COMP_SOURCES);
      const missingLogins = (await Promise.all(
        requiredLoginIds.map(async (platformId) => {
          const res = await window.electronAPI?.checkSellMonitorAuth?.({ platformId });
          return res?.connected ? null : platformId;
        }),
      )).filter(Boolean);
      if (cancelled()) return;
      if (missingLogins.length > 0) {
        hubStateRef.current = 'draft';
        updateGlobal(currentId, {
          hubState: 'draft',
          errorMessage: `Price check needs login on: ${missingLogins.join(', ')}. Log in (Settings → Accounts) and re-run.`,
          isRateLimit: false,
          pendingItems: null,
          scrapeWarnings: [],
          platformFit: null,
          platformFitPending: false,
        });
        addToast({
          title: 'Log in to run a price check',
          description: `Not logged in: ${missingLogins.join(', ')}. Your canvas view was left unchanged.`,
          type: 'warning',
        });
        return;
      }

      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'marketplace',
        label: 'Marketplace price research',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Researching market prices', position },
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Researching market prices', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          hubStateRef.current = 'researching';
          scrapeInFlightRef.current = true;
          resolveDrainInFlightRef.current = false;
          pendingMergesRef.current.splice(0);
          activeResolveSourceIdsRef.current.clear();
          pendingItemsRef.current = null;
          scrapeWarningsRef.current = [];
          skippedWarningsRef.current = [];
          setIsApplyingResolves(false);
          setResolveQueueWait(0);
          syncResolveWorkCount();
          resetCompProgress();
          spawnCompSourceCards();
          updateGlobal(currentId, {
            hubState: 'researching',
            queuedModuleRun: null,
            errorMessage: null,
            isRateLimit: false,
            pendingItems: null,
            platformFit: null,
            platformFitPending: false,
          });
        },
      });

      // Primary item (from the AI photo analysis) + any user-added extras —
      // each gets its OWN complete pass through the comp sources server-side.
      const researchItems = buildRefreshResearchItems(data.product, data.extraItems, data.itemPricings, data.pricingNotes);
      const scrapeResult = await scrapePriceComps(researchItems);
      scrapeInFlightRef.current = false;
      if (cancelled()) return;

      // Hard login preflight (policy): the backend blocked the run because one or
      // more in-scope marketplaces aren't logged in. Terminal "log in first" state
      // — no synthesis and no Skip (unlike a resolvable per-source block). Return
      // to 'draft' so logging in (Settings > Accounts) and re-confirming re-runs.
      if (scrapeResult.preflightBlocked) {
        const missing = Array.isArray(scrapeResult.missingLogins) ? scrapeResult.missingLogins : [];
        hubStateRef.current = 'draft';
        updateGlobal(currentId, {
          hubState: 'draft',
          errorMessage: `Price check needs login on: ${missing.join(', ')}. Log in (Settings → Accounts) and re-run.`,
          isRateLimit: false, pendingItems: null, scrapeWarnings: [],
          platformFit: null, platformFitPending: false,
        });
        addToast({
          title: 'Log in to run a price check',
          description: `Not logged in: ${missing.join(', ')}. This run requires login on all in-scope marketplaces.`,
          type: 'warning',
        });
        return;
      }

      // Zip each item's metadata (query/condition/label) with the per-item comps
      // the backend returned (same order) so the gate + synthesis know which set
      // belongs to which item.
      const scrapedItems = Array.isArray(scrapeResult.items) ? scrapeResult.items : [];
      let pendingItems = researchItems.map((ri, k) => ({
        key: ri.key, label: ri.label, query: ri.query, condition: ri.condition, pricingNotes: ri.pricingNotes,
        comps: scrapedItems[k]?.comps || { sold: [], active: [] },
      }));

      // Preserve one warning per exact source. Every backend comp source has its
      // own card, so no source can be folded into another or silently dropped.
      // Warnings are the union across items (a source blocked in ANY item → one
      // card that retries that source across the whole bundle).
      let effectiveWarnings = normalizeCompWarnings(
        Array.isArray(scrapeResult.scrapeWarnings) ? scrapeResult.scrapeWarnings : [],
        ACTIVE_COMP_SOURCES.map(s => s.id),
      );

      // Drain any captcha-resolves that landed during the scrape (fast user).
      // Each clears its source from the warnings + merges recovered comps into
      // every item.
      if (pendingMergesRef.current.length > 0) {
        const drained = await drainQueuedResolves(pendingItems, researchItems, effectiveWarnings, cancelled);
        if (drained.cancelled || cancelled()) return;
        pendingItems = drained.items;
        effectiveWarnings = drained.warnings;
      }

      // Branch: any blocked source → pause and ask the user (Solve/Skip on the
      // cards). AI synthesis is skipped here so we don't spend tokens on partial
      // data without consent.
      if (effectiveWarnings.length > 0) {
        hubStateRef.current = 'comps-ready';
        pendingItemsRef.current = pendingItems;
        scrapeWarningsRef.current = effectiveWarnings;
        updateGlobal(currentId, {
          hubState: 'comps-ready',
          pendingItems,
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

      // All clean → price every item. Items with no comps are stamped "set your
      // own price" without an AI call (handled inside synthesizeAndPrice).
      await synthesizeAndPrice(pendingItems, effectiveWarnings, cancelled);
    } catch (err) {
      if (cancelled() || isNodeDeletedAbort(err)) return;
      EventLogger.error('[SellHub] Price scrape failed:', err);
      hubStateRef.current = 'draft';
      updateGlobal(currentId, {
        hubState: 'draft',
        errorMessage: err?.message || String(err),
        isRateLimit: !!err?.isRateLimit,
      });
      addToast({ title: 'Scrape Error', description: err?.message || String(err), type: 'error' });
    } finally {
      scrapeInFlightRef.current = false;
      lease?.release();
      processingPriceRef.current = false;
      // Source cards are removed when synthesis begins; warned cards remain only
      // while the hub is paused in comps-ready awaiting Resolve/Skip.
    }
  }, [id, updateGlobal, scrapePriceComps, synthesizeAndPrice, addToast, data.product, data.extraItems, data.itemPricings, data.pricingNotes, drainQueuedResolves, spawnCompSourceCards, epoch, resetCompProgress, syncResolveWorkCount, moduleRunQueue]);

  // Per-source skip — fired by a comp card's Skip button. Drops the source
  // from data.scrapeWarnings, deletes the card, then if the warnings list
  // is empty AND we're still in 'comps-ready', auto-fires synthesis. This
  // is the per-card analogue of the old hub-level "Skip & price now"
  // button: each blocked source gets its own decision, and the AI call
  // only fires once every blocked source has been individually
  // resolved-or-skipped. Filtered by hubId so a multi-hub canvas doesn't
  // cross-trigger.
  //
  useEffect(() => {
    const onSkip = (e) => {
      if (e.detail?.hubId !== id) return;
      const skippedSourceId = e.detail?.sourceId;
      if (!skippedSourceId) return;

      const skippedWarning = (scrapeWarningsRef.current || []).find(w => w.sourceId === skippedSourceId);
      const remainingWarnings = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== skippedSourceId);
      // Mutate the ref synchronously so a SECOND skip event in the same
      // tick sees the post-first-skip list, not the stale closure value.
      scrapeWarningsRef.current = remainingWarnings;
      // Kept aside (not discarded) so the priced card can still report it was
      // synthesized without this source once every blocker clears.
      if (skippedWarning) skippedWarningsRef.current = [...skippedWarningsRef.current, skippedWarning];
      EventLogger.log(`[SellHub][${id}] user skipped ${skippedSourceId}; ${remainingWarnings.length} blocked source(s) remaining`);
      updateGlobal(id, { scrapeWarnings: remainingWarnings });

      // Delete the skipped card (and its edge, auto-pruned by ReactFlow).
      const cardNode = getNodes().find(n => n.type === 'compsourcecard' && n.data?.hubId === id && n.data?.sourceId === skippedSourceId);
      if (cardNode) deleteElements({ nodes: [{ id: cardNode.id }] });

      // If this was the last blocker AND we're still in the pause state,
      // auto-fire synthesis. The hubState check guards against firing
      // again after the user already moved on (e.g., already in 'priced').
      if (remainingWarnings.length === 0 && hubStateRef.current === 'comps-ready' && pendingItemsRef.current) {
        if (processingPriceRef.current) return;
        processingPriceRef.current = true;
        const cancelled = epoch.start();
        const items = pendingItemsRef.current;
        (async () => {
          try {
            await queueSynthesizeAndPrice(items, skippedWarningsRef.current, cancelled);
            updateGlobal(id, { pendingItems: null });
          } catch (err) {
            // acquireModuleRun rejects if this queued run is cancelled (reset/
            // delete) before it dequeues — an expected outcome, not a failure.
            if (cancelled() || isNodeDeletedAbort(err)) return;
            EventLogger.error(`[SellHub][${id}] Auto-fire synthesis after skip failed:`, err);
            hubStateRef.current = 'draft';
            updateGlobal(id, { hubState: 'draft', errorMessage: err?.message || String(err), isRateLimit: !!err?.isRateLimit });
            addToast({ title: 'Pricing Error', description: err?.message || String(err), type: 'error' });
          } finally {
            processingPriceRef.current = false;
          }
        })();
      }
    };
    document.addEventListener('comp-source-skip', onSkip);
    return () => document.removeEventListener('comp-source-skip', onSkip);
  }, [id, updateGlobal, getNodes, deleteElements, queueSynthesizeAndPrice, epoch, addToast]);

  // After a comp card's captcha-resolve window auto-detects the challenge as
  // cleared, refetch ONLY the unblocked source and merge into the pending items
  // (via mergeResolvedSource — inline for a single item, rescrape-per-item for a
  // bundle) instead of re-running the whole pipeline.
  //
  // Queue of resolves that landed BEFORE the scrape itself completed (per-
  // source-progress events fire mid-scrape, so a fast user can click Solve
  // and resolve a captcha while the rest of the scrape is still running).
  // Without queueing, those early resolves would be discarded by the
  // hubState guard, leaving the warning in scrapeWarnings and the hub
  // stuck in comps-ready with "1 left" even though the user solved
  // everything visible. Drained in handleConfirmDraft after the scrape
  // settles and pendingComps is initialized.
  useEffect(() => {
    const onResolved = async (e) => {
      if (e.detail?.hubId !== id) return;
      const resolvedSourceId = e.detail?.sourceId;
      if (!resolvedSourceId) return;

      const researchItems = researchItemsRef.current || [];
      const isBundle = researchItems.length > 1;
      // Inline items were extracted in the visible captcha session for the ONE
      // query whose window was solved — usable directly for a single-item
      // listing (and avoids re-hitting fingerprinting sites like Mercari). A
      // bundle needs the source for every item, so it ignores inline and
      // rescrapes per item (see mergeResolvedSource).
      const inlineItems = (!isBundle && Array.isArray(e.detail?.items)) ? e.detail.items : null;
      const category = e.detail?.category || 'sold';
      const resolvedWarning = e.detail?.warning || null;
      // Solve proved there was no challenge → a low/empty inline result is real,
      // not a block. Carried into mergeResolvedSource so the single-item gate
      // clears instead of re-deriving an unclearable 'retry-empty'.
      const noChallengeConfirmed = e.detail?.noChallengeConfirmed === true;

      // hubState guard:
      //  - 'researching' + scrape/resolve drain in flight: queue once per source
      //    so scrape completion cannot overwrite the result and a duplicate Solve
      //    click cannot launch the same long bundle rescrape twice.
      //  - 'researching' with neither active: AI pricing already started → discard.
      //  - 'comps-ready': normal path, merge below.
      //  - anything else: user moved on (Cancel/Refresh) → discard.
      if (hubStateRef.current === 'researching') {
        if (scrapeInFlightRef.current || resolveDrainInFlightRef.current) {
          const status = queueSourceResolve({ sourceId: resolvedSourceId, inlineItems, category, warning: resolvedWarning, noChallengeConfirmed });
          const stage = resolveDrainInFlightRef.current ? 'active resolve drain' : 'scrape completion';
          EventLogger.log(
            status === 'active'
              ? `[SellHub][${id}] coalesced ${resolvedSourceId} resolve — that source retry is already active`
              : `[SellHub][${id}] ${status === 'replaced' ? 'updated queued' : 'queued'} ${resolvedSourceId} resolve for ${stage}`,
          );
        } else {
          EventLogger.log(`[SellHub][${id}] discarding late ${resolvedSourceId} resolve — pricing already started from the finalized comp snapshot`);
        }
        return;
      }
      if (hubStateRef.current !== 'comps-ready') {
        EventLogger.log(`[SellHub][${id}] hubState=${hubStateRef.current} — discarding ${resolvedSourceId} resolve`);
        return;
      }

      const queueStatus = queueSourceResolve({ sourceId: resolvedSourceId, inlineItems, category, warning: resolvedWarning, noChallengeConfirmed });
      if (resolveDrainInFlightRef.current) {
        EventLogger.log(
          queueStatus === 'active'
            ? `[SellHub][${id}] coalesced ${resolvedSourceId} resolve — that source retry is already active`
            : `[SellHub][${id}] ${queueStatus === 'replaced' ? 'updated queued' : 'queued'} ${resolvedSourceId} resolve for active resolve drain`,
        );
        return;
      }

      hubStateRef.current = 'researching';
      updateGlobal(id, { hubState: 'researching' });
      addToast({
        title: 'Captcha cleared',
        description: isBundle
          ? `Refetching resolved sources for ${researchItems.length} items — other source results are preserved.`
          : (inlineItems
              ? `${resolvedSourceId} pulled ${inlineItems.length} item(s) inline — other sources keep their results.`
              : `Refetching ${resolvedSourceId} (cookies are fresh) — other sources keep their results.`),
        type: 'success',
      });

      const cancelled = epoch.start();
      let drained;
      try {
        drained = await drainQueuedResolves(
          pendingItemsRef.current || [],
          researchItems,
          scrapeWarningsRef.current || [],
          cancelled,
        );
      } catch (err) {
        if (isNodeDeletedAbort(err)) return;
        EventLogger.error(`[SellHub][${id}] resolve/rescrape ${resolvedSourceId} failed:`, err);
        hubStateRef.current = 'comps-ready';
        updateGlobal(id, { hubState: 'comps-ready' });
        addToast({ title: 'Rescrape failed', description: err?.message || String(err), type: 'error' });
        return;
      }
      if (drained.cancelled || cancelled()) return;

      const mergedItems = drained.items;
      const remainingWarnings = drained.warnings;
      pendingItemsRef.current = mergedItems;
      scrapeWarningsRef.current = remainingWarnings;
      if (remainingWarnings.length > 0) {
        hubStateRef.current = 'comps-ready';
        updateGlobal(id, { hubState: 'comps-ready', pendingItems: mergedItems, scrapeWarnings: remainingWarnings });
        EventLogger.log(`[SellHub][${id}] resolved-source drain complete; ${remainingWarnings.length} blocked source(s) remaining`);
        addToast({
          title: 'Sources still blocked',
          description: `${remainingWarnings.length} source(s) remain blocked. Retry as many times as needed, or explicitly click Skip.`,
          type: 'warning',
        });
        return;
      }

      // Last blocker cleared AND still paused → auto-fire synthesis.
      if (remainingWarnings.length === 0) {
        if (processingPriceRef.current) return;
        processingPriceRef.current = true;
        try {
          await queueSynthesizeAndPrice(mergedItems, skippedWarningsRef.current, cancelled);
          updateGlobal(id, { pendingItems: null });
        } catch (err) {
          // acquireModuleRun rejects if this queued run is cancelled (reset/
          // delete) before it dequeues — an expected outcome, not a failure.
          if (cancelled() || isNodeDeletedAbort(err)) return;
          EventLogger.error(`[SellHub][${id}] Auto-fire synthesis after resolve failed:`, err);
          hubStateRef.current = 'draft';
          updateGlobal(id, { hubState: 'draft', errorMessage: err?.message || String(err), isRateLimit: !!err?.isRateLimit });
          addToast({ title: 'Pricing Error', description: err?.message || String(err), type: 'error' });
        } finally {
          processingPriceRef.current = false;
        }
      }
    };
    document.addEventListener('comp-captcha-resolved', onResolved);
    return () => document.removeEventListener('comp-captcha-resolved', onResolved);
  }, [id, addToast, updateGlobal, epoch, queueSynthesizeAndPrice, drainQueuedResolves, queueSourceResolve]);

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

    if (
      processingRef.current ||
      processingPriceRef.current ||
      (!canReplaceFailedInitialPhotos && (initialDropAcceptedRef.current || dropLockReason))
    ) {
      EventLogger.log(`[SellHub][${id}] Drop rejected: hub already started`);
      addToast({
        title: 'Photos are locked',
        description: hubState === 'priced'
          ? 'Use the photo strip add button to update display-only photos. Product analysis and pricing will stay unchanged.'
          : 'This marketplace module is tied to its analyzed photos. Create a new marketplace module to analyze different photos.',
        type: 'info',
      });
      return;
    }

    initialDropAcceptedRef.current = true;
    EventLogger.log(`[SellHub][${id}] Drop accepted: ${validPaths.length}/${attemptedCount} images`);

    startAnalysisRef.current?.(validPaths);
  }, [addToast, canReplaceFailedInitialPhotos, dropLockReason, hubState, id]);

  // Shared price-drop plan — persisted on the hub and consumed by every
  // marketplace card carrying this hubId backlink. Normalize at this boundary
  // so malformed saved/editor values cannot leak into reminder calculations.
  const handleChangePriceDropPlan = useCallback((updates) => {
    if (data.locked || !updates || typeof updates !== 'object') return;
    const next = {};
    const logBits = [];
    const resnapshotStartingTier = Object.hasOwn(updates, 'startingTier');
    if (Object.hasOwn(updates, 'weeks')) {
      const weeks = normalizePriceDropReminderWeeks(updates.weeks);
      if (normalizePriceDropReminderWeeks(data.priceDropReminderWeeks) !== weeks) {
        next.priceDropReminderWeeks = weeks;
        logBits.push(`interval=${weeks > 0 ? `${weeks}wk` : 'off'}`);
      }
    }
    if (Object.hasOwn(updates, 'mustSellDate')) {
      const mustSellDate = normalizePriceDropMustSellDate(updates.mustSellDate);
      if (normalizePriceDropMustSellDate(data.priceDropMustSellDate) !== mustSellDate) {
        next.priceDropMustSellDate = mustSellDate;
        logBits.push(`mustSell=${mustSellDate || 'off'}`);
      }
    }
    if (Object.hasOwn(updates, 'targetPrice')) {
      // Empty input clears the target → generic cadence reminders, no suggested
      // price. A non-empty value must be non-negative currency to take effect.
      const cleared = updates.targetPrice == null || String(updates.targetPrice).trim() === '';
      const targetPrice = cleared ? null : normalizePriceDropTargetPrice(updates.targetPrice);
      if (!cleared && targetPrice == null) {
        // malformed → ignore, leaving the persisted value untouched
      } else if (normalizePriceDropTargetPrice(data.priceDropTargetPrice) !== targetPrice) {
        next.priceDropTargetPrice = targetPrice ?? undefined;
        logBits.push(`target=${targetPrice == null ? 'off' : formatPriceDropLogPrice(targetPrice)}`);
      }
    }
    if (Object.hasOwn(updates, 'startingTier')) {
      const startingTier = normalizePriceDropStartingTier(updates.startingTier);
      if (normalizePriceDropStartingTier(data.priceDropStartingTier) !== startingTier) {
        next.priceDropStartingTier = startingTier;
        logBits.push(`tier=${startingTier}`);
      }
    }
    if (Object.keys(next).length > 0 || resnapshotStartingTier) {
      // Snapshot the selected tier as the calculation's starting value. Timing
      // remains anchored to the oldest connected listing card.
      const selectedTier = next.priceDropStartingTier
        ?? normalizePriceDropStartingTier(data.priceDropStartingTier);
      const startingPrice = priceDropStartingPrice(selectListingPriceTiers({
        pricing: data.pricing,
        itemPricings: data.itemPricings,
        bundlePricing: data.bundlePricing,
        bundleTotal: data.bundleTotal,
      }), selectedTier);
      if (startingPrice != null) next.priceDropPlanStartingPrice = startingPrice;
      // Remove obsolete fields from earlier plan implementations: the plan-start
      // timeline and the old percentage-based deadline target (now an absolute
      // priceDropTargetPrice). Undefined is omitted from persisted JSON.
      next.priceDropPlanStartedAt = undefined;
      if (data.priceDropTargetPercent !== undefined) next.priceDropTargetPercent = undefined;
      updateGlobal(id, next);
      if (logBits.length > 0) {
        EventLogger.log(`[SellHub][${id}] Price-drop plan updated: ${logBits.join(', ')}`);
      }
    }
  }, [
    data.locked,
    data.priceDropMustSellDate,
    data.priceDropReminderWeeks,
    data.priceDropStartingTier,
    data.priceDropTargetPrice,
    data.priceDropTargetPercent,
    data.pricing,
    data.itemPricings,
    data.bundlePricing,
    data.bundleTotal,
    id,
    updateGlobal,
  ]);

  // Reactive count of OTHER item cards on THIS canvas level eligible to receive
  // an "apply to all". `s.nodes` is the active canvas only — sub-canvas children
  // live in their group's canvasData and parent levels in the nav stack, so this
  // is naturally scoped to "current canvas in the hierarchy". Skips locked hubs
  // (their plan UI is read-only) and cards opted out via the exclude toggle.
  const applyPlanTargetCount = useStore(
    useCallback((s) => s.nodes.filter(n => (
      n.type === 'sellhub'
      && n.id !== id
      && n.data?.hubState === 'priced'
      && !n.data?.locked
      && !n.data?.priceDropApplyAllExcluded
    )).length, [id])
  );

  // Broadcast this hub's price-drop plan to every eligible sibling item card on
  // the current canvas. Cadence / must-sell date / target / starting tier are
  // shared; each target's dollar starting value is recomputed from its OWN tiers
  // so a $20 item and a $700 item both anchor correctly on the shared tier.
  const handleApplyPriceDropPlanToAll = useCallback(() => {
    if (data.locked) return;
    const weeks = normalizePriceDropReminderWeeks(data.priceDropReminderWeeks);
    const mustSellDate = normalizePriceDropMustSellDate(data.priceDropMustSellDate);
    const targetPrice = normalizePriceDropTargetPrice(data.priceDropTargetPrice);
    const startingTier = normalizePriceDropStartingTier(data.priceDropStartingTier);
    // Re-query live at click time (the render-time count can lag a sibling's
    // exclude-toggle change since ReactFlow only re-renders changed nodes).
    const targets = getNodes().filter(n => (
      n.type === 'sellhub'
      && n.id !== id
      && n.data?.hubState === 'priced'
      && !n.data?.locked
      && !n.data?.priceDropApplyAllExcluded
    ));
    if (targets.length === 0) {
      addToast?.({ title: 'No other item cards to apply to', description: 'Only priced, non-excluded items on this canvas are updated.', type: 'info' });
      return;
    }
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    for (const target of targets) {
      // Per-item starting value from the target's own tiers on the shared tier.
      // Mirrors handleChangePriceDropPlan's snapshot step. Cleared (undefined)
      // when the target has no usable price so its card recomputes from the new
      // tier instead of keeping a stale value from its previous tier.
      const startingPrice = priceDropStartingPrice(selectListingPriceTiers({
        pricing: target.data?.pricing,
        itemPricings: target.data?.itemPricings,
        bundlePricing: target.data?.bundlePricing,
        bundleTotal: target.data?.bundleTotal,
      }), startingTier);
      updateGlobal(target.id, {
        priceDropReminderWeeks: weeks,
        priceDropMustSellDate: mustSellDate,
        priceDropTargetPrice: targetPrice ?? undefined,
        priceDropStartingTier: startingTier,
        priceDropPlanStartingPrice: startingPrice ?? undefined,
        // Drop obsolete fields the same way the per-hub editor does.
        priceDropPlanStartedAt: undefined,
        priceDropTargetPercent: undefined,
      });
    }
    addToast?.({ title: `Applied to ${targets.length} item${targets.length === 1 ? '' : 's'}`, description: 'Price-drop plan copied to the other items on this canvas.', type: 'success' });
  }, [
    data.locked,
    data.priceDropReminderWeeks,
    data.priceDropMustSellDate,
    data.priceDropTargetPrice,
    data.priceDropStartingTier,
    id, getNodes, updateGlobal, addToast,
  ]);

  // Per-card opt-out: when on, no sibling's "apply to all" overwrites this card's
  // price-drop plan. Independent of this card's own ability to be a source.
  const handleToggleApplyAllExcluded = useCallback(() => {
    if (data.locked) return;
    updateGlobal(id, { priceDropApplyAllExcluded: !data.priceDropApplyAllExcluded });
  }, [data.locked, data.priceDropApplyAllExcluded, id, updateGlobal]);

  const handleRemoveDisplayPhoto = useCallback((index) => {
    if (data.locked) return;
    const before = data.imagePaths || [];
    const next = removePhotoPathAt(before, index);
    if (next.length === before.length) return;
    EventLogger.log(`[SellHub][${id}] Display photo removed at index ${index}; analysis/pricing retained`);
    updateGlobal(id, { imagePaths: next });
  }, [data.imagePaths, data.locked, id, updateGlobal]);

  const handleAddDisplayPhotos = useCallback((paths) => {
    if (data.locked) return;
    const before = data.imagePaths || [];
    const normalizedBefore = normalizePhotoPathList(before);
    const next = appendPhotoPaths(before, paths);
    const added = next.length - normalizedBefore.length;
    if (added <= 0) return;
    EventLogger.log(`[SellHub][${id}] Added ${added} display photo(s); analysis/pricing retained`);
    updateGlobal(id, { imagePaths: next });
    addToast({
      title: 'Display photos updated',
      description: 'These photos are for reference only; product analysis and pricing were not rerun.',
      type: 'success',
    });
  }, [addToast, data.imagePaths, data.locked, id, updateGlobal]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (data.locked) return; // Locked nodes don't accept new drops
    if (platformsVerifying) return;

    const files = Array.from(e.dataTransfer?.files || []);
    // Log EVERY drop attempt up front (extensions + total count) so bug reports
    // can distinguish "drop never fired" from "drop fired but every file was
    // rejected by the regex" — the previous code only logged on success.
    const exts = summarizeFileExtensions(files);
    EventLogger.log(`[SellHub][${id}] Drop attempt: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}]`);

    const imagePaths = filesToProductImagePaths(files);
    if (displayPhotoDropMode) {
      handleAddDisplayPhotos(imagePaths);
      return;
    }
    if (inputDropsBlocked) return;
    acceptImagePaths(imagePaths, files.length);
  }, [acceptImagePaths, data.locked, displayPhotoDropMode, handleAddDisplayPhotos, id, inputDropsBlocked, platformsVerifying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      if (data.locked) return;
      if (platformsVerifying) return;
      const files = e.detail?.files || [];
      const imagePaths = filesToProductImagePaths(files);
      EventLogger.log(`[SellHub][${id}] Document-node drop received: ${files.length} file(s), acceptedImages=${imagePaths.length}, mode=${e.detail?.mode || 'initial-input'}, hubState=${hubState}`);
      if (e.detail?.mode === 'display-photos' || hubState === 'priced') {
        handleAddDisplayPhotos(imagePaths);
        return;
      }
      if (inputDropsBlocked) return;
      acceptImagePaths(imagePaths, files.length);
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [acceptImagePaths, data.locked, handleAddDisplayPhotos, hubState, id, inputDropsBlocked, platformsVerifying]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    EventLogger.log(`[SellHub][${id}] reset from hubState=${hubState}`);

    // Bump epoch BEFORE anything else so any in-flight startAnalysis /
    // handleConfirmDraft promise settling after this point sees the mismatch
    // and skips its state update. This is what stops the "Window closed"
    // message from clobbering the revert a few seconds later.
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id);

    // Actually cancel the backend pipeline. The IPC is fire-and-forget; the
    // backend's finally{} clears its own progress. We don't await it. The cause
    // is named so diagnostics report a Reset as a Reset — every node-scoped
    // abort otherwise shares the "Node deleted" sentinel.
    window.electronAPI?.cancelNodeTask?.(id, 'user-reset');

    // Revert intelligently: when aborting price research the user wants to
    // keep their draft (title/description/condition they already approved),
    // not start over from the drop zone. Only the analyzing step has no
    // product yet, so that one goes all the way back to 'empty'.
    const revertTo = (hubState === 'researching' || hubState === 'comps-ready') && data.product ? 'draft' : 'empty';

    // Reverting to 'empty' while photos are already attached (cancelling the
    // ANALYZING step, before a product exists) used to null out imagePaths so
    // the auto-start effect wouldn't immediately re-fire startAnalysis on the
    // next render. That wiped the user's dropped photos outright — cancelling
    // an auto-resumed analysis (e.g. after quitting mid-run and reopening)
    // lost the whole item hub, not just the in-flight call. Instead, keep the
    // photos and set a cancellation errorMessage: the auto-start effect
    // already skips while errorMessage is set, and
    // canSellHubReplaceFailedInitialPhotos already treats hubState:'empty' +
    // errorMessage + no product as "Try Again or drop new photos to replace"
    // — the same recovery path a failed analysis already gets.
    const hadImages = revertTo === 'empty' && data.imagePaths?.length > 0;
    const updates = {
      hubState: revertTo,
      queuedModuleRun: null,
      errorMessage: hadImages ? 'Analysis canceled.' : null,
      isRateLimit: false,
      pendingItems: null,
      bundlePricing: null,
    };
    if (revertTo === 'empty' && !hadImages) updates.imagePaths = null;
    updateGlobal(id, updates);
    resetCompProgress();
    cleanupCompSourceCards();
    // Drop queued early-resolves — they belong to the cancelled run and
    // would otherwise leak into the next scrape's drain pass.
    pendingMergesRef.current.splice(0);
    activeResolveSourceIdsRef.current.clear();
    syncResolveWorkCount();   // -> count 0 + broadcast empty snapshot so queued cards un-grey on reset
    setResolveQueueWait(0);
    scrapeInFlightRef.current = false;
    resolveDrainInFlightRef.current = false;
    setIsApplyingResolves(false);
    processingRef.current = false;
    processingPriceRef.current = false;
  }, [data.locked, data.product, data.imagePaths, hubState, id, updateGlobal, cleanupCompSourceCards, epoch, resetCompProgress, moduleRunQueue, syncResolveWorkCount]);

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
  const resolveWorkSubline = isApplyingResolves
    ? (queuedResolvesCount > 0
        ? `${queuedResolvesCount} resolved source update${queuedResolvesCount === 1 ? '' : 's'} ${
            resolveQueueWait > 0
              ? `waiting behind ${resolveQueueWait} browser op${resolveQueueWait === 1 ? '' : 's'}`
              : 'in progress'
          }`
        : 'Finishing resolved source updates')
    : null;

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[SellHub][${id}] User clicked Dismiss Error`);
    const updates = { errorMessage: null, isRateLimit: false };
    if (hubState === 'empty' && !data.product) {
      updates.imagePaths = null;
      updates.inputLocked = false;
      initialDropAcceptedRef.current = false;
    }
    updateGlobal(id, updates);
  }, [data.product, hubState, id, updateGlobal]);

  // "Try again" routes to whichever pipeline matches what just failed:
  //  - product present → re-run price research without changing zoom/pan
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

  const retryFailedAvailable = !isOversizedImageError(data.errorMessage) && (
    !!data.product || data.imagePaths?.length > 0
  );

  const handleReresearchFromPriced = useCallback(() => {
    if (data.locked || !data.product) return;

    EventLogger.log(`[SellHub][${id}] Refresh Prices clicked from priced state — returning to draft before re-research`);
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id, 'Price refresh returned to draft');

    const nextExtraItems = recoverRefreshExtraItems(data.product, data.extraItems, data.itemPricings);
    hubStateRef.current = 'draft';
    pendingItemsRef.current = null;
    scrapeWarningsRef.current = [];
    skippedWarningsRef.current = [];
    pendingMergesRef.current.splice(0);
    activeResolveSourceIdsRef.current.clear();
    scrapeInFlightRef.current = false;
    resolveDrainInFlightRef.current = false;
    processingPriceRef.current = false;
    setEditing(null);
    setQueueWait(0);
    syncResolveWorkCount();   // -> count 0 + broadcast empty snapshot so queued cards un-grey on re-research-from-priced
    setResolveQueueWait(0);
    setIsApplyingResolves(false);
    resetCompProgress();
    cleanupCompSourceCards();

    updateGlobal(id, {
      hubState: 'draft',
      queuedModuleRun: null,
      pricing: null,
      comps: null,
      itemPricings: null,
      bundleTotal: null,
      bundlePricing: null,
      pendingItems: null,
      scrapeWarnings: [],
      platformFit: null,
      platformFitPending: false,
      errorMessage: null,
      isRateLimit: false,
      extraItems: nextExtraItems,
    });
  }, [
    data.locked,
    data.product,
    data.extraItems,
    data.itemPricings,
    id,
    epoch,
    moduleRunQueue,
    setEditing,
    resetCompProgress,
    cleanupCompSourceCards,
    updateGlobal,
    syncResolveWorkCount,
  ]);

  const banner = data.errorMessage ? (
    <HubErrorBanner
      errorMessage={data.errorMessage}
      isRateLimit={!!data.isRateLimit}
      locked={!!data.locked}
      onRetry={retryFailedAvailable ? handleRetryFailed : null}
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
      dropsBlocked={hubDropsBlocked}
      verifyProgress={platformsVerifying ? { done: verifyDone, total: verifyTotal } : null}
      dragHover={data.dragHover || null}
    >
        {/* Transient: this hub's price check is queued behind another sell-side
            browser op (serialized to avoid the shared-browser captcha-resolve
            collision). queueWait is driven entirely by backend emits — set on
            queue, cleared on acquire, and force-cleared in the handler's finally
            even on an abort-while-queued — so it can't strand. */}
        {queueWait > 0 && (
          <div className="mx-2 mt-2 px-2.5 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200/90 text-[11px] flex items-center gap-1.5">
            <span className="animate-pulse">⏳</span>
            Waiting behind {queueWait} price check{queueWait === 1 ? '' : 's'} — serializing the shared browser to avoid collisions…
          </div>
        )}
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
        {hubState === 'queued' && (
          <HubBusyState
            theme="amber"
            label="Waiting to run..."
            subline={`${data.queuedModuleRun?.label || 'Marketplace task'} · Position ${data.queuedModuleRun?.position || 1}`}
            onReset={resetHandler}
          />
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
              hubId={id}
              product={product}
              editing={editing}
              setEditing={setEditing}
              handleFieldEdit={handleFieldEdit}
              handleConfirmDraft={handleConfirmDraft}
              pricingNotes={data.pricingNotes || ''}
              onPricingNotesChange={handlePricingNotesChange}
              extraItems={extraItems}
              onAddExtraItem={handleAddExtraItem}
              onEditExtraItem={handleEditExtraItem}
              onRemoveExtraItem={handleRemoveExtraItem}
              locked={!!data.locked}
              imagePaths={data.imagePaths || []}
            />
          </>
        )}

        {/* ── Researching ────────────────────────────────────────────────── */}
        {hubState === 'researching' && (
          <HubBusyState
            theme="amber"
            label={isApplyingResolves ? 'Applying resolved sources...' : 'Researching market prices...'}
            subline={isApplyingResolves
              ? resolveWorkSubline
              : (totalComps > 0 ? `${totalComps} similar listing${totalComps === 1 ? '' : 's'} found` : null)}
            onReset={resetHandler}
          />
        )}

        {/* ── Comps Ready: scrape finished but some sources blocked ─────── */}
        {/* Pauses before AI synthesis so the user can solve captchas (cards
            already show Solve buttons) or skip and price with partial data. */}
        {hubState === 'comps-ready' && (
          <SellHubCompsReadyDecision
            scrapeWarnings={data.scrapeWarnings || []}
            compsTotal={(data.pendingItems || []).reduce((n, it) => n + (it.comps?.sold?.length || 0) + (it.comps?.active?.length || 0), 0)}
            onCancel={resetHandler}
          />
        )}

        {/* ── Priced: price + platform controls ──────────────────────────── */}
        {hubState === 'priced' && (
          <SellHubPricedState
            product={product}
            pricing={data.pricing}
            itemPricings={data.itemPricings || null}
            bundleTotal={data.bundleTotal ?? null}
            bundlePricing={data.bundlePricing || null}
            scrapeWarnings={data.scrapeWarnings || []}
            justificationExpanded={justificationExpanded}
            toggleJustification={toggleJustification}
            locked={!!data.locked}
            imagePaths={data.imagePaths || []}
            editablePhotos={!data.locked}
            onRemovePhoto={handleRemoveDisplayPhoto}
            onAddPhotos={handleAddDisplayPhotos}
            onReresearch={handleReresearchFromPriced}
            spawnedMarketplaceIds={spawnedMarketplaceIds}
            onSpawnMarketplaceCard={handleSpawnMarketplaceCard}
            platformFit={data.platformFit || null}
            platformFitPending={!!data.platformFitPending}
            priceDropPlan={{
              weeks: normalizePriceDropReminderWeeks(data.priceDropReminderWeeks),
              mustSellDate: normalizePriceDropMustSellDate(data.priceDropMustSellDate),
              targetPrice: normalizePriceDropTargetPrice(data.priceDropTargetPrice),
              scheduleStartedAt: priceDropScheduleStartedAt,
              startingPrice: normalizePriceDropStartingPrice(data.priceDropPlanStartingPrice),
              startingTier: normalizePriceDropStartingTier(data.priceDropStartingTier),
            }}
            onChangePriceDropPlan={handleChangePriceDropPlan}
            applyPlanTargetCount={applyPlanTargetCount}
            onApplyPriceDropPlanToAll={handleApplyPriceDropPlanToAll}
            priceDropApplyAllExcluded={!!data.priceDropApplyAllExcluded}
            onToggleApplyAllExcluded={handleToggleApplyAllExcluded}
          />
        )}
      </HubContainer>
  );
});
