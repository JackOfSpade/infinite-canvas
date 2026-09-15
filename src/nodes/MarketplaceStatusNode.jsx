import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { Radar, RefreshCw, Settings as SettingsIcon, CheckCircle2, AlertCircle, LogIn, Circle } from 'lucide-react';
import { SELL_PLATFORMS } from '../utils/constants';
import { PlatformBadge } from '../components/PlatformBadge';
import { AttentionPanels } from '../components/AttentionPanels';
import { getMarketplaceHubStatusLabel } from '../components/monitorStatusLabels';
import { useToast } from '../components/ToastProvider';
import { collectMarketplaceListings, marketplaceListingsSignature } from '../utils/marketplaceStatusScan';
import {
  bestMarketplaceStatusColumnCount,
  MARKETPLACE_STATUS_GRID as GRID,
  marketplaceStatusNodeWidth,
} from '../utils/marketplaceStatusLayout';
import { normalizeMarketplaceWatchUrls } from '../utils/marketplaceWatchUrls';
import {
  beginMarketplaceStatusRun,
  completeMarketplaceStatusPlatform,
  finishMarketplaceStatusRun,
  getMarketplaceStatusActiveRuns,
  marketplaceStatusCheckingIds,
  mergeMarketplaceStatusResults,
  publishMarketplaceStatusCheckingIds,
  subscribeMarketplaceStatusCheckingIds,
} from '../utils/marketplaceStatusProgress';
import { generateId } from '../utils/idGenerator';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';

/**
 * MarketplaceStatusNode — the Marketplace Status Module.
 *
 * Drop it on any canvas. It auto-detects every marketplace listing card
 * (`marketplacecard`) spawned by the Price Check Modules on that canvas AND in
 * its nested sub-canvases, and shows which platforms you're listed on. Pressing
 * "Check All" scrapes only the per-platform watch URLs configured in Settings
 * (each marketplace's own notification hub / seller dashboard) and runs a single
 * non-listing-specific AI scan per platform for anything that needs action —
 * instead of checking each listing one-by-one (slow + token-heavy at scale).
 *
 * Only platforms that have BOTH a listing on this canvas AND a watch URL in
 * Settings are checked; detected platforms missing a watch URL show a hint.
 *
 * data shape:
 *   { platformStatus?: { [platformId]: { status, message, summary, attention[], sources[], lastChecked } } }
 */

