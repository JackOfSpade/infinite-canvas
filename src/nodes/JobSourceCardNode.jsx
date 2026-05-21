import React, { useEffect, useState, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Loader2, CheckCircle2, Filter, ShieldAlert, ExternalLink, SkipForward } from 'lucide-react';
import { PlatformBadge } from '../components/PlatformBadge';
import { NodeHandles } from './_shared/NodeHandles';
import { mergeSourceProgress } from './_shared/sourceProgress';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';

/**
 * JobSourceCardNode — persistent canvas node representing one job source
 * (LinkedIn, Indeed, Greenhouse, etc.) that a JobHubNode searches against.
 *
 * Replaces the orbital ring of source icons. Each card is a real ReactFlow
 * node connected to its hub by a native edge, leaving room for per-platform
 * features to grow on each card later (login state, custom filters, etc.).
 *
 * Lifecycle:
 *   - Spawned by the owning JobHubNode the first time its pipeline runs.
 *   - Reused across re-runs — the hub looks up existing cards by hubId+sourceId
 *     before deciding what to spawn.
 *   - Subscribes to `job-source-progress` events filtered by its sourceId.
 *   - Falls back to the hub's `data.finalSourceCounts` between runs so the
 *     last-known count is still visible after Electron restart.
 *   - Clicking the card dispatches `job-source-filter-toggle` so the hub can
 *     toggle its source filter (the same UX the old ring icons offered).
 *
 * data shape:
 *   {
 *     sourceId, name, letter, color,  // JOB_SOURCES entry
 *     hubId,                          // owning JobHubNode id (multi-hub safety)
 *   }
 */