// The layout helper chooses a fixed-width grid closest to 16:9. We feed it each
// card's measured collapsed height so opening an attention lane never reflows
// the node.
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const STATUS_PILL = {
  ok:            { icon: CheckCircle2, cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' },
  'needs-login': { icon: LogIn,        cls: 'text-yellow-300 bg-yellow-500/15 border-yellow-500/30' },
  error:         { icon: AlertCircle,  cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
  unknown:       { icon: Circle,       cls: 'text-white/40 bg-white/5 border-white/10' },
};

function StatusPill({ result, checking }) {
  if (checking) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium border text-sky-300 bg-sky-500/15 border-sky-500/30">
        <RefreshCw size={9} className="animate-spin" /> Checking…
      </span>
    );
  }
  // No 'attention' escalation: a checked platform reads "Checked" even when it
  // surfaced FYI/Info items. Action-needed items announce themselves via the red
  // "Action Needed" lane (AttentionPanels), so a header pill would be redundant
  // when right — and it was wrong here, lighting up on low-urgency Info alone.
  const key = result?.status || 'unknown';
  const meta = STATUS_PILL[key] || STATUS_PILL.unknown;
  const Icon = meta.icon;
  return (
    <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium border ${meta.cls}`}>
      <Icon size={9} /> {getMarketplaceHubStatusLabel(key, result?.lastChecked)}
    </span>
  );
}

export const MarketplaceStatusNode = React.memo(function MarketplaceStatusNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const navigation = useContext(CanvasNavigationContext);
  const updateGlobal = navigation?.updateNodeDataGlobally || updateNodeData;
  const { addToast } = useToast();
  const isMountedRef = useIsMountedRef();
  const [watchUrlsByPlatform, setWatchUrlsByPlatform] = useState(null); // null = not yet loaded
  // Platform ids with an in-flight hub scan. A Set (not a bool) so an individual
  // platform check spins only its own row while the others stay interactive.
  const activeCheckRuns = useMemo(() => getMarketplaceStatusActiveRuns(id), [id]);
  const [checkingIds, setCheckingIds] = useState(() => marketplaceStatusCheckingIds(activeCheckRuns));
  const checkingIdsRef = useRef(checkingIds);

  // Collect the marketplace listings across this canvas + its sub-canvases. The
  // signature-based equality makes this re-render only when the listing set
  // actually changes — drags (which churn the store) don't trigger a rebuild.
  const listingsByPlatform = useStore(
    (s) => collectMarketplaceListings(s.nodes),
    (a, b) => marketplaceListingsSignature(a) === marketplaceListingsSignature(b),
  );

  // Load per-platform watch URLs from Settings, and keep them fresh when the
  // user edits them (Settings → Marketplace Monitors broadcasts settings-changed).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electronAPI?.getSettings?.()
        .then((store) => { if (!cancelled) setWatchUrlsByPlatform(store?.marketplaceWatchUrls || {}); })
        .catch(() => { if (!cancelled) setWatchUrlsByPlatform({}); });
    };
    load();
    const cleanup = window.electronAPI?.onSettingsChanged?.((payload) => {
      if (payload?.changedSections?.includes('marketplaceWatchUrls')) load();
    });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  const platformStatus = useMemo(() => data.platformStatus || {}, [data.platformStatus]);

  const rows = useMemo(() => {
    return SELL_PLATFORMS
      .filter((p) => listingsByPlatform.has(p.id))
      .map((p) => {
        const listing = listingsByPlatform.get(p.id);
        const watchCount = normalizeMarketplaceWatchUrls((watchUrlsByPlatform || {})[p.id]).length;
        return {
          platform: p,
          listingCount: listing.listingCount,
          watchCount,
          eligible: watchCount > 0,
          result: platformStatus[p.id] || null,
        };
      });
  }, [listingsByPlatform, watchUrlsByPlatform, platformStatus]);

  const eligibleIds = useMemo(() => rows.filter((r) => r.eligible).map((r) => r.platform.id), [rows]);
  const watchLoaded = watchUrlsByPlatform !== null;

  // Active runs live outside this component so navigating away and back while a
  // scan is running restores the correct per-platform spinners and accepts the
  // remaining progress events instead of allowing a duplicate Check All.
  useEffect(() => subscribeMarketplaceStatusCheckingIds(id, (next) => {
    checkingIdsRef.current = next;
    setCheckingIds(next);
  }), [id]);

  const publishCheckingIds = useCallback(() => {
    publishMarketplaceStatusCheckingIds(id);
  }, [id]);

  // The main process scrapes every platform first (browser automation, one at a
  // time, fully unattended), THEN issues every remaining platform's AI handoff
  // together — so a platform's row can sit at "Checking…" for a while after its
  // own scrape finished while OTHER platforms' handoffs get pasted first. Each
  // platform still emits its own progress event the moment its result (scrape-
  // only terminal outcome, or scrape + AI verdict) is final, in whatever order
  // those finish — not necessarily scan order. Patch only that platform and
  // stop only its spinner; the remaining cards continue showing Checking.
  useEffect(() => {
    if (!window.electronAPI?.onMarketplaceStatusProgress) return undefined;
    return window.electronAPI.onMarketplaceStatusProgress((payload) => {
      if (!payload?.result) return;
      const completion = completeMarketplaceStatusPlatform(activeCheckRuns, payload, id);
      if (!completion.accepted) return;
      // updateGlobal also reaches a temporarily hidden/nested node and safely
      // no-ops when the node was actually deleted.
      updateGlobal(id, (node) => ({
        platformStatus: mergeMarketplaceStatusResults(node?.data?.platformStatus, {
          [payload.platformId]: payload.result,
        }),
      }));
      publishCheckingIds();
    });
  }, [id, updateGlobal, activeCheckRuns, publishCheckingIds]);

  // Run a hub scan for a specific set of platform ids — shared by the bulk
  // "Check All" button (all eligible) and each row's own check button (just
  // that one). Per-id tracking lets one row spin without freezing the rest, and
  // the FUNCTIONAL updateNodeData merge means a single-platform result patches
  // only its own key — it never clobbers the others' verdicts, even if two
  // checks overlap.
  //
  // Checks CAN now genuinely overlap: the backend holds the status-check lock
  // only for its scrape pass, then releases it before the AI copy/paste handoff
  // (which waits on a human and is unbounded). So overlap safety rests on two
  // renderer-side guards, not on backend serialization:
  //   1. the `checkingIdsRef` filter below never starts a second run for a
  //      platform this node is already checking, so one platform can never be
  //      in two live runs here; and
  //   2. completeMarketplaceStatusPlatform accepts a progress payload only when
  //      its nodeId AND runId match one of THIS node's active runs, so another
  //      hub's late handoff result can never land on this node's cards.
  const runCheck = useCallback(async (platformIds) => {
    const candidates = Array.isArray(platformIds) ? platformIds : [];
    const ids = [...new Set(candidates)].filter((p) => p && !checkingIdsRef.current.has(p));
    if (ids.length === 0) return;
    const runId = generateId();
    beginMarketplaceStatusRun(activeCheckRuns, runId, ids);
    publishCheckingIds();
    try {
      const res = await window.electronAPI?.checkMarketplaceStatus?.({ platformIds: ids, nodeId: id, runId });
      if (!res || res.success === false) {
        if (isMountedRef.current) {
          addToast({ title: 'Status check failed', description: res?.error || 'The marketplace status check did not complete.', type: 'error' });
        }
        return;
      }
      const results = res.results || {};
      const checkedCount = Object.keys(results).length;
      if (checkedCount === 0) {
        if (isMountedRef.current) {
          addToast({ title: 'Status check failed', description: 'The marketplace status check returned no platform results.', type: 'error' });
        }
        return;
      }
      // Keep results even if this component unmounted because the user
      // navigated into/out of a nested canvas while Check All was running.
      // updateGlobal safely no-ops when the node was actually deleted.
      updateGlobal(id, (node) => ({
        platformStatus: mergeMarketplaceStatusResults(node?.data?.platformStatus, results),
      }));
      if (!isMountedRef.current) return;

      const verdicts = Object.values(results);
      const needsLogin = verdicts.filter((v) => v?.status === 'needs-login').length;
      const failed = verdicts.filter((v) => v?.status === 'error').length;
      const actionItems = verdicts.reduce((n, v) => n + (Array.isArray(v?.attention) ? v.attention.filter((a) => a.urgency === 'high').length : 0), 0);
      const totalItems = verdicts.reduce((n, v) => n + (Array.isArray(v?.attention) ? v.attention.length : 0), 0);
      if (needsLogin > 0 || failed > 0) {
        // A login wall on one platform shouldn't bury action items the scan DID
        // surface on the reachable platforms — fold them into the same toast
        // (one toast beats two stacked ones on a Check All that trips both).
        const alsoFlagged = actionItems > 0
          ? ` Also ${actionItems} high-urgency action item${actionItems === 1 ? '' : 's'} flagged on other platform${actionItems === 1 ? '' : 's'}.`
          : '';
        const loginText = needsLogin > 0
          ? `${needsLogin} platform${needsLogin === 1 ? '' : 's'} need a refreshed login. Open Settings → Marketplace Login.`
          : '';
        const failedText = failed > 0
          ? `${loginText ? ' ' : ''}${failed} platform scan${failed === 1 ? '' : 's'} failed; retry the affected card${failed === 1 ? '' : 's'}.`
          : '';
        addToast({
          title: needsLogin > 0 ? 'Marketplace login needed' : 'Marketplace status incomplete',
          description: `${loginText}${failedText}${alsoFlagged}`,
          type: 'error',
          duration: 7000,
        });
      } else if (totalItems > 0) {
        addToast({ title: 'Marketplace status checked', description: `${actionItems} action item${actionItems === 1 ? '' : 's'} and ${totalItems - actionItems} FYI across ${checkedCount} platform${checkedCount === 1 ? '' : 's'}.`, type: actionItems > 0 ? 'info' : 'success' });
      } else {
        addToast({ title: 'Marketplace status checked', description: `Nothing needs attention across ${checkedCount} platform${checkedCount === 1 ? '' : 's'}.`, type: 'success' });
      }
    } catch (err) {
      if (isMountedRef.current) addToast({ title: 'Status check failed', description: err?.message || String(err), type: 'error' });
    } finally {
      finishMarketplaceStatusRun(activeCheckRuns, runId);
      publishCheckingIds();
    }
  }, [id, updateGlobal, addToast, isMountedRef, activeCheckRuns, publishCheckingIds]);

  const handleCheck = useCallback(() => { runCheck(eligibleIds); }, [runCheck, eligibleIds]);

  const totalListings = rows.reduce((n, r) => n + r.listingCount, 0);

  // Measure the rendered node so the 16:9 fit is based on real heights, not
  // estimates: per-card COLLAPSED heights (grid children, in row order, so
  // children[i] ↔ rows[i], with open lane bodies subtracted) and the overhead
  // (rootHeight − gridHeight = header + button + any hint). A ResizeObserver
  // watches the root (catches the hint appearing) and each card (catches a
  // status check adding summary/lane text); toggling a lane fires the observer
  // too, but the collapsed height is unchanged so the grid doesn't reflow. The layout effect
  // re-subscribes when the platform set changes and measures before paint so
  // there's no reflow flash. offsetHeight is used (not getBoundingClientRect) so
  // the canvas zoom transform doesn't skew the numbers.
  const rootRef = useRef(null);
  const gridRef = useRef(null);
  const [metrics, setMetrics] = useState({ heights: [], overhead: 0 });
  const rowKey = rows.map((r) => r.platform.id).join('|');
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const root = rootRef.current;
    if (!grid || !root) return undefined;
    const measure = () => {
      // Collapsed height per card: subtract any open Action Needed / Info lane
      // body (tagged data-collapsible-body in AttentionPanels) plus its 6px
      // top margin (mt-1.5, which only exists while the body is rendered). The
      // column count then tracks the FULLY-COLLAPSED card, so a user expanding
      // a lane changes the live height but not this metric — no re-layout — and
      // only the collapsed node is fitted to 16:9 (expansions overflow freely).
      const heights = Array.from(grid.children, (el) => {
        let h = el.offsetHeight;
        for (const body of el.querySelectorAll('[data-collapsible-body]')) {
          h -= body.offsetHeight + 6;
        }
        return Math.max(0, h);
      });
      const overhead = root.offsetHeight - grid.offsetHeight;
      setMetrics((prev) =>
        arraysEqual(prev.heights, heights) && prev.overhead === overhead
          ? prev
          : { heights, overhead },
      );
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const child of grid.children) ro.observe(child);
    measure();
    return () => ro.disconnect();
  }, [rowKey]);

  // Arrange the platform cards into a grid whose column count keeps the node
  // closest to 16:9. Recomputes whenever the platform count or a measured height
  // changes; the empty state keeps a fixed compact width.
  const cols = useMemo(
    () => bestMarketplaceStatusColumnCount(rows.length, metrics.heights, metrics.overhead),
    [rows.length, metrics],
  );
  const nodeWidth = rows.length === 0 ? 300 : marketplaceStatusNodeWidth(cols);

  return (
    <div
      ref={rootRef}
      className="rounded-2xl bg-neutral-900/95 border-2 border-sky-500/30 shadow-lg overflow-hidden"
      style={{ width: nodeWidth }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-sky-500/10">
        <Radar size={16} className="text-sky-400/80" />
        <div className="flex-1 min-w-0">
          <div className="text-white text-xs font-semibold truncate">Marketplace Status</div>
          <div className="text-white/40 text-[9px] truncate">
            {totalListings > 0
              ? `${totalListings} listing${totalListings === 1 ? '' : 's'} across ${rows.length} platform${rows.length === 1 ? '' : 's'}`
              : 'Monitors your listings via each site’s hub'}
          </div>
        </div>
      </div>

      <div className="p-3 space-y-2">
        {rows.length === 0 ? (
          <div className="text-white/40 text-[10px] leading-snug px-1 py-3 text-center">
            No marketplace listings found on this canvas.
            <div className="text-white/25 mt-1">
              Add a Price Check Module, price an item, and spawn marketplace listing cards — they’ll show up here.
            </div>
          </div>
        ) : (
          <>
            {/* Check button */}
            <button
              onClick={handleCheck}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={checkingIds.size > 0 || eligibleIds.length === 0}
              className="nodrag w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 text-[11px] font-medium transition-colors border border-sky-500/25 disabled:opacity-40 disabled:cursor-default"
              title={eligibleIds.length === 0
                ? 'No platform on this canvas has a watch URL configured — add one in Settings → Marketplace Monitors'
                : 'Scan every platform’s notification hub at once — or use a card’s ↻ to check just that one'}
            >
              <RefreshCw size={12} className={checkingIds.size > 0 ? 'animate-spin' : ''} />
              {checkingIds.size > 0 ? 'Checking…' : `Check All${eligibleIds.length ? ` (${eligibleIds.length})` : ''}`}
            </button>
            {watchLoaded && eligibleIds.length === 0 && (
              <div className="text-amber-300/80 text-[9px] leading-snug px-1 flex items-start gap-1" style={{ maxWidth: GRID.CARD_W }}>
                <SettingsIcon size={10} className="mt-px shrink-0" />
                None of your listed platforms have a watch URL yet. Add each site’s notification/dashboard URL in Settings → Marketplace Monitors.
              </div>
            )}

            {/* Per-platform cards — grid arranged toward a 16:9 node */}
            <div
              ref={gridRef}
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GRID.GAP,
                alignItems: 'start',
              }}
            >
              {rows.map((row) => (
                <PlatformRow
                  key={row.platform.id}
                  row={row}
                  checking={checkingIds.has(row.platform.id)}
                  onCheck={runCheck}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

function PlatformRow({ row, checking, onCheck }) {
  const { platform, listingCount, watchCount, eligible, result } = row;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5" style={{ background: `${platform.color}10` }}>
        <PlatformBadge name={platform.name} letter={platform.letter} color={platform.color} domain={platform.domain} size={20} />
        <div className="flex-1 min-w-0">
          <div className="text-white/80 text-[11px] font-semibold truncate">{platform.name}</div>
          <div className="text-white/35 text-[9px]">
            {listingCount} listing{listingCount === 1 ? '' : 's'}
            {watchCount > 0 ? ` · ${watchCount} watch URL${watchCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <StatusPill result={result} checking={checking} />
        {eligible && (
          // Check this platform only — the bulk "Check All" is disabled while any
          // scan runs, but each row stays independently re-checkable.
          <button
            onClick={() => onCheck([platform.id])}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={checking}
            title={`Check ${platform.name} only`}
            className="nodrag shrink-0 p-1 rounded-md text-sky-300/70 hover:text-sky-200 hover:bg-sky-500/15 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            <RefreshCw size={11} className={checking ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      <div className="px-2 py-1.5 space-y-1.5">
        {!eligible ? (
          <div className="text-white/40 text-[9px] leading-snug flex items-start gap-1">
            <SettingsIcon size={10} className="mt-px shrink-0 text-white/30" />
            Add a watch URL for {platform.name} in Settings → Marketplace Monitors to monitor it.
          </div>
        ) : result ? (
          <>
            {result.summary && (
              <div className="text-white/55 text-[10px] leading-snug">{result.summary}</div>
            )}
            {result.status !== 'ok' && result.message && (
              <div className="text-white/40 text-[9px] leading-snug">{result.message}</div>
            )}
            <AttentionPanels items={result.attention} />
            {result.lastChecked && (
              <div className="text-white/25 text-[8px] text-right">
                Checked {new Date(result.lastChecked).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            )}
          </>
        ) : (
          <div className="text-white/30 text-[9px] leading-snug">Not checked yet — press Check All, or this card’s ↻.</div>
        )}
      </div>
    </div>
  );
}