export function JobSourceCardNode({ id, data }) {
  const { getNode, deleteElements, updateNodeData } = useReactFlow();
  // Same nav context the owning JobHub reads currentFile from — needed so a
  // captcha-resolve can history-dedup against this project's jobs-history CSV
  // (mirrors the headless search path), instead of re-surfacing already-seen
  // jobs every time the user re-solves a source.
  const nav = useContext(CanvasNavigationContext);
  const [progress, setProgress] = useState(data.persistedProgress || null); // { status, count, warning, url } | null
  const [resolving, setResolving] = useState(false);
  // Local-only dismiss: clicking Skip on a warned card just hides the
  // Solve/Skip + warning text on this card. Doesn't touch hub state — the
  // next Re-run Search will refetch this source fresh and re-emit progress.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onJobSourceProgress) return;
    const cleanup = window.electronAPI.onJobSourceProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      if (payload?.sourceId !== data.sourceId) return;
      // Carry warning + url forward across events — see mergeSourceProgress.
      // Reset the local dismiss flag on every fresh event so a new run
      // un-hides any previously-dismissed warning.
      setProgress(prev => mergeSourceProgress(prev, payload));
      setDismissed(false);
    });
    return () => cleanup?.();
  }, [data.hubId, data.sourceId]);

  // Mirror progress into node data ONLY on terminal states (done / error / skipped).
  // The sanitizer keeps job-source cards only when persistedProgress carries
  // a warning or error, so writing intermediate 'searching' states is wasted
  // — and worse, it dirties the workspace on every progress event during a
  // scrape (~7 sources × multiple updates = constant auto-save churn).
  useEffect(() => {
    if (!progress) return;
    if (progress.status !== 'done' && progress.status !== 'error' && progress.status !== 'skipped') return;
    updateNodeData(id, { persistedProgress: progress });
  }, [progress, id, updateNodeData]);

  // Auto-dismiss clean-success cards after 3s — mirrors the
  // CompSourceCardNode UX from marketplace so the canvas stays uncluttered
  // once a source has reported its result. Blocked/errored/throttled cards
  // stay visible indefinitely so the user can Solve or Skip.
  // ensureSourceCards on the owning JobHub will respawn this card on the
  // next pipeline run, restoring it to the default circular layout slot.
  useEffect(() => {
    // Auto-dismiss terminal cards that need no further action: a clean success
    // OR a skip. 'skipped' was missing here — so a skipped card lingered on the
    // canvas forever (the Skip button sets status:'skipped'+warning:null, and
    // unlike marketplace — whose hub deletes the card on skip — nothing here
    // removed the node). Warned/errored/blocked cards (incl. an info "skipped"
    // like config-missing, which carries a warning) still stay so the user can
    // Solve, Skip, or read the reason. ensureSourceCards respawns on the next run.
    const isCleanTerminal = (progress?.status === 'done' || progress?.status === 'skipped') && !progress.warning;
    if (!isCleanTerminal) return;
    const timeout = setTimeout(() => {
      deleteElements({ nodes: [{ id }] });
    }, 3000);
    return () => clearTimeout(timeout);
  }, [progress?.status, progress?.warning, id, deleteElements]);

  const handleSolve = async () => {
    if (resolving || hubLocked || !progress?.url || !window.electronAPI?.resolveJobSource) return;
    setResolving(true);
    try {
      const result = await window.electronAPI.resolveJobSource({
        url: progress.url,
        sourceId: data.sourceId,
        nodeId: data.hubId,
        // Let the resolve handler apply the same age + history dedup the
        // headless search does, so re-solving doesn't re-surface already-seen
        // jobs. maxAgeDays lives on the owning hub's data.
        canvasFilePath: nav?.currentFile || null,
        maxAgeDays: getNode(data.hubId)?.data?.maxAgeDays || 21,
      });
      // When the captcha-resolve window auto-detects the challenge as
      // cleared, the visible browser session that just bypassed the bot
      // wall also runs the extractor in-page — so any jobs the user
      // unlocked come back here as `items`. Hand them to the hub so they
      // merge into pendingJobs and the warning drops in one shot. Without
      // the inline items, the original headless scrape's 0-job result
      // from this source would persist even after a successful solve.
      if (result?.resolved) {
        const items = Array.isArray(result?.items) ? result.items : [];
        setDismissed(true);
        // Clear the warning AND bump the count on the card's local
        // progress state so the status line flips from "captcha-presented"
        // back to "{count} jobs" with the green checkmark. Without this,
        // dismissed only hides the inline warning panel — the small status
        // line still reads the warning code, making it look like the
        // resolve didn't take effect even though it fully did.
        // The 3-second auto-dismiss effect on clean-done cards then kicks
        // in, removing the card entirely (matching the post-search UX for
        // sources that finished cleanly the first time).
        setProgress(prev => prev ? {
          ...prev,
          warning: null,
          count: (prev.count || 0) + items.length,
        } : prev);
        document.dispatchEvent(new CustomEvent('job-source-resolved', {
          detail: {
            hubId: data.hubId,
            sourceId: data.sourceId,
            items,
          },
        }));
      }
    } finally {
      setResolving(false);
    }
  };

  // Hub state is read fresh on every render so changes (filter, finalCounts,
  // hubState) flow through without a separate subscription on this card.
  const hub = getNode(data.hubId);
  const hubData = hub?.data || {};
  const isFiltered = hubData.sourceFilter === data.sourceId;
  const hubBusy = ['parsing', 'querying', 'searching', 'scoring'].includes(hubData.hubState);
  // Hub-cascading lock: when the owning JobHub is locked, the source card's
  // interactive controls (filter toggle, Solve, Skip) become no-ops. The
  // card itself stays visible and informational.
  const hubLocked = !!hubData.locked;
  const fallbackCount = hubData.finalSourceCounts?.[data.sourceId];

  // Pick what to display. Live progress wins; otherwise show the last-known
  // count from the most recent completed run, otherwise neutral idle.
  let status;
  let count;
  if (progress) {
    status = progress.status;
    count  = progress.count;
  } else if (fallbackCount != null) {
    status = 'done';
    count  = fallbackCount;
  } else {
    status = hubBusy ? 'searching' : 'idle';
    count  = undefined;
  }

  const warning = progress?.warning;
  const isSearching = status === 'searching';
  const isDone      = status === 'done';
  const isError     = status === 'error';
  const isSkipped   = status === 'skipped';
  const hasBlock    = warning?.severity === 'block';
  const hasThrottle = warning?.severity === 'throttle';
  const hasInfo     = warning?.severity === 'info';

  const statusLine = isError
    ? 'Failed'
    : isSkipped
      ? 'Skipped'
      : isDone
        ? `${count ?? 0} jobs`
        : isSearching
          ? 'Searching…'
          : 'Idle';

  // Red for hard failures, amber for throttles/skips (action available),
  // platform color for healthy runs.
  const accentColor = (isError || hasBlock)
    ? '#ef4444'
    : (hasThrottle || hasInfo || isSkipped)
      ? '#f59e0b'
      : data.color;

  const handleClick = (e) => {
    e.stopPropagation();
    if (hubLocked) return;
    document.dispatchEvent(new CustomEvent('job-source-filter-toggle', {
      detail: { hubId: data.hubId, sourceId: data.sourceId },
    }));
  };

  return (
    // Outer wrapper is draggable: no `nodrag`, no pointer-down stopPropagation.
    // ReactFlow distinguishes click from drag by movement, so the whole-card
    // `onClick` filter toggle still fires on stationary clicks while the card
    // can also be dragged. Matches MarketplaceCardNode / CompSourceCardNode.
    <div
      onClick={handleClick}
      className={`w-[140px] rounded-xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden transition-all ${
        hubLocked ? 'cursor-default' : 'cursor-pointer hover:brightness-110'
      } ${isFiltered ? 'ring-2 ring-offset-1 ring-offset-black' : ''}`}
      style={{
        borderColor: `${accentColor}55`,
        ...(isFiltered ? { '--tw-ring-color': accentColor } : {}),
      }}
      title={hubLocked
        ? 'Hub is locked'
        : `Click to ${isFiltered ? 'show all sources' : `filter to ${data.name} only`}`}
    >
      <NodeHandles className="!w-2 !h-2 !bg-white/30 !border-white/10" />

      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <PlatformBadge
          name={data.name}
          letter={data.letter}
          color={accentColor}
          domain={data.domain}
          size={24}
        />
        <div className="flex-1 min-w-0">
          <div className="text-white text-[11px] font-semibold truncate flex items-center gap-1">
            {data.name}
            {isFiltered && <Filter size={8} className="text-white/60 shrink-0" />}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            {isSearching && <Loader2 size={9} className="text-white/40 animate-spin shrink-0" />}
            {isDone && !warning && <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />}
            {(isError || hasBlock) && <ShieldAlert size={9} className="text-red-400 shrink-0" />}
            {(hasThrottle || hasInfo || isSkipped) && !hasBlock && <ShieldAlert size={9} className="text-amber-400 shrink-0" />}
            <span
              className="text-[9px] truncate"
              style={{ color: (isError || hasBlock) ? '#fca5a5' : (hasThrottle || hasInfo || isSkipped) ? '#fcd34d' : isDone ? '#a7f3d0' : 'rgba(255,255,255,0.45)' }}
            >
              {warning ? warning.code : statusLine}
            </span>
          </div>
        </div>
      </div>
      {/* Embedded warning text — selectable so the user can copy/paste the
          full evidence + suggestion back into a bug report or chat. */}
      {warning && !dismissed && (
        <div
          className="px-2.5 pb-1.5 pt-1 text-[9px] leading-snug select-text cursor-text"
          style={{ color: hasBlock ? '#fca5a5' : '#fcd34d', borderTop: `1px solid ${hasBlock ? '#ef444433' : '#f59e0b33'}` }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          title="Copy this — paste back to debug"
        >
          {warning.evidence && <div className="font-mono break-words">{warning.evidence}</div>}
          {warning.suggestion && <div className="mt-0.5 opacity-80 break-words">{warning.suggestion}</div>}
        </div>
      )}
      {/* Solve / Skip row — same pattern as CompSourceCardNode for marketplace.
          Solve only appears when we have a failed URL to open (browser-pool
          sources). For config-missing (USAJobs no API key) the suggestion text
          above already directs the user to set the env var — no Solve button. */}
      {warning && !dismissed && (
        <div className="flex border-t border-white/10">
          {progress?.url && !hasInfo && (
            <button
              onClick={(e) => { e.stopPropagation(); handleSolve(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={resolving || hubLocked}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default border-r border-white/10"
              title={hubLocked
                ? 'Hub is locked'
                : 'Open the failed page in a browser sharing your session — solve the captcha or log in, cookies persist for the next Re-run Search'}
            >
              <ExternalLink size={9} />
              {resolving ? 'Window open…' : 'Solve'}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hubLocked) return;
              setDismissed(true);
              setProgress(prev => prev ? {
                ...prev,
                status: 'skipped',
                warning: null,
              } : { status: 'skipped', count: 0, warning: null });
              // Notify the owning hub so it can drop this source's warning
              // from data.scrapeWarnings. When the hub is paused in the
              // 'sources-ready' state and this is the last block, it
              // auto-resumes scoring. Identified-by hubId so multi-hub
              // canvases don't cross-trigger.
              document.dispatchEvent(new CustomEvent('job-source-skip', {
                detail: { hubId: data.hubId, sourceId: data.sourceId },
              }));
            }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={hubLocked}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default"
            title={hubLocked ? 'Hub is locked' : "Skip this source — drops the warning. The hub resumes scoring once every blocked source is resolved or skipped."}
          >
            <SkipForward size={9} />
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
